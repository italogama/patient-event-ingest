# Ingest Service

Accepts patient events over HTTP, processes each one asynchronously (~5 s, simulated
external call), and persists the outcome in a single MongoDB collection.

> Draft. This file currently holds the design decisions taken before implementation.
> Setup and verification instructions are added as the code lands.

## From operating conditions to design

| Condition | What it forces |
| --- | --- |
| 1000 events/min, ~5 s each | ~83 events in flight at steady state (Little's law: `16.67/s x 5 s`). The work is waiting on I/O, not CPU, so a single Node process with bounded concurrency covers it; worker replicas exist for backlog headroom and availability during deploys, not for raw throughput. Concurrency must be capped and configurable — an unbounded drain of a backlog would hit the external system with thousands of simultaneous calls. |
| Senders time out, retry, resend | Duplicates are the normal case, not the exception. Identity has to be derived from content, and uniqueness enforced by the database, not by a read-then-write in application code. |
| No ordering guarantee; per-patient state is order-dependent | Arrival order must not influence the result. Ordering is applied by `ts` (clinical time), never by `receivedAt` (our clock). |
| Never silently lost, never counted twice | The event must be durable before the response is sent. Failures are allowed; silent failures are not — every failure reaches a queryable terminal state with attempt count and last error, and the system must be inspectable enough to assert that nothing is missing. |
| Processes are killed mid-work | In-flight work must be recoverable by another process without human intervention. |
| Sender needs an immediate answer | No processing in the request path. `POST /events` validates, persists, returns 202. |

## Decisions

### 1. The MongoDB collection is the queue

Events are claimed straight from the collection with an atomic `findOneAndUpdate`, under a
lease. No broker.

Why: the event and its processing state live in one document, so claiming, retrying and
recording the outcome are single-document atomic operations. Introducing a broker would add
the classic dual-write gap — write to Mongo, fail to publish to the broker, event exists but
is never processed — and solving that properly means an outbox, which is more moving parts
than this volume justifies.

Trade-off accepted: workers poll instead of receiving a push, and the collection carries
index write pressure from the claim loop. At 1000/min both are negligible. This is the
decision to revisit first at ~10x the volume or when more than one consumer needs the stream.

### 2. Idempotency key = canonical hash of the payload

`sha256` over the canonical form of `(patientId, type, ts, data)`. An `Idempotency-Key`
request header, when a sender provides one, is used instead. A unique index on the key is
what enforces the guarantee; a duplicate-key error on insert means "already seen" and is
answered with 202, same as the first time.

Two details that are easy to get wrong and silently break idempotency:
JSON object key order is not stable, so `data` is serialised with keys sorted recursively;
and `2026-01-01T10:00:00Z`, `...10:00:00.000Z` and `...+00:00` are the same instant with three
different string forms, so `ts` is normalised to a `Date` before hashing.

Trade-off accepted: two genuinely distinct events with identical `patientId`, `type`, `ts`
and `data` collapse into one. Without an identifier from the sender, that case is
indistinguishable from a retry — no design can separate them. Documented, not solved.

### 3. Patient state is derived, not stored

There is no patient-state document. The state is a fold over that patient's processed events
ordered by `ts`, computed on read.

Why: it keeps the single-collection constraint literally; it removes any possibility of the
stored state disagreeing with the events; and it makes the late-event problem disappear
instead of requiring reconciliation logic. An event that arrives with a `ts` older than
events already applied simply takes its place in the ordering on the next read.

Trade-off accepted: read cost grows with the number of events per patient. With more time:
a periodic snapshot per patient, folding only the events after it.

Two details the fold depends on. Events with an identical `ts` have no clinical order,
which happens for real — two sensors truncating to the second, or a sender stamping a whole
batch with one time. Leaving their relative order to the database makes the fold
non-deterministic: nothing obliges a query plan to return equal keys in a stable order, so
the same stored events could produce different vitals on two consecutive reads. The tie-break
is `idempotencyKey`, which is derived from content, so it is stable and independent of
arrival order. `receivedAt` would also be stable, but it would make the result depend on
arrival order, which is the one thing this design promises it never does.

And the fold covers `processed` events only, because those are the ones carrying the outcome
of the external call. The response therefore reports how many of that patient's events are
still `pending` or `processing`, and how many reached `failed`. Without that the state would
lie by omission: an event that exhausted its attempts is simply absent from the fold, and a
caller would read a complete-looking state with no way to know a reading is missing.

### 4. Per-event processing is independent; ordering lives in the fold

The slow external call enriches a single event and does not read the patient's current state.
The order-dependence required by the operating conditions lives in how those per-event
results are applied to produce the state.

Why: a late event then costs a re-fold, not a reprocess. If processing depended on the
current state, one event arriving late would invalidate the stored result of every later
event for that patient, and recomputing would mean calling the external system again — 5 s
each.

This is the main assumption in the design and the thing that would have to change first if
the external system turned out to be stateful per patient.

### 5. Lease, not lock

A claimed event carries `lockedUntil`. A worker that dies leaves the event claimed, but the
lease expires and another worker reclaims it.

The lease duration is a trade-off in both directions. Too short and a worker that is alive
but slow (GC pause, external system taking longer than expected) has its event taken by
another worker, producing two concurrent calls to the external system for the same event.
Too long and the ~83 events held by a crashed process stay invisible for that whole period
while new events keep arriving, so the backlog grows.

Graceful shutdown is what keeps this from mattering in the common case: on `SIGTERM` the
worker stops claiming, finishes what it holds, and releases the leases. The lease covers the
uncommon case — `SIGKILL`, OOM, power loss.

### 6. At-least-once, with idempotent effects

Exactly-once across our database and a third-party system does not exist. A process can die
after the external call returns and before the outcome is written; that event will be
processed again. The design makes re-processing harmless rather than claiming it cannot
happen: the outcome write is idempotent, and the derived state is a function of the event
set, not of how many times each event was handled.

### 7. One patient at a time, enforced by an index

A unique partial index on `{ patientId }` filtered to `status: 'processing'` allows at most
one in-flight event per patient. A second concurrent claim for the same patient is refused
by the server with a duplicate-key error and the worker moves to another candidate.

Why an index rather than a lock table or a list of busy patients: those are extra state that
can drift from reality when a process dies. The index cannot drift, because it is derived
from the same documents the workers are claiming.

Strictly speaking this is not required. Under decision 4 the derived state is correct
whatever order the events were processed in. It is here because the alternative is assuming
the external system tolerates two concurrent calls for the same patient, which is not
something we can verify about a third party.

### 8. Expired leases are swept back to pending

A graceful shutdown drains and needs no recovery. The sweep is for the other case: SIGKILL,
OOM, a node disappearing. A periodic pass moves events whose lease expired back to
`pending`, or to `failed` once they are out of attempts.

Sweeping rather than reclaiming inside the claim query keeps claiming to one shape: there is
only ever one kind of claimable work. The sweep interval is derived from the lease rather
than configured separately.

The sweep counts the lost attempt, even though the worker may have died for an unrelated
reason such as a deploy. An event that crashes whichever worker picks it up would otherwise
be retried for ever and take down every replica in turn.

It deliberately does not bump `lockVersion`. If the original worker is in fact alive and
finishes after the sweep, its write still matches and records the result it really obtained.
As soon as another worker claims the event the version moves and the latecomer is fenced out.

### 9. Busy patients are excluded from the candidate query

The claim query filters out patients that already have an event in flight, rather than
reading the oldest due events and letting the partial index refuse the ones whose patient is
busy.

Relying on the refusal alone is a head-of-line block. Candidates are ordered by
`nextAttemptAt`, so a patient with a backlog larger than the candidate window owns every
slot in it: one of its events is in flight, the rest are refused, `claim` returns nothing and
the worker backs off — while other patients' events sit due and claimable just outside the
window. Measured with 200 queued events for one patient and a single event for another, the
unrelated event waited for 181 of the 200 to drain, and the system ran at a concurrency of 1
with 100 slots free. At the 5 s per event this service simulates, that is a ~22 minute wait
with no error logged anywhere.

The cost is one extra read per claim round. It is bounded by how many events the whole system
has in flight, never by the size of the backlog. The duplicate-key path stays: a patient can
become busy between that read and the claim, and the index is still where the guarantee
lives.

With more time: the exclusion is a `$nin`, which the index applies as a residual filter, so a
very large single-patient backlog is scanned past on every round. Past roughly 10^5 queued
events for one patient that argues for a per-patient queue document — the extra state
decision 7 deliberately avoided. The trade-off reverses with volume.

## Data model

Single collection, one document per unique event.

```
{
  _id,
  idempotencyKey,   // unique index
  patientId,
  type,
  data,
  ts,               // clinical time, from the sender
  receivedAt,       // our clock
  status,           // pending | processing | processed | failed
  attempts,
  nextAttemptAt,    // backoff
  lockedUntil,      // lease expiry while processing
  lockedBy,         // worker id, for debugging a stuck event
  lockVersion,      // fencing token: bumped on every claim, checked on write-back
  result,           // outcome of the external call
  lastError         // { message, at } — why it failed, never swallowed
}
```

Indexes:

- unique on `idempotencyKey` — the idempotency guarantee
- `{ status, nextAttemptAt }` — claiming the next pending event
- `{ status, lockedUntil }` — reclaiming expired leases
- unique on `{ patientId }`, partial on `status: 'processing'` — at most one in-flight
  event per patient, and the set of busy patients the claim query excludes

Folding a patient's state will need `{ patientId, ts }`; it is not there yet because
nothing reads the fold.

## Still to build

- The fold that turns a patient's processed events into their current state, and a way to
  read it. Nothing demonstrates the ordering guarantee until this exists.
- Tests against a real MongoDB for the risky parts: duplicates, ordering, an expired lease
  being picked up, two workers competing.
- A load script at 1000 events/min with duplicates and out-of-order arrivals, a chaos script
  that kills a worker mid-flight, and a stats endpoint that makes "nothing was lost and
  nothing was counted twice" checkable rather than asserted.

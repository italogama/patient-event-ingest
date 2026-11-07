# Patient Event Ingest

Accepts patient events over HTTP, processes each one asynchronously (~5 s, simulated
external call), and persists the outcome in a single MongoDB collection.

Two processes share one collection: an API that validates and stores events, and a worker
that processes them. Patient state is derived from the stored events rather than kept as a
separate document.

## Running it

Docker and Docker Compose are the only requirements.

```
docker compose up -d --build
curl localhost:3000/health
```

That brings up four things:

- **mongo** — MongoDB as a single-node replica set. A replica set rather than a standalone
  server because the service writes with `w: majority`, which on a standalone mongod is
  silently meaningless. One node is enough to make it a real code path.
- **mongo-init** — a one-shot container that runs `rs.initiate()` and waits for a primary.
  It is idempotent, so restarting the stack does not re-initiate. The API and workers wait
  for it with `depends_on: service_completed_successfully`, because mongod accepting
  connections is not the same as the set having elected a primary.
- **api** — the HTTP entrypoint, on port 3000.
- **worker** — two replicas, the same image with a different entrypoint. `stop_grace_period`
  is 30 s: an event takes ~5 s and the worker drains what it holds before exiting, so the
  10 s Docker default would kill it mid-drain and leave leases to expire.

To run it on the host instead, copy `.env.example` to `.env` and use `npm run start` and
`npm run start:worker` with just `docker compose up -d mongo mongo-init`. Note the
`directConnection=true` in the example: `rs.initiate()` records each member under the
hostname `mongo:27017`, and a driver doing replica set discovery from the host is redirected
to a name that does not resolve outside the Docker network.

## The API

```
POST /events
{ "patientId": "p-1", "type": "vitals", "data": { "heartRate": 60 },
  "ts": "2026-01-01T10:00:00.000Z" }

202 Accepted
{ "eventId": "...", "duplicate": false }
```

`202`, not `201`: the event is stored but not processed, and the sender is told so. A resend
gets `202` as well, with the same `eventId` and `duplicate: true` — a sender that receives a
different status code for its own retry has to interpret it, and senders get that wrong.
An optional `Idempotency-Key` header replaces the content hash as the event's identity.

Fields outside the contract are stripped rather than rejected, and an unrecognised `type` is
accepted. Both for the same reason: a `400` makes a third-party sender drop the event
instead of retrying, and a sender adding a new event type should not lose data until we
deploy. Malformed input — a missing `patientId`, a `ts` that is not a real instant — is a
`400`.

```
GET /patients/:patientId/state   the fold, plus how many of that patient's
                                 events are pending, processing or failed
GET /stats                       status counts, the ingest arithmetic,
                                 out-of-order arrivals, retries, backlog
GET /health                      pings the database, not just the process
```

## Verifying it

```
npm install
npm test
```

Needs Node 22.12 or newer on the host. NestJS 12 ships ESM only, and the compiled tests
`require()` it, which is stable from 22.12. The service itself does not care: it runs on
`node:26-alpine` in the image.

54 tests against the MongoDB the stack is running — `docker compose up -d mongo mongo-init`
is enough. There is no in-memory substitute, because most of what is under test is the
database's own behaviour: a unique index refusing concurrent inserts, `findOneAndUpdate`
being atomic, a partial index serialising claims per patient. A fake would have to
reimplement exactly the parts most worth testing.

```
node scripts/load.mjs
```

Sends 1000 events/min for a minute across 200 patients, with resends and arrival order
shuffled, then waits for the backlog to drain and checks the arithmetic. A measured run:

```
posts accepted        1199, every one answered 202
events stored         1000
duplicates absorbed   199
out-of-order arrivals 333, across 178 of the 200 patients
POST latency          p50 9ms  p95 14ms  p99 16ms  max 19ms
backlog when sending stopped  78   (Little's law predicts ~83)
failed                0
```

The backlog number is the interesting one. 1000/min at ~5 s each means a system keeping up
holds about 83 events in flight; one that is falling behind shows a backlog that climbs.

`--patients` matters more than it looks. One event per patient is in flight at a time, so
the ceiling is `active patients / 5 s` no matter how many workers run: 1000 events/min needs
at least ~84 concurrently active patients. With 40 patients the service would be capped at
480/min, and the bottleneck would be the data, not the deployment.

Both scripts check their arithmetic against the whole collection, so they refuse to start on
a non-empty one. To reset between runs:

```
docker compose exec mongo mongosh --quiet ingest --eval 'db.events.deleteMany({})'
```

```
node scripts/chaos.mjs
```

`SIGKILL`s a worker that is holding events and waits for the survivor to recover them,
without restarting the dead replica. It picks the victim by which worker actually holds the
most in-flight events: killing whichever container is listed first proves nothing, because
the replicas race to claim and one can be holding everything while the other has not
started. A measured run — the killed worker held 16 of the 18 in flight; all 300 events
reached `processed`, none stuck, none failed, and 24 of them record the lost attempt.

When the victim was holding a large share of the work, the output shows a stretch where the
remaining count barely moves. That is the lease: the dead worker's events are invisible to
the survivor until it expires. It is what `LEASE_MS` costs, and the reason that value is a
trade-off rather than a number to minimise.

## Architecture

```
POST /events ──> validate ──> upsert on idempotencyKey ──> 202
                                        │
                                   events (one collection)
                                        │
          claim (findOneAndUpdate, lease + fencing token)
                                        │
                        worker ──> external system (~5 s)
                                        │
                         write outcome, conditioned on the token
                                        │
GET /patients/:id/state <── fold the processed events by ts
```

The API and the worker are separate processes from the same image, so they scale on
different signals: the API with incoming traffic, the worker with the size of the backlog.
Neither holds state of its own; everything that matters is in the collection, which is what
makes a killed process recoverable by any other.

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
  receivedCount,    // POSTs that resolved to this event; above 1 means a sender retried
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

## Configuration

Validated at boot with `class-validator`, reusing what the DTOs already need rather than
adding a schema library. A missing or malformed value kills the process at startup instead
of surfacing as a confusing failure later.

| Variable | Default | What it does |
| --- | --- | --- |
| `MONGO_URL` | none, required | Connection string. The process refuses to start without it. |
| `PORT` | `3000` | API port. |
| `WORKER_CONCURRENCY` | `50` | Events one worker process handles at once. |
| `LEASE_MS` | `30000` | How long a claim stays valid. |
| `MAX_ATTEMPTS` | `5` | Attempts before an event reaches `failed`. |
| `EXTERNAL_PROCESSING_MS` | `5000` | The ~5 s the assignment asks us to simulate. |
| `EXTERNAL_FAILURE_RATE` | `0` | Fraction of external calls that fail, for exercising retries. |

## Limits, and what I would do with more time

**Exactly-once does not exist here.** A worker can die after the external call returns and
before the outcome is written; that event will be processed again. The design makes
re-processing harmless instead of claiming it cannot happen. The one case the fencing token
does not fix is a worker whose lease expired mid-call: its database write is correctly
refused, but the external system has already been called twice. Fencing protects our data,
not a third party's.

**Two genuinely distinct events with identical `patientId`, `type`, `ts` and `data` collapse
into one.** Without an identifier from the sender that is indistinguishable from a retry. No
design separates them; the `Idempotency-Key` header is the way out for a sender that can
supply one.

**The claim path is chattier than it needs to be.** Filling 50 slots takes 50 rounds of
`distinct` + `find` + `findOneAndUpdate`. A batch claim — one `bulkWrite` with
`ordered: false` marking up to 20 candidates with a shared token, then one `find` to collect
them — would cut that to three round trips per 20 events. The price is that a worker dying
leaves 20 leases to expire instead of 1, which is the same trade-off as raising
`max.poll.records` in a Kafka consumer. At 1000/min the round trips are not worth that.

**Workers poll.** Change streams would remove the idle latency, but not the polling: a
change stream does not reserve anything, knows nothing about expired leases or scheduled
retries, and needs a durable resume token to survive a restart. The right use is a wake-up
hint on top of the existing loop, replacing the adaptive backoff rather than the claim.

**Reading a patient's state is O(events for that patient).** The fix is a periodic snapshot
per patient, folding only the events after it — kept as a cache that can always be rebuilt
from the events, not as a second source of truth that can disagree with them.

**The `$nin` that excludes busy patients is a residual filter**, so a very large
single-patient backlog is scanned past on every claim round. Past roughly 10^5 queued events
for one patient, that argues for a per-patient queue document, which is the extra state
decision 7 deliberately avoided. The trade-off reverses with volume.

**`/stats` scans the collection.** The out-of-order count groups every event by patient. It
is an inspection endpoint for a reviewer, not something to put on a dashboard polling every
ten seconds.

**Not built, because the assignment excludes it from evaluation:** authentication, any UI,
real clinical logic, and CI. The fold's event types are deliberately simple — enough to make
ordering observable, not an attempt at a clinical model.

**The decision to revisit first** is the collection-as-queue. It is right at this volume and
avoids the dual-write gap a broker would introduce, but at ~10x, or as soon as a second
consumer needs the same stream, a log with partitioning by `patientId` becomes the better
answer — and the per-patient ordering this service enforces with an index is the same thing
a Kafka partition key buys.

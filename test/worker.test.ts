import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { Types } from 'mongoose';

import { EventStatus } from '../src/events/event.schema';
import { EventProcessor } from '../src/worker/event-processor';
import { ClaimedEvent, EventQueue } from '../src/worker/event-queue';
import { ExternalSystem } from '../src/worker/external-system';
import { LeaseReaper } from '../src/worker/lease-reaper';
import { MongoContext, createMongoContext } from './mongo-fixture';

const LEASE_MS = 5_000;
const MAX_ATTEMPTS = 3;

describe('worker', () => {
  let ctx: MongoContext;
  let queue: EventQueue;
  let processor: EventProcessor;
  let reaper: LeaseReaper;

  before(async () => {
    ctx = await createMongoContext(
      'worker',
      [EventQueue, ExternalSystem, EventProcessor, LeaseReaper],
      {
        LEASE_MS: String(LEASE_MS),
        MAX_ATTEMPTS: String(MAX_ATTEMPTS),
        // The 5 seconds the service simulates would only make these tests slow;
        // the timing is not what is under test here.
        EXTERNAL_PROCESSING_MS: '10',
        EXTERNAL_FAILURE_RATE: '0',
      },
    );
    queue = ctx.get<EventQueue>(EventQueue);
    processor = ctx.get<EventProcessor>(EventProcessor);
    reaper = ctx.get<LeaseReaper>(LeaseReaper);
  });

  afterEach(() => ctx.clear());
  after(() => ctx.close());

  let seq = 0;

  /** Inserts claimable events straight into the collection. */
  async function seed(patientId: string, count = 1): Promise<void> {
    const now = new Date();
    await ctx.events.insertMany(
      Array.from({ length: count }, () => {
        seq += 1;
        return {
          idempotencyKey: `seed:${seq}`,
          patientId,
          type: 'vitals',
          data: { seq },
          ts: new Date(Date.parse('2026-11-07T00:00:00.000Z') + seq * 1000),
          receivedAt: now,
          receivedCount: 1,
          status: EventStatus.Pending,
          attempts: 0,
          nextAttemptAt: now,
          lockedUntil: null,
          lockedBy: null,
          lockVersion: 0,
          result: null,
          lastError: null,
        };
      }),
    );
  }

  const expireLease = (id: Types.ObjectId) =>
    ctx.events.updateOne({ _id: id }, { $set: { lockedUntil: new Date(Date.now() - 1) } });

  describe('claim', () => {
    it('marks the event as processing and takes a fencing token', async () => {
      await seed('p-1');
      const claim = await queue.claim('worker-a');

      assert.ok(claim);
      assert.equal(claim.lockVersion, 1);

      const stored = await ctx.events.findById(claim.id).lean();
      assert.equal(stored?.status, EventStatus.Processing);
      assert.equal(stored?.lockedBy, 'worker-a');
      assert.ok(stored!.lockedUntil!.getTime() > Date.now());
    });

    it('gives nothing back when the queue is empty', async () => {
      assert.equal(await queue.claim('worker-a'), null);
    });

    it('does not hand out a second event for a patient already in flight', async () => {
      await seed('p-1', 2);

      assert.ok(await queue.claim('worker-a'));
      // The patient's other event stays pending: the state it describes
      // depends on the first one having been applied.
      assert.equal(await queue.claim('worker-b'), null);
      assert.equal(await ctx.events.countDocuments({ status: EventStatus.Pending }), 1);
    });

    it('serialises a patient even when the claims are concurrent', async () => {
      await seed('p-1', 5);

      const claims = await Promise.all(
        Array.from({ length: 5 }, (_, i) => queue.claim(`worker-${i}`)),
      );

      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await ctx.events.countDocuments({ status: EventStatus.Processing }), 1);
    });

    it('does not let a patient with a backlog hide the rest of the queue', async () => {
      // Regression. Candidates are ordered by nextAttemptAt, and a patient with
      // more queued events than the candidate window used to fill it entirely:
      // one event in flight, the rest refused by the partial index, claim()
      // returning nothing, and the worker backing off while another patient's
      // event sat due just outside the window. Measured at 200 queued events,
      // an unrelated event waited for 181 of them to drain.
      await seed('p-noisy', 30);
      await seed('p-quiet', 1);

      const first = await queue.claim('worker-a');
      assert.equal(first?.patientId, 'p-noisy');

      const second = await queue.claim('worker-b');
      assert.equal(second?.patientId, 'p-quiet');
    });

    it('leaves an event alone until its backoff is due', async () => {
      await seed('p-1');
      const claim = await queue.claim('worker-a');
      await queue.recordFailure(claim!, new Error('external system said no'));

      // Back to pending, but scheduled into the future.
      assert.equal(await ctx.events.countDocuments({ status: EventStatus.Pending }), 1);
      assert.equal(await queue.claim('worker-a'), null);
    });
  });

  describe('fencing', () => {
    it('refuses the write-back of a worker whose lease was taken over', async () => {
      await seed('p-1');
      const stale = (await queue.claim('worker-a'))!;

      // worker-a is alive but stalled: its lease expires and the sweep puts the
      // event back, so worker-b takes it over.
      await expireLease(stale.id);
      await reaper.sweep();
      const fresh = (await queue.claim('worker-b'))!;
      assert.equal(fresh.lockVersion, 2);

      assert.equal(await queue.recordSuccess(stale, { from: 'worker-a' }), 'lease-lost');
      assert.equal(await queue.recordSuccess(fresh, { from: 'worker-b' }), 'written');

      const stored = await ctx.events.findById(fresh.id).lean();
      assert.deepEqual(stored?.result, { from: 'worker-b' });
    });

    it('still accepts the original worker if nobody took the event over', async () => {
      await seed('p-1');
      const claim = (await queue.claim('worker-a'))!;

      // The sweep deliberately does not bump lockVersion, so a worker that was
      // merely slow can still record the result it really obtained.
      await expireLease(claim.id);
      await reaper.sweep();

      assert.equal(await queue.recordSuccess(claim, { from: 'worker-a' }), 'written');
    });

    it('refuses a stale failure write-back too', async () => {
      await seed('p-1');
      const stale = (await queue.claim('worker-a'))!;

      await expireLease(stale.id);
      await reaper.sweep();
      await queue.claim('worker-b');

      assert.equal(
        await queue.recordFailure(stale, new Error('too late')),
        'lease-lost',
      );
      // The failure must not have reset the event out from under worker-b.
      const stored = await ctx.events.findById(stale.id).lean();
      assert.equal(stored?.status, EventStatus.Processing);
      assert.equal(stored?.lockedBy, 'worker-b');
    });
  });

  describe('lease reaper', () => {
    it('returns an abandoned event to the queue and counts the lost attempt', async () => {
      await seed('p-1');
      const claim = (await queue.claim('worker-a'))!;
      await expireLease(claim.id);

      assert.deepEqual(await reaper.sweep(), { requeued: 1, failed: 0 });

      const stored = await ctx.events.findById(claim.id).lean();
      assert.equal(stored?.status, EventStatus.Pending);
      assert.equal(stored?.attempts, 1);
      assert.equal(stored?.lockedBy, null);
      assert.equal(stored?.lockedUntil, null);
      assert.match(stored!.lastError!.message, /lease expired/);
    });

    it('leaves a lease that has not expired alone', async () => {
      await seed('p-1');
      const claim = (await queue.claim('worker-a'))!;

      assert.deepEqual(await reaper.sweep(), { requeued: 0, failed: 0 });
      const stored = await ctx.events.findById(claim.id).lean();
      assert.equal(stored?.status, EventStatus.Processing);
    });

    it('fails an event that has run out of attempts instead of requeueing it for ever', async () => {
      // An event that kills whichever worker picks it up would otherwise take
      // down every replica in turn, one lease at a time.
      await seed('p-1');
      await ctx.events.updateOne({}, { $set: { attempts: MAX_ATTEMPTS - 1 } });

      const claim = (await queue.claim('worker-a'))!;
      await expireLease(claim.id);

      assert.deepEqual(await reaper.sweep(), { requeued: 0, failed: 1 });

      const stored = await ctx.events.findById(claim.id).lean();
      assert.equal(stored?.status, EventStatus.Failed);
      assert.equal(stored?.attempts, MAX_ATTEMPTS);
    });

    it('recovers every event a dead worker was holding', async () => {
      await seed('p-1');
      await seed('p-2');
      await seed('p-3');

      const held = [
        await queue.claim('dead-worker'),
        await queue.claim('dead-worker'),
        await queue.claim('dead-worker'),
      ].map((claim) => claim!.id);

      for (const id of held) {
        await expireLease(id);
      }

      assert.deepEqual(await reaper.sweep(), { requeued: 3, failed: 0 });
      assert.equal(await ctx.events.countDocuments({ status: EventStatus.Pending }), 3);
    });
  });

  describe('processing', () => {
    it('records the outcome and releases the lease', async () => {
      await seed('p-1');
      const claim = (await queue.claim('worker-a'))!;

      await processor.process(claim);

      const stored = await ctx.events.findById(claim.id).lean();
      assert.equal(stored?.status, EventStatus.Processed);
      assert.equal(stored?.attempts, 1);
      assert.equal(stored?.lockedBy, null);
      assert.equal(stored?.lockedUntil, null);
      assert.equal(stored?.lastError, null);
      assert.ok(stored?.result);
    });

    it('does not throw when the event cannot be processed', async () => {
      await seed('p-1');
      const claim = (await queue.claim('worker-a'))!;

      // A claim whose document is gone: process() has to absorb it, because a
      // throw here would take down the worker loop and with it every other
      // event in flight.
      await ctx.events.deleteOne({ _id: claim.id });
      await processor.process(claim satisfies ClaimedEvent);
    });

    it('retries a failing event up to MAX_ATTEMPTS and then gives up', async () => {
      await seed('p-1');

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Make it claimable again: the backoff would otherwise hold it back.
        await ctx.events.updateOne({}, { $set: { nextAttemptAt: new Date() } });

        const claim = await queue.claim('worker-a');
        assert.ok(claim, `attempt ${attempt} should have been claimable`);

        const outcome = await queue.recordFailure(claim, new Error('external system is down'));
        assert.equal(outcome, attempt === MAX_ATTEMPTS ? 'failed' : 'retry-scheduled');
      }

      const stored = await ctx.events.findOne({}).lean();
      assert.equal(stored?.status, EventStatus.Failed);
      assert.equal(stored?.attempts, MAX_ATTEMPTS);
      assert.match(stored!.lastError!.message, /external system is down/);
      // Nothing is left holding a lease on a terminal event.
      assert.equal(stored?.lockedBy, null);
      assert.equal(stored?.lockedUntil, null);
    });
  });
});

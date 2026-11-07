import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { EventIngestService } from '../src/events/event-ingest.service';
import { IngestEventDto } from '../src/events/ingest-event.dto';
import { MongoContext, createMongoContext } from './mongo-fixture';

const event: IngestEventDto = {
  patientId: 'p-1',
  type: 'vitals',
  data: { heartRate: 60, bloodPressure: { systolic: 120, diastolic: 80 } },
  ts: '2026-01-01T10:00:00.000Z',
};

describe('EventIngestService', () => {
  let ctx: MongoContext;
  let ingest: EventIngestService;

  before(async () => {
    ctx = await createMongoContext('ingest', [EventIngestService]);
    ingest = ctx.get<EventIngestService>(EventIngestService);
  });

  afterEach(() => ctx.clear());
  after(() => ctx.close());

  it('stores a new event once, ready to be claimed', async () => {
    const result = await ingest.ingest(event);
    assert.equal(result.duplicate, false);
    assert.equal(await ctx.events.countDocuments({}), 1);

    const stored = await ctx.events.findOne({}).lean();
    assert.equal(stored?.status, 'pending');
    assert.equal(stored?.attempts, 0);
    assert.equal(stored?.lockVersion, 0);
    assert.equal(stored?.receivedCount, 1);
    assert.ok(stored!.nextAttemptAt.getTime() <= Date.now());
  });

  it('collapses a resend onto the first event', async () => {
    const first = await ingest.ingest(event);
    const second = await ingest.ingest({ ...event });

    assert.equal(second.eventId, first.eventId);
    assert.equal(second.duplicate, true);
    assert.equal(await ctx.events.countDocuments({}), 1);
  });

  it('counts every delivery, so duplicates can be checked by subtraction', async () => {
    await ingest.ingest(event);
    await ingest.ingest({ ...event });
    await ingest.ingest({ ...event });

    const stored = await ctx.events.findOne({}).lean();
    assert.equal(stored?.receivedCount, 3);
  });

  it('survives concurrent resends of the same event', async () => {
    // The real shape of the problem: a sender timed out and its retries arrive
    // at the same instant. A findOne followed by an insert would let several
    // of these pass the read and then insert.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => ingest.ingest({ ...event })),
    );

    assert.equal(await ctx.events.countDocuments({}), 1);
    assert.equal(new Set(results.map((r) => r.eventId)).size, 1);
    assert.equal(results.filter((r) => !r.duplicate).length, 1);

    const stored = await ctx.events.findOne({}).lean();
    assert.equal(stored?.receivedCount, 25);
  });

  it('ignores the key order the sender serialised data in', async () => {
    await ingest.ingest(event);
    const again = await ingest.ingest({
      ...event,
      data: { bloodPressure: { diastolic: 80, systolic: 120 }, heartRate: 60 },
    });

    assert.equal(again.duplicate, true);
    assert.equal(await ctx.events.countDocuments({}), 1);
  });

  it('treats the same instant written differently as one event', async () => {
    await ingest.ingest(event);
    const again = await ingest.ingest({ ...event, ts: '2026-01-01T07:00:00-03:00' });

    assert.equal(again.duplicate, true);
    assert.equal(await ctx.events.countDocuments({}), 1);
  });

  it('keeps genuinely different events apart', async () => {
    await ingest.ingest(event);
    await ingest.ingest({ ...event, data: { heartRate: 61 } });
    await ingest.ingest({ ...event, patientId: 'p-2' });

    assert.equal(await ctx.events.countDocuments({}), 3);
  });

  it('prefers a sender-supplied key over the content hash', async () => {
    const first = await ingest.ingest(event, 'sender-key-1');
    // Different content, same key: the sender is asserting these are one event.
    const second = await ingest.ingest({ ...event, data: { heartRate: 99 } }, 'sender-key-1');

    assert.equal(second.eventId, first.eventId);
    assert.equal(await ctx.events.countDocuments({}), 1);
  });

  it('does not let a sender-supplied key collide with a content hash', async () => {
    const byContent = await ingest.ingest(event);
    const stored = await ctx.events.findById(byContent.eventId).lean();

    // A sender replaying the stored hash verbatim must not land on that event.
    const bySender = await ingest.ingest(event, stored!.idempotencyKey);

    assert.notEqual(bySender.eventId, byContent.eventId);
    assert.equal(await ctx.events.countDocuments({}), 2);
  });
});

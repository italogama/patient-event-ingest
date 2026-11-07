import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';

const DEFAULT_URL = 'mongodb://localhost:27017/ingest?directConnection=true';

const valid = {
  patientId: 'p-1',
  type: 'vitals',
  data: { heartRate: 60 },
  ts: '2026-01-01T10:00:00.000Z',
};

describe('HTTP contract', () => {
  let app: NestExpressApplication;
  let connection: Connection;
  let base: string;

  before(async () => {
    // AppModule reads MONGO_URL through the same validated config the service
    // runs with, so the test database is selected here rather than injected.
    const url = new URL(process.env.MONGO_URL ?? DEFAULT_URL);
    url.pathname = '/ingest_test_http';
    process.env.MONGO_URL = url.toString();

    // Imported here, not at the top of the file: ConfigModule.forRoot validates
    // the environment while the module is being decorated, which with a static
    // import happens before this runs.
    const { AppModule } = await import('../src/app.module');
    const { configureHttpApp } = await import('../src/http-app');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureHttpApp(app);
    await app.init();
    // Port 0: the OS picks a free one, so the tests do not collide with a
    // service already running on 3000.
    await app.listen(0);

    connection = moduleRef.get<Connection>(getConnectionToken());
    await connection.collection('events').deleteMany({});
    base = await app.getUrl();
  });

  after(async () => {
    await connection.dropDatabase();
    await app.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('accepts a valid event with 202 and an id', async () => {
    const res = await post({ ...valid, patientId: 'accept-1' });
    assert.equal(res.status, 202);

    const body = await res.json();
    assert.equal(body.duplicate, false);
    assert.equal(typeof body.eventId, 'string');
  });

  it('answers a resend with the same id and the same status code', async () => {
    // 202 both times on purpose: a sender that gets a different status for its
    // own retry has to decide what that means, and senders get that wrong.
    const first = await (await post({ ...valid, patientId: 'accept-2' })).json();
    const res = await post({ ...valid, patientId: 'accept-2' });
    const second = await res.json();

    assert.equal(res.status, 202);
    assert.equal(second.eventId, first.eventId);
    assert.equal(second.duplicate, true);
  });

  it('strips a field outside the contract rather than rejecting the event', async () => {
    const res = await post({ ...valid, patientId: 'extra-1', somethingElse: 'ignored' });
    assert.equal(res.status, 202);

    const stored = await connection.collection('events').findOne({ patientId: 'extra-1' });
    assert.equal('somethingElse' in stored!, false);
    assert.equal('somethingElse' in stored!.data, false);
  });

  it('accepts an event type it has no processing rule for', async () => {
    // Rejecting unknown types would mean a sender's new event type is lost
    // until we deploy. They are stored and counted instead.
    const res = await post({ ...valid, patientId: 'unknown-1', type: 'lab_result_v2' });
    assert.equal(res.status, 202);
  });

  it('honours an Idempotency-Key header over the content hash', async () => {
    const a = await (
      await post({ ...valid, patientId: 'key-1' }, { 'idempotency-key': 'abc' })
    ).json();
    const b = await (
      await post({ ...valid, patientId: 'key-1', data: { heartRate: 99 } }, { 'idempotency-key': 'abc' })
    ).json();

    assert.equal(b.eventId, a.eventId);
    assert.equal(b.duplicate, true);
  });

  for (const [label, body] of [
    ['no patientId', { type: 'vitals', data: {}, ts: valid.ts }],
    ['no type', { patientId: 'p', data: {}, ts: valid.ts }],
    ['no ts', { patientId: 'p', type: 'vitals', data: {} }],
    ['data is not an object', { ...valid, data: 'heartRate=60' }],
    ['ts is not a timestamp', { ...valid, ts: 'yesterday' }],
    ['ts is a date that does not exist', { ...valid, ts: '2026-02-30T10:00:00.000Z' }],
    ['patientId is empty', { ...valid, patientId: '' }],
  ] as const) {
    it(`rejects a malformed event: ${label}`, async () => {
      const res = await post(body);
      assert.equal(res.status, 400);
    });
  }

  it('reports the derived state of a patient', async () => {
    await post({
      patientId: 'state-1',
      type: 'admission',
      data: { ward: 'icu' },
      ts: '2026-01-01T10:00:00.000Z',
    });

    const res = await fetch(`${base}/patients/state-1/state`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // Not processed yet, so nothing is folded, and the response says why
    // instead of presenting an empty state as the truth.
    assert.equal(body.eventsApplied, 0);
    assert.equal(body.notApplied.pending, 1);
  });

  it('answers 404 for a patient it has never heard of', async () => {
    // An empty state would be a different clinical claim from "no data".
    const res = await fetch(`${base}/patients/nobody/state`);
    assert.equal(res.status, 404);
  });

  it('serves health and stats', async () => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const stats = await (await fetch(`${base}/stats`)).json();
    assert.equal(typeof stats.events.total, 'number');
    assert.equal(stats.ingest.postsAccepted - stats.ingest.eventsStored, stats.ingest.duplicatesSuppressed);
  });
});

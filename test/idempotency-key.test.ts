import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clientKey, contentKey } from '../src/events/idempotency-key';

const event = {
  patientId: 'p-1',
  type: 'vitals',
  ts: new Date('2026-01-01T10:00:00.000Z'),
  data: { heartRate: 60, bloodPressure: { systolic: 120, diastolic: 80 } },
};

describe('contentKey', () => {
  it('is the same for the same event sent twice', () => {
    assert.equal(contentKey(event), contentKey({ ...event }));
  });

  it('ignores the order the sender happened to serialise keys in', () => {
    const reordered = {
      ...event,
      data: { bloodPressure: { diastolic: 80, systolic: 120 }, heartRate: 60 },
    };
    assert.equal(contentKey(reordered), contentKey(event));
  });

  it('treats the same instant written three ways as one event', () => {
    const keys = [
      '2026-01-01T10:00:00Z',
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T07:00:00.000-03:00',
    ].map((ts) => contentKey({ ...event, ts: new Date(ts) }));

    assert.equal(new Set(keys).size, 1);
  });

  it('separates events that differ in any field', () => {
    const keys = new Set([
      contentKey(event),
      contentKey({ ...event, patientId: 'p-2' }),
      contentKey({ ...event, type: 'medication' }),
      contentKey({ ...event, ts: new Date('2026-01-01T10:00:01.000Z') }),
      contentKey({ ...event, data: { heartRate: 61 } }),
    ]);

    assert.equal(keys.size, 5);
  });

  it('cannot be forged by putting a separator inside a value', () => {
    // Joining the fields with a delimiter would let one event's data spell out
    // another event's identity and collapse the two.
    assert.notEqual(
      contentKey({ ...event, patientId: 'p-1', type: 'vitals', data: {} }),
      contentKey({ ...event, patientId: 'p-1|vitals', type: '', data: {} }),
    );
  });
});

describe('clientKey', () => {
  it('is namespaced away from content keys', () => {
    // Otherwise a sender could supply the hash of somebody else's event and
    // have its own event silently absorbed into it.
    assert.notEqual(clientKey('abc'), contentKey(event));
    assert.ok(clientKey('abc').startsWith('client:'));
    assert.ok(contentKey(event).startsWith('sha256:'));
  });
});

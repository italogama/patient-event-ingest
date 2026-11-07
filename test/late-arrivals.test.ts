import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PatientArrivals, countLateArrivals } from '../src/stats/stats.service';

/** Clinical times in the order they arrived, as the aggregation hands them over. */
function patient(id: string, ...minutes: number[]): PatientArrivals {
  return {
    _id: id,
    arrivals: minutes.map((m) => new Date(Date.parse('2026-11-07T00:00:00.000Z') + m * 60_000)),
  };
}

describe('countLateArrivals', () => {
  it('counts nothing for no events', () => {
    assert.deepEqual(countLateArrivals([]), { lateArrivals: 0, patientsAffected: 0 });
  });

  it('counts nothing when every event arrived in clinical order', () => {
    assert.deepEqual(countLateArrivals([patient('p', 1, 2, 3)]), {
      lateArrivals: 0,
      patientsAffected: 0,
    });
  });

  it('counts an event that arrived after a newer one', () => {
    assert.deepEqual(countLateArrivals([patient('p', 3, 1)]), {
      lateArrivals: 1,
      patientsAffected: 1,
    });
  });

  it('counts a tied ts as in order', () => {
    // Equal is not late: nothing newer had arrived.
    assert.deepEqual(countLateArrivals([patient('p', 2, 2, 2)]), {
      lateArrivals: 0,
      patientsAffected: 0,
    });
  });

  it('compares against the newest seen, not the previous one', () => {
    // 5 arrives, then 4 and 3 are both late even though 3 < 4.
    assert.deepEqual(countLateArrivals([patient('p', 5, 4, 3)]), {
      lateArrivals: 2,
      patientsAffected: 1,
    });
  });

  it('counts a patient once however many of its events were late', () => {
    assert.deepEqual(countLateArrivals([patient('p', 9, 1, 2, 3)]), {
      lateArrivals: 3,
      patientsAffected: 1,
    });
  });

  it('keeps patients separate', () => {
    assert.deepEqual(
      countLateArrivals([patient('a', 2, 1), patient('b', 1, 2), patient('c', 3, 1)]),
      { lateArrivals: 2, patientsAffected: 2 },
    );
  });
});

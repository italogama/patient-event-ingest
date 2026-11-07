import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FoldableEvent, foldPatientState } from '../src/patients/patient-state';

let keySeed = 0;

/** Only has to be stable and content-derived; the hash itself is tested elsewhere. */
function event(type: string, minute: number, data: Record<string, unknown> = {}): FoldableEvent {
  return {
    type,
    ts: new Date(Date.parse('2026-11-07T00:00:00.000Z') + minute * 60_000),
    idempotencyKey: `sha256:${(keySeed++).toString().padStart(4, '0')}`,
    data,
  };
}

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe('foldPatientState', () => {
  it('applies events by ts, not by the order it was handed them', () => {
    const admitted = event('admission', 1, { ward: 'icu' });
    const vitals = event('vitals', 2, { heartRate: 60 });
    const discharged = event('discharge', 3);

    const inOrder = foldPatientState('p', [admitted, vitals, discharged]);
    const backwards = foldPatientState('p', [discharged, vitals, admitted]);

    assert.deepEqual(backwards, inOrder);
    assert.equal(inOrder.admitted, false);
  });

  it('gives the same state for every arrival order of the same events', () => {
    const events = [
      event('admission', 1, { ward: 'icu' }),
      event('vitals', 2, { heartRate: 60 }),
      event('medication', 3, { name: 'heparin' }),
      event('discharge', 4),
      event('admission', 5, { ward: 'ward-7' }),
      event('vitals', 6, { heartRate: 72 }),
    ];

    const expected = JSON.stringify(foldPatientState('p', events));
    for (let i = 0; i < 50; i++) {
      assert.equal(JSON.stringify(foldPatientState('p', shuffle(events))), expected);
    }
  });

  it('reads as admitted when the discharge is clinically older than the admission', () => {
    // Arrival order says discharged last; clinical time says re-admitted.
    const state = foldPatientState('p', [
      event('admission', 3, { ward: 'ward-7' }),
      event('discharge', 1),
    ]);

    assert.equal(state.admitted, true);
    assert.equal(state.ward, 'ward-7');
  });

  it('does not let a late event overwrite a newer reading', () => {
    const newer = event('vitals', 5, { heartRate: 80 });
    const late = event('vitals', 3, { heartRate: 50 });

    assert.equal(foldPatientState('p', [newer]).vitals.heartRate, 80);

    const after = foldPatientState('p', [newer, late]);
    assert.equal(after.vitals.heartRate, 80);
    assert.equal(after.eventsApplied, 2);
  });

  it('breaks a tied ts deterministically', () => {
    // Two sensors stamping the same second. Without a tie-break the result
    // would depend on whatever order the caller's query happened to return.
    const a = { ...event('vitals', 5, { heartRate: 60 }), idempotencyKey: 'sha256:aaa' };
    const b = { ...event('vitals', 5, { heartRate: 120 }), idempotencyKey: 'sha256:bbb' };

    assert.equal(foldPatientState('p', [a, b]).vitals.heartRate, 120);
    assert.equal(foldPatientState('p', [b, a]).vitals.heartRate, 120);
  });

  it('merges vitals field by field so a partial reading erases nothing', () => {
    const state = foldPatientState('p', [
      event('vitals', 1, { heartRate: 60, temperature: 37 }),
      event('vitals', 2, { heartRate: 72 }),
    ]);

    assert.deepEqual(state.vitals, { heartRate: 72, temperature: 37 });
  });

  it('counts types it has no rule for instead of dropping them', () => {
    const state = foldPatientState('p', [
      event('lab_result_v2', 1, { panel: 'cbc' }),
      event('lab_result_v2', 2, { panel: 'bmp' }),
      event('something_new', 3),
    ]);

    assert.deepEqual(state.unknownTypes, { lab_result_v2: 2, something_new: 1 });
    assert.equal(state.eventsApplied, 3);
  });

  it('is empty but valid for a patient with no events', () => {
    assert.deepEqual(foldPatientState('p', []), {
      patientId: 'p',
      admitted: false,
      ward: null,
      vitals: {},
      medications: [],
      eventsApplied: 0,
      unknownTypes: {},
    });
  });
});

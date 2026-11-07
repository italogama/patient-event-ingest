/**
 * The state of a patient is a fold over that patient's events in clinical
 * order. There is no stored state document: see README decision 3.
 */

export interface FoldableEvent {
  type: string;
  ts: Date;
  /** Content-derived, which is what makes the tie-break deterministic. */
  idempotencyKey: string;
  data: Record<string, unknown>;
}

export interface MedicationGiven {
  name: string;
  at: Date;
}

export interface PatientState {
  patientId: string;
  admitted: boolean;
  ward: string | null;
  /** Last reading per field, by clinical time. */
  vitals: Record<string, unknown>;
  medications: MedicationGiven[];
  eventsApplied: number;
  /** Types we have no rule for, counted rather than dropped. */
  unknownTypes: Record<string, number>;
}

/**
 * Events with the same ts have no clinical order, and that happens for real:
 * two sensors truncating to the second, or a sender stamping a whole batch
 * with one time. Leaving the order to the database makes the fold
 * non-deterministic — the same stored events could produce different vitals on
 * two consecutive reads, because nothing obliges a query plan to return equal
 * keys in a stable order.
 *
 * The tie-break is the idempotency key rather than receivedAt: both are
 * stable, but receivedAt would make the result depend on arrival order, which
 * is the one thing the design promises it never does.
 */
function clinicalOrder(a: FoldableEvent, b: FoldableEvent): number {
  const byTs = a.ts.getTime() - b.ts.getTime();
  if (byTs !== 0) {
    return byTs;
  }
  return a.idempotencyKey < b.idempotencyKey ? -1 : 1;
}

export function foldPatientState(
  patientId: string,
  events: readonly FoldableEvent[],
): PatientState {
  const state: PatientState = {
    patientId,
    admitted: false,
    ward: null,
    vitals: {},
    medications: [],
    eventsApplied: 0,
    unknownTypes: {},
  };

  // Sorted here rather than by the caller's query so the fold is a function of
  // the event set alone, whatever order it was handed them in.
  for (const event of [...events].sort(clinicalOrder)) {
    state.eventsApplied += 1;

    switch (event.type) {
      case 'admission':
        state.admitted = true;
        state.ward = typeof event.data.ward === 'string' ? event.data.ward : null;
        break;

      case 'discharge':
        state.admitted = false;
        state.ward = null;
        break;

      case 'vitals':
        // Field by field, so a reading that only carries heartRate does not
        // erase a bloodPressure measured earlier.
        Object.assign(state.vitals, event.data);
        break;

      case 'medication':
        if (typeof event.data.name === 'string') {
          state.medications.push({ name: event.data.name, at: event.ts });
        }
        break;

      default:
        state.unknownTypes[event.type] = (state.unknownTypes[event.type] ?? 0) + 1;
    }
  }

  return state;
}

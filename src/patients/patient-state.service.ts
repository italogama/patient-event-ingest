import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EventStatus, PatientEvent } from '../events/event.schema';
import { FoldableEvent, PatientState, foldPatientState } from './patient-state';

/**
 * Without this the state would lie by omission: an event that exhausted its
 * attempts is simply absent from the fold. "failed" is the number to alert on.
 */
export interface NotApplied {
  pending: number;
  processing: number;
  failed: number;
}

export interface PatientStateResponse extends PatientState {
  notApplied: NotApplied;
}

@Injectable()
export class PatientStateService {
  constructor(
    @InjectModel(PatientEvent.name) private readonly events: Model<PatientEvent>,
  ) {}

  async read(patientId: string): Promise<PatientStateResponse> {
    const byStatus = await this.events.aggregate<{ _id: EventStatus; count: number }>([
      { $match: { patientId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const counts = new Map(byStatus.map((row) => [row._id, row.count]));
    const total = byStatus.reduce((sum, row) => sum + row.count, 0);

    if (total === 0) {
      // An unknown patient would otherwise read as a discharged one with no
      // vitals, which is a different clinical claim from "we have nothing".
      throw new NotFoundException(`no events for patient ${patientId}`);
    }

    // Only processed events carry the outcome of the external call. The fold
    // sorts them itself, so no ordering is requested here.
    const processed = await this.events
      .find({ patientId, status: EventStatus.Processed })
      .select({ type: 1, ts: 1, idempotencyKey: 1, result: 1 })
      .lean();

    const foldable: FoldableEvent[] = processed.map((doc) => ({
      type: doc.type,
      ts: doc.ts,
      idempotencyKey: doc.idempotencyKey,
      data: (doc.result?.normalized as Record<string, unknown>) ?? {},
    }));

    return {
      ...foldPatientState(patientId, foldable),
      notApplied: {
        pending: counts.get(EventStatus.Pending) ?? 0,
        processing: counts.get(EventStatus.Processing) ?? 0,
        failed: counts.get(EventStatus.Failed) ?? 0,
      },
    };
  }
}

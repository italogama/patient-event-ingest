import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EventStatus, PatientEvent } from '../events/event.schema';

export interface Stats {
  events: Record<EventStatus | 'total', number>;
  patients: number;
  ingest: {
    postsAccepted: number;
    eventsStored: number;
    duplicatesSuppressed: number;
  };
  ordering: {
    lateArrivals: number;
    patientsAffected: number;
  };
  retries: {
    eventsWithMoreThanOneAttempt: number;
    highestAttempts: number;
  };
  backlog: {
    inFlight: number;
    oldestPendingAgeMs: number | null;
    /** Keyed by worker id: whether work is spread, and where a stuck event sits. */
    inFlightByWorker: Record<string, number>;
  };
}

export interface PatientArrivals {
  _id: string;
  /** One patient's clinical times, in the order the events arrived. */
  arrivals: Date[];
}

/**
 * An arrival is late when a newer clinical time had already arrived for that
 * patient. This is the number that shows the senders really did deliver out of
 * order; a load test that happened to arrive in order would prove nothing.
 */
export function countLateArrivals(patients: readonly PatientArrivals[]): {
  lateArrivals: number;
  patientsAffected: number;
} {
  let lateArrivals = 0;
  let patientsAffected = 0;

  for (const patient of patients) {
    let late = 0;
    let newest = -Infinity;

    for (const ts of patient.arrivals) {
      const at = ts.getTime();
      if (at < newest) {
        late += 1;
      } else {
        newest = at;
      }
    }

    lateArrivals += late;
    if (late > 0) {
      patientsAffected += 1;
    }
  }

  return { lateArrivals, patientsAffected };
}

@Injectable()
export class StatsService {
  constructor(
    @InjectModel(PatientEvent.name) private readonly events: Model<PatientEvent>,
  ) {}

  async read(): Promise<Stats> {
    const [byStatus, totals, oldestPending, holders, arrivals] = await Promise.all([
      this.events.aggregate<{ _id: EventStatus; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.events.aggregate<{
        postsAccepted: number;
        retried: number;
        highestAttempts: number;
      }>([
        {
          $group: {
            _id: null,
            postsAccepted: { $sum: '$receivedCount' },
            retried: { $sum: { $cond: [{ $gt: ['$attempts', 1] }, 1, 0] } },
            highestAttempts: { $max: '$attempts' },
          },
        },
      ]),
      this.events
        .findOne({ status: EventStatus.Pending })
        .sort({ nextAttemptAt: 1 })
        .select({ nextAttemptAt: 1 })
        .lean(),
      this.events.aggregate<{ _id: string | null; count: number }>([
        { $match: { status: EventStatus.Processing } },
        { $group: { _id: '$lockedBy', count: { $sum: 1 } } },
      ]),
      // Reads every event, which is why /stats is for inspecting a run rather
      // than for polling. Counting the patients is the same question, so it is
      // answered from this instead of a sixth query.
      this.events.aggregate<PatientArrivals>([
        { $sort: { patientId: 1, receivedAt: 1 } },
        { $group: { _id: '$patientId', arrivals: { $push: '$ts' } } },
      ]),
    ]);

    const counts = new Map(byStatus.map((row) => [row._id, row.count]));
    const total = byStatus.reduce((sum, row) => sum + row.count, 0);
    const postsAccepted = totals[0]?.postsAccepted ?? 0;
    const oldest = oldestPending?.nextAttemptAt;

    return {
      events: {
        total,
        [EventStatus.Pending]: counts.get(EventStatus.Pending) ?? 0,
        [EventStatus.Processing]: counts.get(EventStatus.Processing) ?? 0,
        [EventStatus.Processed]: counts.get(EventStatus.Processed) ?? 0,
        [EventStatus.Failed]: counts.get(EventStatus.Failed) ?? 0,
      },
      patients: arrivals.length,
      ingest: {
        postsAccepted,
        eventsStored: total,
        duplicatesSuppressed: postsAccepted - total,
      },
      ordering: countLateArrivals(arrivals),
      retries: {
        eventsWithMoreThanOneAttempt: totals[0]?.retried ?? 0,
        highestAttempts: totals[0]?.highestAttempts ?? 0,
      },
      backlog: {
        inFlight: counts.get(EventStatus.Processing) ?? 0,
        oldestPendingAgeMs: oldest ? Date.now() - oldest.getTime() : null,
        inFlightByWorker: Object.fromEntries(
          holders.map((row) => [row._id ?? 'unknown', row.count]),
        ),
      },
    };
  }
}

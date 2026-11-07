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
    /** Events that arrived after an event of the same patient with a later ts. */
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
    /**
     * Who holds the in-flight events, keyed by worker id. Answers "is the work
     * spread across the replicas?" and, when something is stuck, which process
     * to go and look at.
     */
    inFlightByWorker: Record<string, number>;
  };
}

@Injectable()
export class StatsService {
  constructor(
    @InjectModel(PatientEvent.name) private readonly events: Model<PatientEvent>,
  ) {}

  async read(): Promise<Stats> {
    const [byStatus, ingest, ordering, retries, oldestPending, patients, holders] =
      await Promise.all([
        this.events.aggregate<{ _id: EventStatus; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        this.events.aggregate<{ postsAccepted: number; eventsStored: number }>([
          {
            $group: {
              _id: null,
              postsAccepted: { $sum: '$receivedCount' },
              eventsStored: { $sum: 1 },
            },
          },
        ]),
        this.lateArrivals(),
        this.events.aggregate<{ retried: number; highestAttempts: number }>([
          {
            $group: {
              _id: null,
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
        this.events.aggregate<{ count: number }>([
          { $group: { _id: '$patientId' } },
          { $count: 'count' },
        ]),
        this.events.aggregate<{ _id: string | null; count: number }>([
          { $match: { status: EventStatus.Processing } },
          { $group: { _id: '$lockedBy', count: { $sum: 1 } } },
        ]),
      ]);

    const counts = new Map(byStatus.map((row) => [row._id, row.count]));
    const total = byStatus.reduce((sum, row) => sum + row.count, 0);
    const postsAccepted = ingest[0]?.postsAccepted ?? 0;

    return {
      events: {
        total,
        [EventStatus.Pending]: counts.get(EventStatus.Pending) ?? 0,
        [EventStatus.Processing]: counts.get(EventStatus.Processing) ?? 0,
        [EventStatus.Processed]: counts.get(EventStatus.Processed) ?? 0,
        [EventStatus.Failed]: counts.get(EventStatus.Failed) ?? 0,
      },
      patients: patients[0]?.count ?? 0,
      ingest: {
        postsAccepted,
        eventsStored: total,
        duplicatesSuppressed: postsAccepted - total,
      },
      ordering,
      retries: {
        eventsWithMoreThanOneAttempt: retries[0]?.retried ?? 0,
        highestAttempts: retries[0]?.highestAttempts ?? 0,
      },
      backlog: {
        inFlight: counts.get(EventStatus.Processing) ?? 0,
        oldestPendingAgeMs: oldestPending
          ? Date.now() - oldestPending.nextAttemptAt.getTime()
          : null,
        inFlightByWorker: Object.fromEntries(
          holders.map((row) => [row._id ?? 'unknown', row.count]),
        ),
      },
    };
  }

  /**
   * Walks each patient's events in arrival order and counts the ones whose ts
   * is older than a ts already seen. This is the number that shows the senders
   * really did deliver out of order, which is what makes the ordering
   * guarantee worth anything -- a load test that happened to arrive in order
   * would prove nothing.
   */
  private async lateArrivals(): Promise<{ lateArrivals: number; patientsAffected: number }> {
    const [row] = await this.events.aggregate<{
      lateArrivals: number;
      patientsAffected: number;
    }>([
      { $sort: { patientId: 1, receivedAt: 1 } },
      { $group: { _id: '$patientId', arrivals: { $push: '$ts' } } },
      {
        $project: {
          late: {
            $reduce: {
              input: '$arrivals',
              initialValue: { newest: null, late: 0 },
              in: {
                newest: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ['$$value.newest', null] },
                        { $gt: ['$$this', '$$value.newest'] },
                      ],
                    },
                    '$$this',
                    '$$value.newest',
                  ],
                },
                late: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ['$$value.newest', null] },
                        { $lt: ['$$this', '$$value.newest'] },
                      ],
                    },
                    { $add: ['$$value.late', 1] },
                    '$$value.late',
                  ],
                },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          lateArrivals: { $sum: '$late.late' },
          patientsAffected: { $sum: { $cond: [{ $gt: ['$late.late', 0] }, 1, 0] } },
        },
      },
    ]);

    return {
      lateArrivals: row?.lateArrivals ?? 0,
      patientsAffected: row?.patientsAffected ?? 0,
    };
  }
}

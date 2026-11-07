import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Env } from '../config/env';
import { EventStatus, PatientEvent } from '../events/event.schema';
import { isDuplicateKeyError } from '../events/mongo-errors';

export interface ClaimedEvent {
  id: Types.ObjectId;
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: Date;
  attempts: number;
  /** Captured at claim time; every later write is conditioned on it. */
  lockVersion: number;
}

export type WriteBack = 'written' | 'retry-scheduled' | 'failed' | 'lease-lost';

/** Due events looked at per claim round, so workers do not all target one document. */
const CANDIDATE_BATCH = 20;

const MAX_BACKOFF_MS = 60_000;

/**
 * Exponential backoff with jitter. The jitter matters more than the curve: a
 * burst of events that failed together because the external system was down
 * would otherwise all come back at the same instant and knock it over again.
 */
function backoffMs(attempts: number): number {
  const ceiling = Math.min(2 ** attempts * 1000, MAX_BACKOFF_MS);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

@Injectable()
export class EventQueue {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    @InjectModel(PatientEvent.name) private readonly events: Model<PatientEvent>,
    config: ConfigService<Env, true>,
  ) {
    this.leaseMs = config.get('LEASE_MS', { infer: true });
    this.maxAttempts = config.get('MAX_ATTEMPTS', { infer: true });
  }

  async claim(workerId: string): Promise<ClaimedEvent | null> {
    const now = new Date();

    // Excluded here rather than left to fail on the index. Candidates are
    // ordered by nextAttemptAt, so one patient with a backlog larger than the
    // window would own all of it and starve the rest: measured at 200 queued
    // events, an unrelated event waited for 181 of them to drain.
    const busy = await this.events.distinct('patientId', {
      status: EventStatus.Processing,
    });

    const candidates = await this.events
      .find({
        status: EventStatus.Pending,
        nextAttemptAt: { $lte: now },
        patientId: { $nin: busy },
      })
      .sort({ nextAttemptAt: 1 })
      .limit(CANDIDATE_BATCH)
      .select({ _id: 1 })
      .lean();

    if (candidates.length === 0) {
      return null;
    }

    // Every worker reads the same candidates in the same order. Starting at a
    // random offset stops them from all fighting over the head of the queue.
    const offset = Math.floor(Math.random() * candidates.length);

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[(offset + i) % candidates.length];
      const claimed = await this.tryClaim(candidate._id, workerId, now);
      if (claimed) {
        return claimed;
      }
    }

    return null;
  }

  private async tryClaim(
    id: Types.ObjectId,
    workerId: string,
    now: Date,
  ): Promise<ClaimedEvent | null> {
    try {
      const doc = await this.events
        .findOneAndUpdate(
          { _id: id, status: EventStatus.Pending },
          {
            $set: {
              status: EventStatus.Processing,
              lockedBy: workerId,
              lockedUntil: new Date(now.getTime() + this.leaseMs),
            },
            $inc: { lockVersion: 1 },
          },
          { returnDocument: 'after' },
        )
        .lean();

      if (!doc) {
        // Another worker claimed it between the read and this update.
        return null;
      }

      return {
        id: doc._id,
        patientId: doc.patientId,
        type: doc.type,
        data: doc.data,
        ts: doc.ts,
        attempts: doc.attempts,
        lockVersion: doc.lockVersion,
      };
    } catch (error) {
      // The patient became busy between reading the busy set and this update.
      // Rare, but the index is where the guarantee lives, not the filter.
      if (isDuplicateKeyError(error)) {
        return null;
      }
      throw error;
    }
  }

  async recordSuccess(
    claim: ClaimedEvent,
    result: Record<string, unknown>,
  ): Promise<WriteBack> {
    const updated = await this.events.updateOne(
      { _id: claim.id, lockVersion: claim.lockVersion },
      {
        $set: {
          status: EventStatus.Processed,
          result,
          attempts: claim.attempts + 1,
          lockedBy: null,
          lockedUntil: null,
          lastError: null,
        },
      },
    );

    return updated.matchedCount === 1 ? 'written' : 'lease-lost';
  }

  async recordFailure(claim: ClaimedEvent, error: Error): Promise<WriteBack> {
    const attempts = claim.attempts + 1;
    const exhausted = attempts >= this.maxAttempts;
    const lastError = { message: error.message, at: new Date() };

    const update = exhausted
      ? {
          status: EventStatus.Failed,
          attempts,
          lastError,
          lockedBy: null,
          lockedUntil: null,
        }
      : {
          status: EventStatus.Pending,
          attempts,
          lastError,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
          lockedBy: null,
          lockedUntil: null,
        };

    const updated = await this.events.updateOne(
      { _id: claim.id, lockVersion: claim.lockVersion },
      { $set: update },
    );

    if (updated.matchedCount !== 1) {
      return 'lease-lost';
    }
    return exhausted ? 'failed' : 'retry-scheduled';
  }
}

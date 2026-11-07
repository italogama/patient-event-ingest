import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Env } from '../config/env';
import { EventStatus, PatientEvent } from '../events/event.schema';

const EXPIRED_LEASE = 'lease expired: the worker holding this event never reported back';

/**
 * Returns events whose worker died mid-call to the queue. A graceful shutdown
 * drains and needs none of this; this is for SIGKILL, OOM, a node vanishing.
 *
 * Sweeping back to pending rather than reclaiming inside the claim query keeps
 * one kind of claimable work instead of two.
 */
@Injectable()
export class LeaseReaper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LeaseReaper.name);
  private readonly maxAttempts: number;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @InjectModel(PatientEvent.name) private readonly events: Model<PatientEvent>,
    config: ConfigService<Env, true>,
  ) {
    this.maxAttempts = config.get('MAX_ATTEMPTS', { infer: true });
    // Derived from the lease, not configured separately: sweeping far more often
    // is wasted work, far less often adds the interval to every recovery.
    this.intervalMs = Math.max(1000, Math.floor(config.get('LEASE_MS', { infer: true }) / 3));
  }

  async onApplicationBootstrap(): Promise<void> {
    // A deploy that SIGKILLed the previous process left work behind; it should
    // not wait a full interval.
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async sweep(): Promise<{ requeued: number; failed: number }> {
    if (this.sweeping) {
      return { requeued: 0, failed: 0 };
    }
    this.sweeping = true;

    try {
      const now = new Date();
      const expired = {
        status: EventStatus.Processing,
        lockedUntil: { $lte: now },
      };
      const lastError = { message: EXPIRED_LEASE, at: now };

      // Exhausted first: requeueing first would grant one attempt more than
      // MAX_ATTEMPTS allows.
      //
      // The attempt is counted even though the worker may have died for an
      // unrelated reason. An event that kills whichever worker picks it up
      // would otherwise be retried for ever, taking down every replica in turn.
      const failed = await this.events.updateMany(
        { ...expired, attempts: { $gte: this.maxAttempts - 1 } },
        {
          $set: {
            status: EventStatus.Failed,
            lockedBy: null,
            lockedUntil: null,
            lastError,
          },
          $inc: { attempts: 1 },
        },
      );

      const requeued = await this.events.updateMany(
        { ...expired, attempts: { $lt: this.maxAttempts - 1 } },
        {
          $set: {
            status: EventStatus.Pending,
            lockedBy: null,
            lockedUntil: null,
            nextAttemptAt: now,
            lastError,
          },
          $inc: { attempts: 1 },
        },
      );

      // lockVersion is deliberately not incremented. A worker that was merely
      // slow still matches, and records the result it really obtained. Once
      // another worker claims the event the version moves and it is fenced out.

      if (failed.modifiedCount > 0 || requeued.modifiedCount > 0) {
        this.logger.warn(
          `swept expired leases: ${requeued.modifiedCount} requeued, ${failed.modifiedCount} moved to failed`,
        );
      }

      return { requeued: requeued.modifiedCount, failed: failed.modifiedCount };
    } catch (error) {
      // Not fatal: the next sweep finds the same events. Not silent either,
      // because while it keeps failing nothing recovers from a dead worker.
      this.logger.error(
        'lease sweep failed',
        error instanceof Error ? error.stack : String(error),
      );
      return { requeued: 0, failed: 0 };
    } finally {
      this.sweeping = false;
    }
  }
}

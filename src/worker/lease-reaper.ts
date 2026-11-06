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
 * Returns events whose worker died mid-call to the queue.
 *
 * A graceful shutdown drains and needs none of this. This is for the other
 * case: SIGKILL, OOM, a node disappearing. The lease is what makes that
 * recoverable without a human, and this is what acts on the expiry.
 *
 * Sweeping back to pending, rather than reclaiming in the claim path, keeps
 * the claim query to a single shape: there is only one kind of claimable work.
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
    // Derived from the lease rather than configured separately: sweeping much
    // more often than the lease expires is wasted work, and much less often
    // adds the sweep interval to every recovery.
    this.intervalMs = Math.max(1000, Math.floor(config.get('LEASE_MS', { infer: true }) / 3));
  }

  async onApplicationBootstrap(): Promise<void> {
    // Sweep once at startup: a deploy that SIGKILLed the previous process
    // leaves work behind, and it should not wait a full interval.
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

      // Exhausted first. Running the requeue first would give these events one
      // more attempt than MAX_ATTEMPTS allows.
      //
      // The attempt is counted even though the worker may have died for an
      // unrelated reason, such as a deploy. That is deliberate: an event that
      // crashes whichever worker picks it up would otherwise be retried for
      // ever and take down every replica in turn.
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

      // lockVersion is deliberately not incremented here. If the original
      // worker is actually alive and finishes after the sweep, its write still
      // matches and records the result it really obtained. Once another worker
      // claims the event the version moves and the latecomer is fenced out, as
      // it would be in any other case.

      if (failed.modifiedCount > 0 || requeued.modifiedCount > 0) {
        this.logger.warn(
          `swept expired leases: ${requeued.modifiedCount} requeued, ${failed.modifiedCount} moved to failed`,
        );
      }

      return { requeued: requeued.modifiedCount, failed: failed.modifiedCount };
    } catch (error) {
      // A failed sweep is not fatal: the next one will find the same events.
      // It must not be silent, though, because while it keeps failing nothing
      // recovers from a crashed worker.
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

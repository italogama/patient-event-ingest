import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

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
import { PatientEvent } from '../events/event.schema';
import { EventProcessor } from './event-processor';
import { EventQueue } from './event-queue';

/** Poll interval while the queue is empty. Doubles up to the maximum. */
const IDLE_MIN_MS = 100;
const IDLE_MAX_MS = 2000;

/**
 * Keeps a bounded number of events in flight. The work is a slow network call,
 * so holding dozens costs one pending promise each, not one thread each.
 */
@Injectable()
export class WorkerLoop implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerLoop.name);
  private readonly workerId = `${hostname()}:${process.pid}`;
  private readonly concurrency: number;
  private readonly inFlight = new Set<Promise<void>>();
  private running = false;
  private loopFinished: Promise<void> = Promise.resolve();

  constructor(
    @InjectModel(PatientEvent.name) private readonly events: Model<PatientEvent>,
    private readonly queue: EventQueue,
    private readonly processor: EventProcessor,
    config: ConfigService<Env, true>,
  ) {
    this.concurrency = config.get('WORKER_CONCURRENCY', { infer: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    // Claiming before the partial unique index exists would let two workers
    // handle the same patient at once.
    await this.events.init();

    this.running = true;
    this.loopFinished = this.run();
    this.logger.log(`worker ${this.workerId} started, concurrency ${this.concurrency}`);
  }

  /**
   * Stop claiming and let what is in flight finish; the leases stay valid
   * throughout, so nothing is handed over mid-call. SIGKILL skips all of this,
   * which is what the lease is for.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.logger.log(
      `${signal ?? 'shutdown'}: draining ${this.inFlight.size} event(s) in flight`,
    );
    await this.loopFinished;
    await Promise.allSettled([...this.inFlight]);
    this.logger.log('drained');
  }

  private async run(): Promise<void> {
    let idleMs = IDLE_MIN_MS;

    while (this.running) {
      if (this.inFlight.size >= this.concurrency) {
        await Promise.race(this.inFlight).catch(() => undefined);
        continue;
      }

      const claim = await this.queue.claim(this.workerId).catch((error: unknown) => {
        this.logger.error(
          'claim failed',
          error instanceof Error ? error.stack : String(error),
        );
        return null;
      });

      if (!claim) {
        // Jittered: a fixed interval wakes every replica at the same instant.
        await delay(idleMs / 2 + Math.random() * (idleMs / 2));
        idleMs = Math.min(idleMs * 2, IDLE_MAX_MS);
        continue;
      }

      idleMs = IDLE_MIN_MS;

      const task: Promise<void> = this.processor
        .process(claim)
        .finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }
  }
}

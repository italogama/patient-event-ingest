import { setTimeout as delay } from 'node:timers/promises';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Env } from '../config/env';
import { ClaimedEvent } from './event-queue';

export class ExternalSystemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalSystemError';
  }
}

/**
 * Stands in for the slow third-party system. Only the timing is real: the
 * assignment states the processing logic itself is irrelevant.
 *
 * The call is deliberately independent of the patient's current state. That is
 * what makes a late-arriving event cheap: it changes the order the results are
 * folded in, but it does not invalidate the result of any other event.
 */
@Injectable()
export class ExternalSystem {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async enrich(event: ClaimedEvent): Promise<Record<string, unknown>> {
    const startedAt = Date.now();

    await delay(this.config.get('EXTERNAL_PROCESSING_MS', { infer: true }));

    if (Math.random() < this.config.get('EXTERNAL_FAILURE_RATE', { infer: true })) {
      throw new ExternalSystemError(`external system rejected event ${event.id.toString()}`);
    }

    return {
      normalized: event.data,
      latencyMs: Date.now() - startedAt,
    };
  }
}

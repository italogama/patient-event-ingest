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
 * Stands in for the slow third-party system; only the timing is real.
 *
 * Deliberately independent of the patient's current state, which is what makes
 * a late event cheap: it changes the fold order, invalidating no other result.
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

// class-transformer reads the decorator metadata that only this shim provides.
// Every other test file gets it for free by importing something from Nest; this
// one touches validateEnv alone, so it has to ask for it.
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateEnv } from '../src/config/env';

const MONGO_URL = 'mongodb://localhost:27017/ingest?directConnection=true';

describe('validateEnv', () => {
  it('fills in the defaults when only the required variable is set', () => {
    const env = validateEnv({ MONGO_URL });

    assert.equal(env.PORT, 3000);
    assert.equal(env.WORKER_CONCURRENCY, 50);
    assert.equal(env.LEASE_MS, 30_000);
    assert.equal(env.EXTERNAL_PROCESSING_MS, 5000);
  });

  it('converts the strings that process.env always hands over', () => {
    const env = validateEnv({ MONGO_URL, PORT: '8080', LEASE_MS: '20000' });

    assert.equal(env.PORT, 8080);
    assert.equal(env.LEASE_MS, 20_000);
  });

  it('refuses to start without a connection string', () => {
    assert.throws(() => validateEnv({}), /MONGO_URL/);
  });

  it('refuses a lease shorter than twice the call it covers', () => {
    // The failure this prevents is silent: the lease expires while the call is
    // still running, the sweep requeues the event, another worker starts a
    // second call, and only a log warning says so.
    assert.throws(
      () => validateEnv({ MONGO_URL, EXTERNAL_PROCESSING_MS: '8000', LEASE_MS: '4000' }),
      /LEASE_MS: must be at least 2x EXTERNAL_PROCESSING_MS \(16000\), got 4000/,
    );
  });

  it('accepts a lease exactly at the limit', () => {
    const env = validateEnv({ MONGO_URL, EXTERNAL_PROCESSING_MS: '5000', LEASE_MS: '10000' });

    assert.equal(env.LEASE_MS, 10_000);
  });

  it('rejects the default lease against a call slower than half of it', () => {
    // Raising EXTERNAL_PROCESSING_MS to simulate a slower system, and leaving
    // LEASE_MS alone, is the realistic way into this.
    assert.throws(
      () => validateEnv({ MONGO_URL, EXTERNAL_PROCESSING_MS: '20000' }),
      /must be at least 2x/,
    );
  });

  it('reports the field errors rather than the relationship when a value is not a number', () => {
    // Comparing against a NaN would produce a nonsense message about the lease.
    assert.throws(
      () => validateEnv({ MONGO_URL, LEASE_MS: 'soon' }),
      (error: Error) => /LEASE_MS/.test(error.message) && !/must be at least/.test(error.message),
    );
  });

  it('names every failing variable at once', () => {
    const error = (() => {
      try {
        validateEnv({ PORT: '0', EXTERNAL_FAILURE_RATE: '2' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    assert.ok(error);
    assert.match(error.message, /MONGO_URL/);
    assert.match(error.message, /PORT/);
    assert.match(error.message, /EXTERNAL_FAILURE_RATE/);
  });
});

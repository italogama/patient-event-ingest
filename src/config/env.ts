import { plainToInstance } from 'class-transformer';
import { IsInt, IsNumber, IsString, Max, Min, validateSync } from 'class-validator';

/**
 * Every environment variable the service reads. Validated at boot so a missing
 * or malformed value kills the process immediately, instead of surfacing much
 * later as a connection error on the first request.
 */
export class Env {
  @IsString()
  MONGO_URL!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  /** Bounded so draining a backlog cannot open thousands of external calls at once. */
  @IsInt()
  @Min(1)
  @Max(1000)
  WORKER_CONCURRENCY: number = 50;

  /** Too short steals work from a slow worker; too long hides a dead one's events. */
  @IsInt()
  @Min(1000)
  LEASE_MS: number = 30_000;

  /** Attempts before an event reaches the terminal failed state. */
  @IsInt()
  @Min(1)
  @Max(20)
  MAX_ATTEMPTS: number = 5;

  /** The 5 seconds the assignment asks us to simulate. */
  @IsInt()
  @Min(0)
  EXTERNAL_PROCESSING_MS: number = 5000;

  /** Fraction of external calls that fail. A knob for exercising the retry path by hand. */
  @IsNumber()
  @Min(0)
  @Max(1)
  EXTERNAL_FAILURE_RATE: number = 0;
}

/**
 * How much longer than one attempt a lease has to last. A lease shorter than
 * the call it covers expires while that call is still running, so the sweep
 * requeues the event, another worker starts a second call, and the first is
 * fenced out when it returns. The external system then gets one call per
 * attempt for every event, and nothing reports it but a warning in the log.
 *
 * Two is a guard against a typo, not a sizing rule: it still takes a 100%
 * overshoot to lose a lease. The production rule is that a lease outlasts the
 * p99 of a whole attempt, which is not a multiple of a configured constant.
 */
const MIN_LEASE_FACTOR = 2;

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, {
    // process.env values are always strings; the numeric settings need converting
    // before they can be validated as numbers.
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  // whitelist drops everything else in the environment: nothing can read a
  // setting that is not declared above.
  const problems = validateSync(env, { whitelist: true }).map(
    (e) => `  ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
  );

  // Only worth checking once both values are known to be numbers; otherwise the
  // message would compare against a NaN.
  const minLease = env.EXTERNAL_PROCESSING_MS * MIN_LEASE_FACTOR;
  if (problems.length === 0 && env.LEASE_MS < minLease) {
    problems.push(
      `  LEASE_MS: must be at least ${MIN_LEASE_FACTOR}x EXTERNAL_PROCESSING_MS ` +
        `(${minLease}), got ${env.LEASE_MS}. A lease that expires while the call it ` +
        `covers is still running makes every event reach the external system once ` +
        `per attempt.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }

  return env;
}

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

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, {
    // process.env values are always strings; the numeric settings need converting
    // before they can be validated as numbers.
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  // whitelist drops everything else in the environment: nothing can read a
  // setting that is not declared above.
  const errors = validateSync(env, { whitelist: true });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `  ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return env;
}

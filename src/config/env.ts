import { plainToInstance } from 'class-transformer';
import { IsInt, IsString, Max, Min, validateSync } from 'class-validator';

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
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, {
    // process.env values are always strings; PORT has to become a number.
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  // whitelist drops every other variable in the environment, so the rest of
  // the application can only read what is declared above.
  const errors = validateSync(env, { whitelist: true });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `  ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return env;
}

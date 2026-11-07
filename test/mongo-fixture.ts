import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';

import { validateEnv } from '../src/config/env';
import { PatientEvent, PatientEventSchema } from '../src/events/event.schema';

const DEFAULT_URL = 'mongodb://localhost:27017/ingest?directConnection=true';

/**
 * Each file gets its own database on the same server, so a test that expects to
 * be alone in the queue is not disturbed by another file's inserts.
 */
function databaseUrl(name: string): string {
  const url = new URL(process.env.MONGO_URL ?? DEFAULT_URL);
  url.pathname = `/ingest_test_${name}`;
  return url.toString();
}

export interface MongoContext {
  events: Model<PatientEvent>;
  /** Resolves the real providers, constructed by Nest with the real config. */
  get<T>(token: unknown): T;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boots the given providers against a real MongoDB with real configuration.
 *
 * compile() rather than init(): lifecycle hooks stay unrun, so the worker loop
 * never starts and the reaper's timer never fires. Every test drives claim,
 * process and sweep explicitly, which is the difference between asserting on a
 * known state and racing a background pump.
 */
export async function createMongoContext(
  name: string,
  providers: unknown[],
  env: Record<string, string> = {},
): Promise<MongoContext> {
  const uri = databaseUrl(name);

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        validate: (raw: Record<string, unknown>) =>
          validateEnv({ ...raw, ...env, MONGO_URL: uri }),
      }),
      MongooseModule.forRoot(uri, { writeConcern: { w: 'majority', journal: true } }),
      MongooseModule.forFeature([{ name: PatientEvent.name, schema: PatientEventSchema }]),
    ],
    providers: providers as never[],
  }).compile();

  const events = moduleRef.get<Model<PatientEvent>>(getModelToken(PatientEvent.name));
  const connection = moduleRef.get<Connection>(getConnectionToken());

  // The unique indexes are the thing most of these tests are about. Mongoose
  // builds them in the background, so asserting before they exist would test
  // a collection without the guarantee under test.
  await events.init();

  return {
    events,
    get: <T>(token: unknown) => moduleRef.get<T>(token as never),
    clear: async () => {
      await events.deleteMany({});
    },
    close: async () => {
      await connection.dropDatabase();
      await moduleRef.close();
    },
  };
}

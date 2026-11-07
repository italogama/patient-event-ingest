import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker/worker.module';

/** Worker entrypoint: the DI container with no HTTP server, so no port is opened. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // Without this, SIGTERM kills the process outright and every event in flight
  // waits out its full lease before another worker can pick it up.
  app.enableShutdownHooks();
}

void bootstrap();

import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker/worker.module';

/**
 * The worker entrypoint. createApplicationContext starts the dependency
 * injection container without an HTTP server: this process listens on no port
 * and answers no requests, it only pulls work from the collection.
 *
 * It is a separate process from the API so the two scale on different signals:
 * the API with incoming traffic, the worker with the size of the backlog.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // Without this, SIGTERM kills the process outright and every event in flight
  // waits out its full lease before another worker can pick it up.
  app.enableShutdownHooks();
}

void bootstrap();

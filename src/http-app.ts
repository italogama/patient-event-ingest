import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Request-handling setup, applied by the entrypoint and by the HTTP tests. The
 * validation rules are part of the contract with the senders, so the tests have
 * to exercise the same ones the service runs with.
 */
export function configureHttpApp(app: NestExpressApplication): void {
  // An event payload is small. Accepting unbounded bodies at 1000 req/min is a
  // memory risk, and anything near Mongo's 16MB document limit is a bug anyway.
  app.useBodyParser('json', { limit: '100kb' });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip fields outside the documented contract instead of rejecting them:
      // a 400 makes a third-party sender drop the event rather than retry.
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );
}

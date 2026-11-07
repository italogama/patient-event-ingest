import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Applied by the entrypoint and by the HTTP tests: the validation rules are the
 * contract with the senders, so the tests must exercise the real ones.
 */
export function configureHttpApp(app: NestExpressApplication): void {
  // An event is small; anything near Mongo's 16MB document limit is a bug.
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

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { Env, validateEnv } from './config/env';

/**
 * Configuration and the database connection. Shared by both entrypoints: the
 * API process and the worker process run the same code against the same
 * collection, they just do different halves of the job.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGO_URL', { infer: true }),
        // An acknowledged write has to survive the loss of the node that
        // accepted it. With w:1 a failover can roll the write back after we
        // already told the sender we stored the event.
        writeConcern: { w: 'majority', journal: true },
      }),
    }),
  ],
  exports: [MongooseModule],
})
export class CoreModule {}

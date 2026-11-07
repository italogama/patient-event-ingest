import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { Env, validateEnv } from './config/env';

/** Configuration and the database connection, shared by both entrypoints. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGO_URL', { infer: true }),
        // With w:1 a failover can roll a write back after we already answered
        // 202, so the sender believes we stored an event we lost.
        writeConcern: { w: 'majority', journal: true },
      }),
    }),
  ],
  exports: [MongooseModule],
})
export class CoreModule {}

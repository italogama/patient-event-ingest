import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { Env, validateEnv } from './config/env';
import { HealthController } from './health.controller';

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
  controllers: [HealthController],
})
export class AppModule {}

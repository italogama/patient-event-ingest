import { Module } from '@nestjs/common';

import { CoreModule } from './core.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';

@Module({
  imports: [CoreModule, EventsModule],
  controllers: [HealthController],
})
export class AppModule {}

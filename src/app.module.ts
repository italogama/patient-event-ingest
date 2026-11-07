import { Module } from '@nestjs/common';

import { CoreModule } from './core.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { PatientsModule } from './patients/patients.module';
import { StatsModule } from './stats/stats.module';

@Module({
  imports: [CoreModule, EventsModule, PatientsModule, StatsModule],
  controllers: [HealthController],
})
export class AppModule {}

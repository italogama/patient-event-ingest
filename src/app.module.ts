import { Module } from '@nestjs/common';

import { CoreModule } from './core.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { PatientsModule } from './patients/patients.module';

@Module({
  imports: [CoreModule, EventsModule, PatientsModule],
  controllers: [HealthController],
})
export class AppModule {}

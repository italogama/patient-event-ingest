import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CoreModule } from '../core.module';
import { PatientEvent, PatientEventSchema } from '../events/event.schema';
import { EventProcessor } from './event-processor';
import { EventQueue } from './event-queue';
import { ExternalSystem } from './external-system';
import { WorkerLoop } from './worker-loop';

@Module({
  imports: [
    CoreModule,
    MongooseModule.forFeature([{ name: PatientEvent.name, schema: PatientEventSchema }]),
  ],
  providers: [EventQueue, ExternalSystem, EventProcessor, WorkerLoop],
})
export class WorkerModule {}

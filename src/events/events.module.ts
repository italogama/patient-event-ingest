import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { EventIngestService } from './event-ingest.service';
import { PatientEvent, PatientEventSchema } from './event.schema';
import { EventsController } from './events.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PatientEvent.name, schema: PatientEventSchema }]),
  ],
  controllers: [EventsController],
  providers: [EventIngestService],
})
export class EventsModule {}

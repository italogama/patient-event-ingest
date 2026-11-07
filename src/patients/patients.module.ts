import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PatientEvent, PatientEventSchema } from '../events/event.schema';
import { PatientStateService } from './patient-state.service';
import { PatientsController } from './patients.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PatientEvent.name, schema: PatientEventSchema }]),
  ],
  controllers: [PatientsController],
  providers: [PatientStateService],
})
export class PatientsModule {}

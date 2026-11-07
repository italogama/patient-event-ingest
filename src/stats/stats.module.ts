import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PatientEvent, PatientEventSchema } from '../events/event.schema';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PatientEvent.name, schema: PatientEventSchema }]),
  ],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}

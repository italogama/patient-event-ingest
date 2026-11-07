import { Controller, Get, Param } from '@nestjs/common';

import { PatientStateResponse, PatientStateService } from './patient-state.service';

@Controller('patients')
export class PatientsController {
  constructor(private readonly state: PatientStateService) {}

  @Get(':patientId/state')
  read(@Param('patientId') patientId: string): Promise<PatientStateResponse> {
    return this.state.read(patientId);
  }
}

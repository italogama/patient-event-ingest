import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { EventIngestService, IngestResult } from './event-ingest.service';
import { IngestEventDto } from './ingest-event.dto';

@Controller('events')
export class EventsController {
  constructor(private readonly ingest: EventIngestService) {}

  /**
   * 202, not 201: stored durably, nothing processed yet. A replay answers 202
   * too, because a different status code would make a sender we do not control
   * read its own successful retry as a failure.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() dto: IngestEventDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<IngestResult> {
    return this.ingest.ingest(dto, idempotencyKey?.trim() || undefined);
  }
}

import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { EventIngestService, IngestResult } from './event-ingest.service';
import { IngestEventDto } from './ingest-event.dto';

@Controller('events')
export class EventsController {
  constructor(private readonly ingest: EventIngestService) {}

  /**
   * 202, not 201: the event is stored durably but nothing has been processed
   * yet. The sender does not wait, and must not read processing state here.
   *
   * A replay answers 202 with the same body shape and the same eventId as the
   * first attempt, with duplicate: true. A different status code would make a
   * sender we do not control treat a successful retry as a failure.
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

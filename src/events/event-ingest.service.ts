import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EventStatus, PatientEvent } from './event.schema';
import { clientKey, contentKey } from './idempotency-key';
import { IngestEventDto } from './ingest-event.dto';

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
}

const DUPLICATE_KEY_ERROR = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR
  );
}

@Injectable()
export class EventIngestService implements OnModuleInit {
  private readonly logger = new Logger(EventIngestService.name);

  constructor(
    @InjectModel(PatientEvent.name) private readonly events: Model<PatientEvent>,
  ) {}

  async onModuleInit(): Promise<void> {
    // The unique index is the idempotency guarantee. Mongoose builds indexes in
    // the background, so without waiting here the service could accept traffic
    // for a few seconds with no index and store duplicates with no error.
    await this.events.init();
  }

  async ingest(dto: IngestEventDto, suppliedKey?: string): Promise<IngestResult> {
    const ts = new Date(dto.ts);
    const idempotencyKey = suppliedKey
      ? clientKey(suppliedKey)
      : contentKey({ patientId: dto.patientId, type: dto.type, ts, data: dto.data });

    try {
      // One round trip, atomic, and it returns the document either way: the one
      // we just inserted, or the one that was already there. A findOne followed
      // by an insert would let two concurrent retries both pass the read.
      const result = await this.events.findOneAndUpdate(
        { idempotencyKey },
        {
          $setOnInsert: {
            idempotencyKey,
            patientId: dto.patientId,
            type: dto.type,
            data: dto.data,
            ts,
            receivedAt: new Date(),
            status: EventStatus.Pending,
          },
        },
        { upsert: true, returnDocument: 'after', includeResultMetadata: true },
      );

      if (!result.value) {
        throw new Error(`upsert returned no document for ${idempotencyKey}`);
      }

      return {
        eventId: result.value._id.toString(),
        duplicate: result.lastErrorObject?.updatedExisting === true,
      };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      // Mongo does not serialise upserts: two concurrent requests for the same
      // key can both match nothing and both attempt the insert. One wins, the
      // other lands here and reads what the winner wrote.
      const existing = await this.events.findOne({ idempotencyKey }).lean();
      if (!existing) {
        // A duplicate-key error with no document behind it means the conflict
        // was on a different unique index. Surfacing it is the point.
        throw error;
      }

      this.logger.debug(`concurrent insert for ${idempotencyKey}, reusing winner`);
      return { eventId: existing._id.toString(), duplicate: true };
    }
  }
}

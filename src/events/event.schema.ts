import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export enum EventStatus {
  Pending = 'pending',
  Processing = 'processing',
  Processed = 'processed',
  Failed = 'failed',
}

export interface EventFailure {
  message: string;
  at: Date;
}

/**
 * The one collection. It is the record of the event, the queue the workers pull
 * from, and the place the processing outcome is written.
 */
@Schema({ collection: 'events', versionKey: false })
export class PatientEvent {
  /**
   * What makes two requests "the same event". The unique index on this field is
   * the idempotency guarantee itself, not the application logic around it.
   */
  @Prop({ required: true, unique: true })
  idempotencyKey!: string;

  @Prop({ required: true })
  patientId!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  data!: Record<string, unknown>;

  /** Clinical time, as reported by the sender. This is what orders a patient's events. */
  @Prop({ required: true })
  ts!: Date;

  /** Our clock. Never used for ordering; it is how we observe sender behaviour. */
  @Prop({ required: true })
  receivedAt!: Date;

  @Prop({ required: true, enum: EventStatus })
  status!: EventStatus;

  @Prop({ required: true })
  attempts!: number;

  /** When the event becomes claimable. Moved forward by the retry backoff. */
  @Prop({ required: true })
  nextAttemptAt!: Date;

  /** Lease expiry. Non-null only while a worker holds the event. */
  @Prop({ type: Date, default: null })
  lockedUntil!: Date | null;

  /** Which worker holds it. Not used for correctness; it is for reading logs. */
  @Prop({ type: String, default: null })
  lockedBy!: string | null;

  /**
   * Incremented on every claim. A worker captures the value when it claims and
   * conditions its final write on it, so a worker whose lease expired mid-call
   * cannot overwrite the result of the worker that took the event over. Without
   * this the lease would be a lock that the loser does not know it has lost.
   */
  @Prop({ required: true })
  lockVersion!: number;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  result!: Record<string, unknown> | null;

  /** Why the last attempt failed. Kept on retry and on the terminal failure. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  lastError!: EventFailure | null;
}

export type PatientEventDocument = HydratedDocument<PatientEvent>;

export const PatientEventSchema = SchemaFactory.createForClass(PatientEvent);

// Claiming: find the due work, oldest deadline first.
PatientEventSchema.index({ status: 1, nextAttemptAt: 1 });

// Sweeping: find leases that outlived the worker holding them.
PatientEventSchema.index({ status: 1, lockedUntil: 1 });

// At most one event per patient in flight. The index does the serialising:
// a second concurrent claim for the same patient is rejected by the server
// with a duplicate-key error, so no lock table and no list of busy patients.
PatientEventSchema.index(
  { patientId: 1 },
  { unique: true, partialFilterExpression: { status: EventStatus.Processing } },
);

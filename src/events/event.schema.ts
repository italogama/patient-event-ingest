import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export enum EventStatus {
  Pending = 'pending',
  Processing = 'processing',
  Processed = 'processed',
  Failed = 'failed',
}

/**
 * The one collection. It is the record of the event, the queue the workers pull
 * from, and the place the processing outcome is written.
 */
@Schema({ collection: 'events', versionKey: false })
export class PatientEvent {
  /**
   * What makes two requests "the same event". The unique index on this field is
   * the idempotency guarantee itself: not the application logic around it.
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
}

export type PatientEventDocument = HydratedDocument<PatientEvent>;

export const PatientEventSchema = SchemaFactory.createForClass(PatientEvent);

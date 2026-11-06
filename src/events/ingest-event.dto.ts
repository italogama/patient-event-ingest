import { IsISO8601, IsObject, IsString, Length } from 'class-validator';

export class IngestEventDto {
  @IsString()
  @Length(1, 200)
  patientId!: string;

  /**
   * Deliberately not restricted to the types the state fold understands.
   * Rejecting an unknown type with 400 tells a third-party sender the request
   * was its fault, so it will not retry, and the clinical event is gone. We
   * store every type and let the fold skip the ones it does not know.
   */
  @IsString()
  @Length(1, 100)
  type!: string;

  @IsObject()
  data!: Record<string, unknown>;

  /**
   * Kept as the string the sender sent so the wire format is validated as
   * ISO8601, rather than accepting whatever `new Date()` happens to parse.
   */
  @IsISO8601({ strict: true })
  ts!: string;
}

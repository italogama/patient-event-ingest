import { IsISO8601, IsObject, IsString, Length } from 'class-validator';

export class IngestEventDto {
  @IsString()
  @Length(1, 200)
  patientId!: string;

  /**
   * Not restricted to the types the fold understands. A 400 tells a sender the
   * request was its fault, so it will not retry and the event is gone.
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

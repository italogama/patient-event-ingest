import { Injectable, Logger } from '@nestjs/common';

import { ClaimedEvent, EventQueue } from './event-queue';
import { ExternalSystem } from './external-system';

/** Handles one claimed event end to end. Never throws: the loop has to keep running. */
@Injectable()
export class EventProcessor {
  private readonly logger = new Logger(EventProcessor.name);

  constructor(
    private readonly queue: EventQueue,
    private readonly external: ExternalSystem,
  ) {}

  async process(claim: ClaimedEvent): Promise<void> {
    try {
      const result = await this.external.enrich(claim);
      const outcome = await this.queue.recordSuccess(claim, result);

      if (outcome === 'lease-lost') {
        // The external call already happened and cannot be undone. All we can
        // do is discard our result and say so: another worker owns the event
        // now, and the duplicated call is the at-least-once cost we accepted.
        this.logger.warn(
          `lease lost for ${claim.id.toString()} after a successful call; result discarded`,
        );
      }
    } catch (error) {
      await this.recordFailure(claim, error);
    }
  }

  private async recordFailure(claim: ClaimedEvent, error: unknown): Promise<void> {
    const failure = error instanceof Error ? error : new Error(String(error));
    const id = claim.id.toString();

    try {
      const outcome = await this.queue.recordFailure(claim, failure);

      if (outcome === 'failed') {
        // Terminal, and deliberately loud. The event is kept with its last
        // error so it stays visible and countable instead of disappearing.
        this.logger.error(
          `event ${id} failed permanently after ${claim.attempts + 1} attempts: ${failure.message}`,
        );
      } else if (outcome === 'lease-lost') {
        this.logger.warn(`lease lost for ${id} while recording a failure`);
      } else {
        this.logger.warn(`event ${id} failed, retry scheduled: ${failure.message}`);
      }
    } catch (writeError) {
      // We could not even record the failure. The lease will expire and the
      // event will be swept back to pending, so nothing is lost - but this is
      // a database problem and it has to be visible.
      this.logger.error(
        `could not record failure for ${id}; leaving it to lease expiry`,
        writeError instanceof Error ? writeError.stack : String(writeError),
      );
    }
  }
}

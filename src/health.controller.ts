import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    const db = this.connection.db;
    if (!db) {
      throw new ServiceUnavailableException('mongo connection not established');
    }

    // connection.readyState is only the last state the driver observed. A ping
    // proves the server still answers, which is what the health check is for.
    try {
      await db.admin().command({ ping: 1 });
    } catch (error) {
      // A dependency being unreachable is a 503. Letting this through would
      // surface it as a 500, which says the fault is ours.
      throw new ServiceUnavailableException(
        `mongo did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return { status: 'ok' };
  }
}

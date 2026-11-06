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
    await db.admin().command({ ping: 1 });

    return { status: 'ok' };
  }
}

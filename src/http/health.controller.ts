import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Database } from '../infra/database';

@Controller('health')
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('live') live() { return { status: 'ok' }; }

  @Get('ready')
  async ready() {
    try { await this.db.query('SELECT 1'); } catch { throw new ServiceUnavailableException('postgres unreachable'); }
    // TODO passo 3: checar o SQS (GetQueueAttributes) aqui também
    return { status: 'ok' };
  }
}
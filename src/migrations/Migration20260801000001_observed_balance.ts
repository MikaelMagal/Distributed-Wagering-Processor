import { Migration } from '@mikro-orm/migrations';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = (name: string) => readFileSync(join(__dirname, '../../db/migrations', name), 'utf8');

export class Migration20260801000001_observed_balance extends Migration {
  override async up(): Promise<void> {
    this.addSql(sql('0002_observed_balance.up.sql'));
  }
  override async down(): Promise<void> {
    this.addSql(sql('0002_observed_balance.down.sql'));
  }
}

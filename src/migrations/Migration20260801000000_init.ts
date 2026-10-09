import { Migration } from '@mikro-orm/migrations';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// O SQL vive em db/migrations/*.sql (revisável e testável com psql); aqui só orquestramos.
const sql = (name: string) => readFileSync(join(__dirname, '../../db/migrations', name), 'utf8');

export class Migration20260801000000_init extends Migration {
  override async up(): Promise<void> {
    this.addSql(sql('0001_init.up.sql'));
  }
  override async down(): Promise<void> {
    this.addSql(sql('0001_init.down.sql'));
  }
}

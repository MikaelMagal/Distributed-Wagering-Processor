import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('uso: bun scripts/migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(config);
try {
  const result = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  console.log(`migration ${direction}:`, result.map((m) => m.name).join(', ') || '(nada a fazer)');
} finally {
  await orm.close(true);
}

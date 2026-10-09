import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20260801000000_init } from './src/migrations/Migration20260801000000_init';
import { Migration20260801000001_observed_balance } from './src/migrations/Migration20260801000001_observed_balance';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering',
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    transactional: true,
    snapshot: false,
    // Registro explícito: sem descoberta por filesystem (funciona igual em Bun/Docker).
    migrationsList: [
      { name: 'Migration20260801000000_init', class: Migration20260801000000_init },
      { name: 'Migration20260801000001_observed_balance', class: Migration20260801000001_observed_balance },
    ],
  },
});

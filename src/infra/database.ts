import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../mikro-orm.config';

/** Executa SQL parametrizado (placeholders `?`) na conexão/transação corrente. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

// 40P01 = deadlock detectado, 40001 = falha de serialização: o Postgres manda repetir.
const TRANSIENT = new Set(['40P01', '40001']);

export function isUniqueViolation(err: unknown, constraints: string[]): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && !!e.constraint && constraints.includes(e.constraint);
}

export class Database {
  private constructor(private readonly orm: MikroORM) {}

  static async connect(clientUrl?: string): Promise<Database> {
    const orm = await MikroORM.init({ ...config, ...(clientUrl ? { clientUrl } : {}) });
    return new Database(orm);
  }

  /**
   * Uma transação SQL. Tudo que o callback fizer via `tx` entra no MESMO commit/rollback.
   * Em deadlock/falha de serialização repete a transação inteira (o callback precisa ser reexecutável).
   */
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>, maxAttempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional((tem) =>
          work({ query: (sql, params) => tem.execute(sql, params) as Promise<never> }),
        );
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (attempt >= maxAttempts || !code || !TRANSIENT.has(code)) throw err;
      }
    }
  }

  /** Leitura fora de transação (ex.: GET). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.orm.em.fork().execute(sql, params) as Promise<T[]>;
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}

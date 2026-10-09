import { expect } from 'bun:test';
import { OpenWalletUseCase } from '../../src/application/open-wallet';
import {
  SubmitTransactionUseCase,
  type SubmitTransactionCommand,
} from '../../src/application/submit-transaction';
import { Money } from '../../src/domain/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import type { Wallet } from '../../src/domain/wallet';
import { Database } from '../../src/infra/database';
import { newId } from '../../src/shared/ids';

export const DB_URL =
  process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering';

/** Simula N instâncias da aplicação: cada uma com o seu próprio pool de conexões. */
export async function startInstances(n: number) {
  const dbs = await Promise.all(Array.from({ length: n }, () => Database.connect(DB_URL)));
  return {
    dbs,
    submit: dbs.map((db) => new SubmitTransactionUseCase(db)),
    openWallet: new OpenWalletUseCase(dbs[0]!),
    close: () => Promise.all(dbs.map((d) => d.close())),
  };
}

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

let seq = 0;
const run = newId().slice(-8);

type Overrides = Partial<Omit<SubmitTransactionCommand, 'money'>> & { money?: string };

/** Monta um comando válido; externalTransactionId e idempotencyKey são únicos por padrão. */
export function cmd(
  wallet: Pick<Wallet, 'id' | 'playerId'>,
  o: Overrides = {},
): SubmitTransactionCommand {
  const providerId = o.providerId ?? 'prov-a';
  const externalTransactionId = o.externalTransactionId ?? `ext-${run}-${++seq}`;
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: o.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'r1',
    gameId: 'g1',
    kind: WagerTransactionKind.Bet,
    referenceExternalTransactionId: o.referenceExternalTransactionId,
    ...o,
    money: brl(o.money ?? '10.00'),
  };
}

export async function ledgerOf(db: Database, walletId: string) {
  return db.query<{
    direction: string; amount: string; balance_before: string; balance_after: string; transaction_id: string;
  }>(
    `SELECT direction, amount, balance_before, balance_after, transaction_id
       FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY id`,
    [walletId],
  );
}

export async function balanceOf(db: Database, walletId: string): Promise<string> {
  const [w] = await db.query<{ balance: string }>(`SELECT balance FROM wallets WHERE id = ?`, [walletId]);
  return w!.balance;
}

/**
 * Invariantes que valem para QUALQUER wallet, em QUALQUER cenário:
 *  - saldo materializado == soma do ledger (créditos − débitos)
 *  - version == nº de lançamentos (1 inicial + 1 por movimento; o OPENING é o 1º lançamento)
 *  - nenhum par de lançamentos parte do mesmo saldo (sinal clássico de lost update)
 */
export async function assertWalletInvariants(db: Database, walletId: string, opts: { strictDistinctBefore?: boolean } = {}) {
  const [w] = await db.query<{ balance: string; version: number }>(
    `SELECT balance, version FROM wallets WHERE id = ?`, [walletId],
  );
  const [s] = await db.query<{ net: string; n: number; distinct_before: number }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS net,
            COUNT(*)::int AS n, COUNT(DISTINCT balance_before)::int AS distinct_before
       FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId],
  );
  expect(Money.from({ amount: w!.balance, currency: 'BRL' }).equals(
    Money.from({ amount: s!.net, currency: 'BRL' }))).toBe(true);
  expect(Number(w!.version)).toBe(s!.n);
  if (opts.strictDistinctBefore) expect(s!.distinct_before).toBe(s!.n);
}

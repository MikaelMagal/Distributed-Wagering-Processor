import { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { SqlExecutor } from '../database';

interface Row {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  status: WagerTransactionStatus;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  failure_code: FailureCode | null;
  attempts: number | string;
  next_attempt_at: string | null;
  created_at: string;
  processed_at: string | null;
  observed_balance: string;
}

const COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
  player_id, round_id, game_id, kind, amount, currency, status, reference_external_transaction_id,
  reference_transaction_id, failure_code, attempts, next_attempt_at, created_at, processed_at,
  observed_balance`;

/** A transação + o saldo da wallet observado quando ela chegou ao estado atual. */
export interface StoredTransaction {
  transaction: WagerTransaction;
  observedBalance: Money;
}

function toStored(r: Row): StoredTransaction {
  const currency = r.currency.trim();
  return {
    observedBalance: Money.from({ amount: r.observed_balance, currency }),
    transaction: WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.provider_id,
      externalTransactionId: r.external_transaction_id,
      idempotencyKey: r.idempotency_key,
      payloadHash: r.payload_hash,
      walletId: r.wallet_id,
      playerId: r.player_id,
      roundId: r.round_id,
      gameId: r.game_id,
      kind: r.kind,
      money: Money.from({ amount: r.amount, currency }),
      referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
      createdAt: new Date(r.created_at),
      status: r.status,
      referenceTransactionId: r.reference_transaction_id ?? undefined,
      failureCode: r.failure_code ?? undefined,
      attempts: Number(r.attempts),
      nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
      processedAt: r.processed_at ? new Date(r.processed_at) : undefined,
    }),
  };
}

export class WagerTransactionRepository {
  async findById(tx: SqlExecutor, id: string): Promise<StoredTransaction | undefined> {
    const rows = await tx.query<Row>(`SELECT ${COLUMNS} FROM wager_transactions WHERE id = ?`, [id]);
    return rows[0] ? toStored(rows[0]) : undefined;
  }

  async findByIdempotencyKey(tx: SqlExecutor, providerId: string, key: string) {
    const rows = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM wager_transactions WHERE provider_id = ? AND idempotency_key = ?`,
      [providerId, key],
    );
    return rows[0] ? toStored(rows[0]) : undefined;
  }

  async findByExternalId(tx: SqlExecutor, providerId: string, externalId: string) {
    const rows = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM wager_transactions
        WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalId],
    );
    return rows[0] ? toStored(rows[0]) : undefined;
  }

  /** Já existe REFUND/ROLLBACK processado revertendo esta transação? */
  async hasProcessedReversal(tx: SqlExecutor, referenceTransactionId: string): Promise<boolean> {
    const rows = await tx.query(
      `SELECT 1 FROM wager_transactions
        WHERE reference_transaction_id = ? AND status = 'PROCESSED'
          AND kind IN ('REFUND','ROLLBACK') LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async insert(tx: SqlExecutor, t: WagerTransaction, observedBalance: Money): Promise<void> {
    const s = t.toState();
    await tx.query(
      `INSERT INTO wager_transactions (${COLUMNS}) VALUES (${Array(21).fill('?').join(', ')})`,
      [
        s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.walletId,
        s.playerId, s.roundId, s.gameId, s.kind, s.money.toJSON().amount, s.money.currency, s.status,
        s.referenceExternalTransactionId ?? null, s.referenceTransactionId ?? null,
        s.failureCode ?? null, s.attempts, s.nextAttemptAt?.toISOString() ?? null,
        s.createdAt.toISOString(), s.processedAt?.toISOString() ?? null,
        observedBalance.toJSON().amount,
      ],
    );
  }
}

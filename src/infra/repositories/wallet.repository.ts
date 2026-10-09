import { ConcurrentModificationError } from '../../application/errors';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import type { SqlExecutor } from '../database';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number | string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, player_id, currency, balance, version, created_at, updated_at';

function toWallet(r: WalletRow): Wallet {
  const currency = r.currency.trim();
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency,
    balance: Money.from({ amount: r.balance, currency }),
    version: Number(r.version),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  });
}

export class WalletRepository {
  async insert(tx: SqlExecutor, w: Wallet): Promise<void> {
    await tx.query(
      `INSERT INTO wallets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [w.id, w.playerId, w.currency, w.balance.toJSON().amount, w.version,
       w.createdAt.toISOString(), w.updatedAt.toISOString()],
    );
  }

  async findById(tx: SqlExecutor, id: string): Promise<Wallet | undefined> {
    const rows = await tx.query<WalletRow>(`SELECT ${COLUMNS} FROM wallets WHERE id = ?`, [id]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  /**
   * Trava a linha da wallet até o fim da transação (lock pessimista por wallet).
   * Quem chegar depois, na MESMA wallet, espera; wallets diferentes não se bloqueiam.
   */
  async findByIdForUpdate(tx: SqlExecutor, id: string): Promise<Wallet | undefined> {
    const rows = await tx.query<WalletRow>(
      `SELECT ${COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`, [id],
    );
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  /** Cinto de segurança extra: só atualiza se a version ainda é a que lemos sob o lock. */
  async updateBalance(tx: SqlExecutor, w: Wallet, expectedVersion: number): Promise<void> {
    const rows = await tx.query(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ? RETURNING version`,
      [w.balance.toJSON().amount, w.version, w.updatedAt.toISOString(), w.id, expectedVersion],
    );
    if (rows.length !== 1) throw new ConcurrentModificationError(w.id);
  }
}

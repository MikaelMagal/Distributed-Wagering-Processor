import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import type { SqlExecutor } from '../database';

export class LedgerRepository {
  /** O ledger só tem INSERT: o schema bloqueia UPDATE/DELETE/TRUNCATE. */
  async insert(tx: SqlExecutor, e: WalletLedgerEntry): Promise<void> {
    await tx.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.walletId, e.transactionId, e.direction, e.money.toJSON().amount, e.money.currency,
       e.balanceBefore.toJSON().amount, e.balanceAfter.toJSON().amount, e.createdAt.toISOString()],
    );
  }
}

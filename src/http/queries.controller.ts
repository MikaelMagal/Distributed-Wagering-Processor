import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { WalletNotFoundError } from '../application/errors';
import { DomainError } from '../domain/errors';
import { Database } from '../infra/database';
import { WagerTransactionRepository, type StoredTransaction } from '../infra/repositories/wager-transaction.repository';
import { WalletRepository } from '../infra/repositories/wallet.repository';
import { InvalidPayloadError } from './invalid-payload.error';

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  constructor(what: string) {
    super(`transaction ${what} not found`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface LedgerRow {
  id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: string | Date;
}

const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64url');
function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.test(id)) throw new InvalidPayloadError('invalid cursor');
  return id;
}

const transactionView = ({ transaction: t, observedBalance }: StoredTransaction) => ({
  transactionId: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  status: t.status,
  failureCode: t.failureCode,
  referenceTransactionId: t.referenceTransactionId,
  balance: observedBalance.toJSON(),
  createdAt: t.createdAt.toISOString(),
  processedAt: t.processedAt?.toISOString(),
});

@Controller()
export class QueriesController {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Cursor estável e opaco: o id do ledger é UUIDv7 (ordenável), então paginamos por `id > cursor`. */
  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitParam?: string,
  ) {
    const limit = limitParam === undefined ? DEFAULT_LIMIT : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new InvalidPayloadError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    const after = cursor ? decodeCursor(cursor) : undefined;

    if (!(await this.wallets.findById(this.db, walletId))) throw new WalletNotFoundError(walletId);

    const rows = await this.db.query<LedgerRow>(
      `SELECT id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? ${after ? 'AND id > ?::uuid' : ''}
        ORDER BY id
        LIMIT ?`,
      after ? [walletId, after, limit + 1] : [walletId, limit + 1],
    );

    const page = rows.slice(0, limit);
    const items = page.map((r) => {
      const currency = r.currency.trim();
      return {
        id: r.id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: { amount: r.amount, currency },
        balanceBefore: { amount: r.balance_before, currency },
        balanceAfter: { amount: r.balance_after, currency },
        createdAt: new Date(r.created_at).toISOString(),
      };
    });
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null };
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') id: string) {
    if (!UUID.test(id)) throw new InvalidPayloadError('transactionId must be a UUID');
    const stored = await this.transactions.findById(this.db, id);
    if (!stored) throw new TransactionNotFoundError(id);
    return transactionView(stored);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
  ) {
    const stored = await this.transactions.findByExternalId(this.db, providerId, externalId);
    if (!stored) throw new TransactionNotFoundError(`${providerId}/${externalId}`);
    return transactionView(stored);
  }
}
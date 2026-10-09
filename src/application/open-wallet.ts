import { Database, isUniqueViolation } from '../infra/database';
import { LedgerRepository } from '../infra/repositories/ledger.repository';
import { WagerTransactionRepository } from '../infra/repositories/wager-transaction.repository';
import { WalletRepository } from '../infra/repositories/wallet.repository';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { newId } from '../shared/ids';
import { WalletAlreadyExistsError } from './errors';

export class OpenWalletUseCase {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();
  private readonly ledger = new LedgerRepository();

  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(cmd: { playerId: string; initialBalance: MoneyProps }): Promise<Wallet> {
    const money = Money.from(cmd.initialBalance); // 422 se inválido
    const now = this.clock();
    const wallet = Wallet.open({ id: newId(), playerId: cmd.playerId, initialBalance: money, now });

    try {
      await this.db.transaction(async (tx) => {
        await this.wallets.insert(tx, wallet);

        // Saldo inicial > 0 ⇒ transação OPENING + lançamento CREDIT, na MESMA transação SQL.
        if (money.isPositive()) {
          const opening = WagerTransaction.createOpening({
            id: newId(), walletId: wallet.id, playerId: wallet.playerId, money, createdAt: now,
          });
          opening.markProcessed(undefined, now);
          await this.transactions.insert(tx, opening, money);
          await this.ledger.insert(
            tx,
            WalletLedgerEntry.create({
              id: newId(), walletId: wallet.id, transactionId: opening.id,
              direction: LedgerDirection.Credit, money,
              balanceBefore: Money.zero(money.currency), balanceAfter: money, createdAt: now,
            }),
          );
        }
      });
    } catch (err) {
      if (isUniqueViolation(err, ['wallets_player_currency_uk'])) {
        throw new WalletAlreadyExistsError(cmd.playerId, money.currency);
      }
      throw err;
    }
    return wallet;
  }
}

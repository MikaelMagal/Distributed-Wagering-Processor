import { LedgerImbalanceError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export function invert(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

/**
 * Imutável por construção: só campos readonly, sem métodos de transição.
 * A aritmética é verificada na factory (e de novo no schema via CHECK).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (!money.isPositive()) {
      throw new LedgerImbalanceError('ledger entry amount must be positive');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new LedgerImbalanceError('ledger balances must not be negative');
    }
    // subtract/add lançam CurrencyMismatchError se as moedas divergirem
    const expected =
      props.direction === LedgerDirection.Credit
        ? balanceBefore.add(money)
        : balanceBefore.subtract(money);
    if (!expected.equals(balanceAfter)) {
      throw new LedgerImbalanceError(
        `unbalanced entry: ${balanceBefore} ${props.direction} ${money} != ${balanceAfter}`,
      );
    }
    return WalletLedgerEntry.rehydrate(props);
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(s: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      s.id, s.walletId, s.transactionId, s.direction, s.money, s.balanceBefore, s.balanceAfter, s.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  toState(): LedgerEntryState {
    return {
      id: this.id, walletId: this.walletId, transactionId: this.transactionId,
      direction: this.direction, money: this.money, balanceBefore: this.balanceBefore,
      balanceAfter: this.balanceAfter, createdAt: this.createdAt,
    };
  }
}

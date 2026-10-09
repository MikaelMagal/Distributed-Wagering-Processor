import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  /** id do lançamento de ledger (UUIDv7 gerado por quem chama). */
  entryId: string;
  transactionId: string;
  amount: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version = 1.
   * Quando o saldo inicial > 0, o caso de uso DEVE gravar, na mesma transação SQL, a
   * transação OPENING e o lançamento CREDIT (balanceBefore = 0), para que ledger e saldo fechem.
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance must not be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(
      props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lança InsufficientFundsError se o saldo não cobrir. Retorna o lançamento a persistir. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.amount);
    this.assertPositive(props.amount);
    if (this._balance.isLessThan(props.amount)) {
      throw new InsufficientFundsError(`balance ${this._balance} cannot cover ${props.amount}`);
    }
    return this.apply(LedgerDirection.Debit, props, this._balance.subtract(props.amount));
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.amount);
    this.assertPositive(props.amount);
    return this.apply(LedgerDirection.Credit, props, this._balance.add(props.amount));
  }

  /** Saldo, version e lançamento mudam juntos: não existe movimento sem ledger. */
  private apply(direction: LedgerDirection, p: MovementProps, newBalance: Money): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: p.entryId,
      walletId: this.id,
      transactionId: p.transactionId,
      direction,
      money: p.amount,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: p.at,
    });
    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = p.at;
    return entry;
  }

  toState(): WalletState {
    return {
      id: this.id, playerId: this.playerId, currency: this.currency, balance: this._balance,
      version: this._version, createdAt: this.createdAt, updatedAt: this._updatedAt,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet is ${this.currency}, operation is ${money.currency}`);
    }
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidWalletError('movement amount must be positive');
    }
  }
}

import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

export interface MoneyProps {
  amount: string; // string decimal com 2 casas, ex.: "25.00"
  currency: string; // ISO-4217
}

// Decimal isolado: precisão alta e arredondamento irrelevante (só somamos/subtraímos escala 2).
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

// Entrada de contrato: inteiro ou até 2 casas, sem sinal, sem notação científica.
const INPUT_AMOUNT = /^\d+(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** Imutável. Nenhum `number` entra ou sai: só string decimal. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Valida um contrato de ENTRADA (não aceita negativos). */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props ?? ({} as MoneyProps);
    if (typeof amount !== 'string' || !INPUT_AMOUNT.test(amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with at most 2 decimal places',
      );
    }
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter uppercase ISO-4217 code');
    }
    return new Money(new D(amount), currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  /** O resultado pode ser negativo: quem decide se isso é permitido é a regra de negócio. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }
  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}

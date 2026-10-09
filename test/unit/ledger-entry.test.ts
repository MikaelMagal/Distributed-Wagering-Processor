import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, LedgerImbalanceError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { AT, brl } from './helpers';

const base = {
  id: 'e1', walletId: 'w1', transactionId: 't1', createdAt: AT,
};

describe('WalletLedgerEntry', () => {
  test('débito e crédito balanceados são aceitos', () => {
    const d = WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Debit, money: brl('80.00'),
      balanceBefore: brl('100.00'), balanceAfter: brl('20.00'),
    });
    const c = WalletLedgerEntry.create({
      ...base, direction: LedgerDirection.Credit, money: brl('80.00'),
      balanceBefore: brl('20.00'), balanceAfter: brl('100.00'),
    });
    expect(d.isBalanced()).toBe(true);
    expect(c.isBalanced()).toBe(true);
  });

  test('aritmética errada é rejeitada na factory', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Debit, money: brl('80.00'),
        balanceBefore: brl('100.00'), balanceAfter: brl('30.00'),
      }),
    ).toThrow(LedgerImbalanceError);
  });

  test('valor zero e saldos negativos são rejeitados', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Credit, money: Money.zero('BRL'),
        balanceBefore: brl('1.00'), balanceAfter: brl('1.00'),
      }),
    ).toThrow(LedgerImbalanceError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Debit, money: brl('10.00'),
        balanceBefore: brl('5.00'), balanceAfter: brl('5.00').subtract(brl('5.00')).subtract(brl('5.00')),
      }),
    ).toThrow(LedgerImbalanceError);
  });

  test('moedas diferentes são rejeitadas', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Credit,
        money: Money.from({ amount: '10.00', currency: 'USD' }),
        balanceBefore: brl('1.00'), balanceAfter: brl('11.00'),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('é imutável estruturalmente (sem setters/transições) e rehydrate não revalida', () => {
    const e = WalletLedgerEntry.rehydrate({
      ...base, direction: LedgerDirection.Debit, money: brl('1.00'),
      balanceBefore: brl('10.00'), balanceAfter: brl('3.00'), // inconsistente de propósito
    });
    expect(e.isBalanced()).toBe(false);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(e))).toEqual(
      expect.not.arrayContaining(['markProcessed', 'update', 'setAmount']),
    );
  });
});

import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError, InsufficientFundsError, InvalidWalletError,
} from '../../src/domain/errors';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { AT, brl } from './helpers';

const open = (initial = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), now: AT });
const mv = (amount: string, n = 'e1') => ({ entryId: n, transactionId: 't1', amount: brl(amount), at: AT });

describe('Wallet', () => {
  test('open: version = 1, moeda vem do saldo inicial', () => {
    const w = open();
    expect(w.version).toBe(1);
    expect(w.currency).toBe('BRL');
    expect(w.balance.toJSON().amount).toBe('100.00');
  });

  test('debit: reduz saldo, incrementa version e devolve lançamento balanceado', () => {
    const w = open();
    const e = w.debit(mv('80.00'));
    expect(w.balance.toJSON().amount).toBe('20.00');
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.balanceBefore.toJSON().amount).toBe('100.00');
    expect(e.balanceAfter.toJSON().amount).toBe('20.00');
  });

  test('credit: aumenta saldo e incrementa version', () => {
    const w = open('0.00');
    const e = w.credit(mv('10.50'));
    expect(w.balance.toJSON().amount).toBe('10.50');
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Credit);
  });

  test('cenário do desafio: 100 − 80 ok; segundo débito de 80 falha e NÃO muda estado', () => {
    const w = open();
    w.debit(mv('80.00', 'e1'));
    expect(() => w.debit(mv('80.00', 'e2'))).toThrow(InsufficientFundsError);
    expect(w.balance.toJSON().amount).toBe('20.00');
    expect(w.version).toBe(2); // falha não incrementa
  });

  test('débito exatamente igual ao saldo é permitido (saldo vai a zero)', () => {
    const w = open('50.00');
    w.debit(mv('50.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('moeda diferente da wallet é rejeitada', () => {
    const w = open();
    const usd = { entryId: 'e1', transactionId: 't1', amount: Money.from({ amount: '1.00', currency: 'USD' }), at: AT };
    expect(() => w.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => w.credit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('valor zero é rejeitado', () => {
    expect(() => open().credit(mv('0.00'))).toThrow(InvalidWalletError);
  });

  test('sequência mantém invariante: saldo final == soma do ledger', () => {
    const w = open('100.00');
    const entries = [
      w.debit(mv('30.00', 'a')),
      w.credit(mv('12.34', 'b')),
      w.debit(mv('0.01', 'c')),
    ];
    const net = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      brl('100.00'),
    );
    expect(net.equals(w.balance)).toBe(true);
    expect(w.version).toBe(4);
  });

  test('rehydrate preserva estado sem alterar version', () => {
    const w = Wallet.rehydrate({ ...open().toState(), balance: brl('7.00'), version: 9 });
    expect(w.version).toBe(9);
    expect(w.balance.toJSON().amount).toBe('7.00');
  });
});

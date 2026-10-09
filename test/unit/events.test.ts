import { describe, expect, test } from 'bun:test';
import {
  WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged,
} from '../../src/domain/events';
import { FailureCode } from '../../src/domain/failure-code';
import { Wallet } from '../../src/domain/wallet';
import { WagerTransactionKind as K } from '../../src/domain/wager-transaction';
import { AT, brl, tx } from './helpers';

const ctx = { eventId: 'ev-1', correlationId: 'corr-1', causationId: 'cause-1', occurredAt: AT };

describe('eventos de integração', () => {
  test('eventType e version estão no tipo; envelope serializa com ISO e MoneyProps', () => {
    const t = tx(K.Bet);
    t.markProcessed(undefined, AT);
    const e = WagerTransactionProcessed.from(t, brl('75.00'), ctx);
    expect(e.eventType).toBe('WagerTransactionProcessed');
    expect(e.version).toBe(1);
    expect(e.aggregateId).toBe('w1');
    const json = e.toJSON();
    expect(json.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(json.data.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(JSON.parse(JSON.stringify(json))).toEqual(JSON.parse(JSON.stringify(e)));
  });

  test('data é imutável', () => {
    const t = tx(K.Bet);
    t.markProcessed(undefined, AT);
    const e = WagerTransactionProcessed.from(t, brl('1.00'), ctx);
    expect(() => { (e.data as { kind: string }).kind = 'X'; }).toThrow();
  });

  test('Rejected carrega failureCode; PendingReference carrega referência e tentativas', () => {
    const bet = tx(K.Bet);
    bet.reject(FailureCode.InsufficientFunds);
    expect(WagerTransactionRejected.from(bet, brl('0.00'), ctx).data.failureCode).toBe(FailureCode.InsufficientFunds);

    const rf = tx(K.Refund, { referenceExternalTransactionId: 'ext-x' });
    rf.markPendingReference(new Date('2026-01-01T00:00:02Z'));
    const e = WagerTransactionPendingReference.from(rf, brl('10.00'), ctx);
    expect(e.data).toMatchObject({ referenceExternalTransactionId: 'ext-x', attempts: 1, nextAttemptAt: '2026-01-01T00:00:02.000Z' });
  });

  test('WalletBalanceChanged traz antes/depois e a version da wallet', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00'), now: AT });
    const entry = w.debit({ entryId: 'e1', transactionId: 't1', amount: brl('30.00'), at: AT });
    const ev = WalletBalanceChanged.from(w, entry, ctx);
    expect(ev.data).toMatchObject({
      direction: 'DEBIT', walletVersion: 2,
      balanceBefore: { amount: '100.00' }, balanceAfter: { amount: '70.00' },
    });
  });
});

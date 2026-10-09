import { describe, expect, test } from 'bun:test';
import { InvalidOutboxStateError } from '../../src/domain/errors';
import { WagerTransactionProcessed } from '../../src/domain/events';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransactionKind as K } from '../../src/domain/wager-transaction';
import { AT, brl, tx } from './helpers';

const message = () => {
  const t = tx(K.Bet);
  t.markProcessed(undefined, AT);
  const ev = WagerTransactionProcessed.from(t, brl('1.00'), { eventId: 'ev-1', correlationId: 'c', occurredAt: AT });
  return OutboxMessage.enqueue(ev);
};
const plus = (ms: number) => new Date(AT.getTime() + ms);

describe('OutboxMessage', () => {
  test('nasce pendente, devida e com o eventId como id', () => {
    const m = message();
    expect(m.id).toBe('ev-1');
    expect(m.eventType).toBe('WagerTransactionProcessed');
    expect(m.isPending()).toBe(true);
    expect(m.isDue(AT)).toBe(true);
    expect(m.attempts).toBe(0);
  });

  test('scheduleRetry: backoff exponencial 1s, 2s, 4s e deixa de estar devida', () => {
    const m = message();
    m.scheduleRetry(AT);
    expect([m.attempts, m.nextAttemptAt]).toEqual([1, plus(1_000)]);
    expect(m.isDue(plus(999))).toBe(false);
    expect(m.isDue(plus(1_000))).toBe(true);
    m.scheduleRetry(plus(1_000));
    expect(m.nextAttemptAt).toEqual(plus(1_000 + 2_000));
    m.scheduleRetry(plus(3_000));
    expect(m.nextAttemptAt).toEqual(plus(3_000 + 4_000));
  });

  test('backoff tem teto de 60s', () => {
    const m = message();
    for (let i = 0; i < 20; i++) m.scheduleRetry(AT);
    expect(m.nextAttemptAt).toEqual(plus(60_000));
  });

  test('markPublished encerra; depois disso não publica nem reagenda', () => {
    const m = message();
    m.markPublished(AT);
    expect(m.isPending()).toBe(false);
    expect(m.isDue(plus(999_999))).toBe(false);
    expect(() => m.markPublished(AT)).toThrow(InvalidOutboxStateError);
    expect(() => m.scheduleRetry(AT)).toThrow(InvalidOutboxStateError);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const m = message();
    m.scheduleRetry(AT);
    const again = OutboxMessage.rehydrate(m.toState());
    expect(again.attempts).toBe(1);
    expect(again.nextAttemptAt).toEqual(m.nextAttemptAt);
  });
});

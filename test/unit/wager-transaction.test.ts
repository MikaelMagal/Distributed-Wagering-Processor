import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError, InvalidWagerTransactionError,
} from '../../src/domain/errors';
import { FailureCode, PROVIDER_ACTION } from '../../src/domain/failure-code';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import {
  WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S,
} from '../../src/domain/wager-transaction';
import { AT, brl, nextId, processed, tx } from './helpers';

describe('criação', () => {
  test('nasce PENDING', () => {
    expect(tx(K.Bet).status).toBe(S.Pending);
  });

  test('OPENING não pode ser submetido por create()', () => {
    expect(() => tx(K.Opening)).toThrow(InvalidWagerTransactionError);
  });

  test('createOpening cria transação interna creditando', () => {
    const o = WagerTransaction.createOpening({
      id: nextId(), walletId: 'w1', playerId: 'p1', money: brl('1000.00'), createdAt: AT,
    });
    expect(o.kind).toBe(K.Opening);
    expect(o.providerId).toBe('internal');
    expect(o.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('REFUND e ROLLBACK exigem referência; BET não aceita', () => {
    expect(() => tx(K.Refund)).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Rollback)).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Bet, { referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
    expect(tx(K.Win, { referenceExternalTransactionId: 'x' }).requiresReference()).toBe(false);
  });

  test('valor zero é rejeitado', () => {
    expect(() => tx(K.Bet, { money: brl('0.00') })).toThrow(InvalidWagerTransactionError);
  });

  test('affectsBalance: false só para LOSS', () => {
    expect(tx(K.Loss).affectsBalance()).toBe(false);
    expect(tx(K.Bet).affectsBalance()).toBe(true);
    expect(tx(K.Win).affectsBalance()).toBe(true);
    expect(tx(K.Refund, { referenceExternalTransactionId: 'r' }).affectsBalance()).toBe(true);
    expect(tx(K.Rollback, { referenceExternalTransactionId: 'r' }).affectsBalance()).toBe(true);
  });
});

describe('máquina de estados', () => {
  test('PENDING → PROCESSED guarda processedAt e referência', () => {
    const t = tx(K.Refund, { referenceExternalTransactionId: 'r' });
    t.markProcessed('ref-id', AT);
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe('ref-id');
    expect(t.processedAt).toEqual(AT);
  });

  test('REFUND/ROLLBACK não podem ser PROCESSED sem a referência interna', () => {
    const t = tx(K.Refund, { referenceExternalTransactionId: 'r' });
    expect(() => t.markProcessed(undefined, AT)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING → PENDING_REFERENCE conta tentativas e agenda a próxima', () => {
    const t = tx(K.Rollback, { referenceExternalTransactionId: 'r' });
    const next = new Date('2026-01-01T00:00:05Z');
    t.markPendingReference(next);
    t.markPendingReference(new Date('2026-01-01T00:00:15Z'));
    expect(t.status).toBe(S.PendingReference);
    expect(t.attempts).toBe(2);
  });

  test('BET nunca entra em PENDING_REFERENCE', () => {
    expect(() => tx(K.Bet).markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE → REJECTED com failureCode', () => {
    const t = tx(K.Refund, { referenceExternalTransactionId: 'r' });
    t.markPendingReference();
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(S.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(t.nextAttemptAt).toBeUndefined();
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, AT)],
    ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.InfrastructureError)],
  ])('estado terminal %s não transiciona mais', (_name, toTerminal) => {
    const t = tx(K.Bet);
    toTerminal(t);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markProcessed(undefined, AT)).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InfrastructureError)).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate não revalida (reconstrói estado terminal já persistido)', () => {
    const t = tx(K.Bet);
    t.reject(FailureCode.InsufficientFunds);
    const again = WagerTransaction.rehydrate(t.toState());
    expect(again.status).toBe(S.Rejected);
    expect(again.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('matchesPayload compara o hash', () => {
    const t = tx(K.Bet, { payloadHash: 'abc' });
    expect(t.matchesPayload('abc')).toBe(true);
    expect(t.matchesPayload('abd')).toBe(false);
  });
});

describe('direção do ledger', () => {
  test('BET debita; WIN e REFUND creditam', () => {
    expect(tx(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx(K.Refund, { referenceExternalTransactionId: 'r' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('LOSS não gera lançamento', () => {
    expect(() => tx(K.Loss).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('ROLLBACK inverte a referência (BET→CREDIT, WIN→DEBIT, REFUND→DEBIT)', () => {
    const rb = tx(K.Rollback, { referenceExternalTransactionId: 'r' });
    expect(rb.ledgerDirectionFor(processed(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(processed(K.Win))).toBe(LedgerDirection.Debit);
    expect(
      rb.ledgerDirectionFor(processed(K.Refund, { referenceExternalTransactionId: 'x' })),
    ).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência ou sobre LOSS é inválido', () => {
    const rb = tx(K.Rollback, { referenceExternalTransactionId: 'r' });
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => rb.ledgerDirectionFor(processed(K.Loss))).toThrow(InvalidWagerTransactionError);
  });
});

describe('evaluateReference', () => {
  const refund = () => tx(K.Refund, { referenceExternalTransactionId: 'r' });
  const rollback = () => tx(K.Rollback, { referenceExternalTransactionId: 'r' });

  test('BET/WIN/LOSS não dependem de referência', () => {
    expect(tx(K.Bet).evaluateReference(undefined)).toEqual({ outcome: 'valid' });
    expect(tx(K.Win, { referenceExternalTransactionId: 'x' }).evaluateReference(undefined)).toEqual({ outcome: 'valid' });
  });

  test('referência inexistente → wait', () => {
    expect(refund().evaluateReference(undefined)).toEqual({ outcome: 'wait' });
  });

  test('REFUND sobre BET PROCESSED → valid', () => {
    expect(refund().evaluateReference(processed(K.Bet))).toEqual({ outcome: 'valid' });
  });

  test('ROLLBACK sobre BET, WIN e REFUND → valid', () => {
    expect(rollback().evaluateReference(processed(K.Bet))).toEqual({ outcome: 'valid' });
    expect(rollback().evaluateReference(processed(K.Win))).toEqual({ outcome: 'valid' });
    expect(
      rollback().evaluateReference(processed(K.Refund, { referenceExternalTransactionId: 'x' })),
    ).toEqual({ outcome: 'valid' });
  });

  test('REFUND sobre WIN → INVALID_REFERENCE_KIND; ROLLBACK sobre LOSS/ROLLBACK idem', () => {
    expect(refund().evaluateReference(processed(K.Win))).toEqual({ outcome: 'reject', code: FailureCode.InvalidReferenceKind });
    expect(rollback().evaluateReference(processed(K.Loss))).toEqual({ outcome: 'reject', code: FailureCode.InvalidReferenceKind });
    expect(
      rollback().evaluateReference(processed(K.Rollback, { referenceExternalTransactionId: 'x' })),
    ).toEqual({ outcome: 'reject', code: FailureCode.InvalidReferenceKind });
  });

  test.each([
    ['provider', { providerId: 'prov-b' }],
    ['player', { playerId: 'p2' }],
    ['wallet', { walletId: 'w2' }],
    ['rodada', { roundId: 'r2' }],
  ])('%s diferente → REFERENCE_MISMATCH', (_n, diff) => {
    expect(refund().evaluateReference(processed(K.Bet, diff))).toEqual({ outcome: 'reject', code: FailureCode.ReferenceMismatch });
  });

  test('valor diferente → AMOUNT_MISMATCH', () => {
    expect(refund().evaluateReference(processed(K.Bet, { money: brl('10.00') }))).toEqual({
      outcome: 'reject', code: FailureCode.AmountMismatch,
    });
  });

  test('referência ainda não processada → wait; rejeitada/falha → REFERENCE_NOT_PROCESSED', () => {
    expect(refund().evaluateReference(tx(K.Bet))).toEqual({ outcome: 'wait' });
    const rejected = tx(K.Bet);
    rejected.reject(FailureCode.InsufficientFunds);
    expect(refund().evaluateReference(rejected)).toEqual({ outcome: 'reject', code: FailureCode.ReferenceNotProcessed });
    const failed = tx(K.Bet);
    failed.fail(FailureCode.InfrastructureError);
    expect(rollback().evaluateReference(failed)).toEqual({ outcome: 'reject', code: FailureCode.ReferenceNotProcessed });
  });
});

describe('códigos de falha', () => {
  test('saldo insuficiente: BET vs reversão têm códigos distintos', () => {
    expect(tx(K.Bet).insufficientFundsCode()).toBe(FailureCode.InsufficientFunds);
    expect(tx(K.Rollback, { referenceExternalTransactionId: 'r' }).insufficientFundsCode()).toBe(FailureCode.ReversalWouldOverdraw);
  });

  test('todo código tem orientação para o provedor', () => {
    for (const code of Object.values(FailureCode)) {
      expect(PROVIDER_ACTION[code]).toBeDefined();
    }
  });
});

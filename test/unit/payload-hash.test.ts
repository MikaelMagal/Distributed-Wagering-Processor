import { describe, expect, test } from 'bun:test';
import { canonicalJson, computePayloadHash, type HashablePayload } from '../../src/domain/payload-hash';

const base: HashablePayload = {
  providerId: 'prov-a', externalTransactionId: 't1', playerId: 'p1', walletId: 'w1',
  roundId: 'r1', gameId: 'g1', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('ordena chaves recursivamente e remove espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  test('ausente vira null', () => {
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}');
  });
});

describe('computePayloadHash', () => {
  test('é estável e independe da ordem das chaves', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as HashablePayload;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  test('"25" e "25.00" geram o mesmo hash (valor normalizado)', () => {
    const a = computePayloadHash({ ...base, money: { amount: '25', currency: 'BRL' } });
    expect(a).toBe(computePayloadHash(base));
  });

  test('referência ausente, undefined e null são equivalentes', () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: null })).toBe(computePayloadHash(base));
  });

  test.each([
    ['valor', { money: { amount: '25.01', currency: 'BRL' } }],
    ['kind', { kind: 'WIN' }],
    ['rodada', { roundId: 'r2' }],
    ['wallet', { walletId: 'w2' }],
    ['referência', { referenceExternalTransactionId: 'x' }],
  ])('mudar %s muda o hash', (_n, diff) => {
    expect(computePayloadHash({ ...base, ...diff } as HashablePayload)).not.toBe(computePayloadHash(base));
  });

  test('hash é SHA-256 hex (64 chars)', () => {
    expect(computePayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

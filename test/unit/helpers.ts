import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const AT = new Date('2026-01-01T00:00:00Z');

let seq = 0;
export const nextId = () => `id-${++seq}`;

export function tx(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const n = nextId();
  return WagerTransaction.create({
    id: n,
    providerId: 'prov-a',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `prov-a:ext-${n}`,
    payloadHash: `hash-${n}`,
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: brl('25.00'),
    createdAt: AT,
    ...overrides,
  });
}

/** Cria e já marca como PROCESSED (para servir de referência). */
export function processed(kind: WagerTransactionKind, overrides: Partial<CreateWagerTransactionProps> = {}) {
  const t = tx(kind, overrides);
  t.markProcessed(t.requiresReference() ? 'ref-id' : undefined, AT);
  return t;
}

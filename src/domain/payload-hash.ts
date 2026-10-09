import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from './money';

/**
 * Algoritmo do payloadHash (documentado em ARCHITECTURE.md):
 *  1. Seleciona só os campos de negócio (abaixo). Header Idempotency-Key e metadados de transporte ficam de fora.
 *  2. Normaliza o valor via Money (ex.: "25" e "25.00" produzem o mesmo hash).
 *  3. Serializa em JSON canônico: chaves ordenadas recursivamente, sem espaços, ausente → null.
 *  4. SHA-256, em hexadecimal.
 */
export interface HashablePayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computePayloadHash(payload: HashablePayload): string {
  const business = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  };
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}

/**
 * Taxonomia estável e legível por máquina. Guia para o provedor:
 *  - RETRY_LATER   → reenviar a MESMA requisição (mesma idempotency key) mais tarde
 *  - FIX_PAYLOAD   → corrigir os dados; reenviar com nova operação
 *  - GIVE_UP       → regra de negócio definitiva; reenviar não muda o resultado
 */
export enum FailureCode {
  /** BET sem saldo suficiente. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK que deixaria o saldo negativo (situação operacional distinta de aposta sem saldo). */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** Referência não apareceu dentro do limite de tentativas/TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe mas pertence a outro provider/player/wallet/moeda/rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo da referência incompatível (ex.: REFUND sobre WIN). */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Referência foi REJECTED/FAILED: não há o que reverter. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** A referência já foi revertida por este mesmo tipo de operação. */
  AlreadyReversed = 'ALREADY_REVERSED',
  /** Valor da reversão diferente do valor da referência (parcial fora de escopo). */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** O playerId informado não é o dono da wallet. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** Erro permanente de infraestrutura (estado FAILED). */
  InfrastructureError = 'INFRASTRUCTURE_ERROR',
}

export type ProviderAction = 'RETRY_LATER' | 'FIX_PAYLOAD' | 'GIVE_UP';

export const PROVIDER_ACTION: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InsufficientFunds]: 'GIVE_UP',
  [FailureCode.ReversalWouldOverdraw]: 'GIVE_UP',
  [FailureCode.ReferenceNotFound]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InvalidReferenceKind]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'GIVE_UP',
  [FailureCode.AlreadyReversed]: 'GIVE_UP',
  [FailureCode.AmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.PlayerWalletMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InfrastructureError]: 'RETRY_LATER',
};

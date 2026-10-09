import { DomainError } from '../domain/errors';

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

/** Mesma idempotency key (ou mesmo externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(key: string) {
    super(`idempotency key ${key} was already used with a different payload`);
  }
}

export class ConcurrentModificationError extends DomainError {
  readonly code = 'CONCURRENT_MODIFICATION';
  constructor(walletId: string) {
    super(`wallet ${walletId} was modified concurrently`);
  }
}

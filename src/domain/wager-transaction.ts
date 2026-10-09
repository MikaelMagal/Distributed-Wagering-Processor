import { InvalidTransactionStateError, InvalidWagerTransactionError } from './errors';
import { FailureCode } from './failure-code';
import { LedgerDirection, invert } from './ledger-entry';
import { Money } from './money';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * Transições válidas (PROCESSED, REJECTED e FAILED são terminais):
 *
 *   PENDING            → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 */
const isOpenStatus = (s: WagerTransactionStatus) =>
  s === WagerTransactionStatus.Pending || s === WagerTransactionStatus.PendingReference;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor — não o id interno. */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  attempts: number;
  nextAttemptAt?: Date;
  processedAt?: Date;
}

export type ReferenceEvaluation =
  | { outcome: 'valid' }
  /** Referência ainda não está PROCESSED (ou nem existe): manter/entrar em PENDING_REFERENCE. */
  | { outcome: 'wait' }
  | { outcome: 'reject'; code: FailureCode };

export const INTERNAL_PROVIDER = 'internal';

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _attempts = 0,
    private _nextAttemptAt?: Date,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. OPENING é interno e nunca passa por aqui (ver createOpening). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    createdAt: Date;
  }): WagerTransaction {
    return WagerTransaction.build({
      id: props.id,
      providerId: INTERNAL_PROVIDER,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `opening:${props.walletId}`,
      payloadHash: 'opening',
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
    });
  }

  private static build(p: CreateWagerTransactionProps): WagerTransaction {
    if (!p.money.isPositive()) {
      throw new InvalidWagerTransactionError('amount must be greater than zero');
    }
    const needsRef =
      p.kind === WagerTransactionKind.Refund || p.kind === WagerTransactionKind.Rollback;
    if (needsRef && !p.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${p.kind} requires referenceExternalTransactionId`);
    }
    if (p.kind === WagerTransactionKind.Bet && p.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError('BET cannot carry a reference');
    }
    // WIN/LOSS podem trazer referência, mas ela é apenas informativa: não bloqueia o processamento.
    return new WagerTransaction(
      p.id, p.providerId, p.externalTransactionId, p.idempotencyKey, p.payloadHash, p.walletId,
      p.playerId, p.roundId, p.gameId, p.kind, p.money, p.referenceExternalTransactionId,
      p.createdAt, WagerTransactionStatus.Pending,
    );
  }

  /** Reconstrução a partir da persistência — não revalida regras de transição. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.walletId,
      s.playerId, s.roundId, s.gameId, s.kind, s.money, s.referenceExternalTransactionId,
      s.createdAt, s.status, s.referenceTransactionId, s.failureCode, s.attempts,
      s.nextAttemptAt, s.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertOpen('markProcessed');
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(`${this.kind} cannot be processed without its reference`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  /**
   * Entra (ou permanece) em PENDING_REFERENCE. Cada chamada conta uma tentativa e agenda a próxima.
   */
  markPendingReference(nextAttemptAt?: Date): void {
    this.assertOpen('markPendingReference');
    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(`${this.kind} never waits for a reference`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode): void {
    this.assertOpen('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode): void {
    this.assertOpen('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return !isOpenStatus(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debita; WIN/REFUND/OPENING creditam; ROLLBACK inverte a referência; LOSS não move saldo. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK needs its reference to know the direction');
        }
        const base = reference.kind;
        if (
          base !== WagerTransactionKind.Bet &&
          base !== WagerTransactionKind.Win &&
          base !== WagerTransactionKind.Refund
        ) {
          throw new InvalidWagerTransactionError(`cannot roll back a ${base}`);
        }
        return invert(reference.ledgerDirectionFor());
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not affect balance');
    }
  }

  /**
   * Avalia a referência já resolvida por (providerId, referenceExternalTransactionId).
   * `undefined` = ainda não existe. O "já foi revertida" depende de consulta ao banco
   * (e é garantido pelo índice único parcial), então fica no caso de uso.
   */
  evaluateReference(reference: WagerTransaction | undefined): ReferenceEvaluation {
    if (!this.requiresReference()) return { outcome: 'valid' };
    if (!reference) return { outcome: 'wait' };

    const sameScope =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameScope) return { outcome: 'reject', code: FailureCode.ReferenceMismatch };

    const allowed =
      this.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
    if (!allowed.includes(reference.kind)) {
      return { outcome: 'reject', code: FailureCode.InvalidReferenceKind };
    }

    if (!reference.money.equals(this.money)) {
      return { outcome: 'reject', code: FailureCode.AmountMismatch };
    }

    switch (reference.status) {
      case WagerTransactionStatus.Processed:
        return { outcome: 'valid' };
      case WagerTransactionStatus.Pending:
      case WagerTransactionStatus.PendingReference:
        return { outcome: 'wait' };
      default:
        return { outcome: 'reject', code: FailureCode.ReferenceNotProcessed };
    }
  }

  /** Falta de saldo em BET é diferente de reversão que estouraria o saldo. */
  insufficientFundsCode(): FailureCode {
    return this.kind === WagerTransactionKind.Bet
      ? FailureCode.InsufficientFunds
      : FailureCode.ReversalWouldOverdraw;
  }

  toState(): WagerTransactionState {
    return {
      id: this.id, providerId: this.providerId, externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey, payloadHash: this.payloadHash, walletId: this.walletId,
      playerId: this.playerId, roundId: this.roundId, gameId: this.gameId, kind: this.kind,
      money: this.money, referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt, status: this._status,
      referenceTransactionId: this._referenceTransactionId, failureCode: this._failureCode,
      attempts: this._attempts, nextAttemptAt: this._nextAttemptAt, processedAt: this._processedAt,
    };
  }

  private assertOpen(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `cannot ${action}: transaction ${this.id} is already ${this._status}`,
      );
    }
  }
}

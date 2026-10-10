import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../domain/events';
import { InsufficientFundsError } from '../domain/errors';
import type { EventContext, IntegrationEvent } from '../domain/integration-event';
import { OutboxMessage } from '../domain/outbox-message';
import { FailureCode } from '../domain/failure-code';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import { computePayloadHash } from '../domain/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { Database, isUniqueViolation, type SqlExecutor } from '../infra/database';
import { InboxRepository, type InboxRef } from '../infra/repositories/inbox.repository';
import { LedgerRepository } from '../infra/repositories/ledger.repository';
import { OutboxRepository } from '../infra/repositories/outbox.repository';
import {
  WagerTransactionRepository,
  type StoredTransaction,
} from '../infra/repositories/wager-transaction.repository';
import { WalletRepository } from '../infra/repositories/wallet.repository';
import { newId } from '../shared/ids';
import { IdempotencyConflictError, WalletNotFoundError } from './errors';
import { referenceRetryAt } from './reference-retry';

/**
 * Limite de tentativas para uma referência que não aparece. Com o backoff de reference-retry
 * (2s, 4s, 8s... teto de 5 min) são ~10 tentativas ≈ 13 minutos de espera no total.
 * Esgotado: REJECTED com REFERENCE_NOT_FOUND.
 */
export const REFERENCE_MAX_ATTEMPTS = 10;

export interface SubmitTransactionCommand {
  /** Header Idempotency-Key. É a fonte da verdade da idempotência. */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  /** Rastreio ponta a ponta (header HTTP / messageId do SQS). Gerado se ausente. */
  correlationId?: string;
  /** O que causou esta requisição (ex.: messageId da fila). */
  causationId?: string;
  /** Preenchido só quando a origem é o SQS: grava a inbox na mesma transação SQL. */
  inbox?: InboxRef;
}

export interface SubmitTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: Money;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

type EventTrace = Pick<SubmitTransactionCommand, 'correlationId' | 'causationId'>;

// Corrida rara: mesma chave chegando por wallets diferentes ao mesmo tempo (o UNIQUE do banco desempata).
const IDEMPOTENCY_CONSTRAINTS = ['wager_tx_idempotency_uk', 'wager_tx_external_uk'];

export class SubmitTransactionUseCase {
  private readonly wallets = new WalletRepository();
  private readonly transactions = new WagerTransactionRepository();
  private readonly ledger = new LedgerRepository();
  private readonly outbox = new OutboxRepository();
  private readonly inbox = new InboxRepository();

  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(cmd: SubmitTransactionCommand): Promise<SubmitTransactionResult> {
    const money = Money.from(cmd.money); // valida a ENTRADA antes de tocar no banco
    const payloadHash = computePayloadHash({ ...cmd, money: money.toJSON() });
    const build = () =>
      WagerTransaction.create({
        id: newId(),
        providerId: cmd.providerId,
        externalTransactionId: cmd.externalTransactionId,
        idempotencyKey: cmd.idempotencyKey,
        payloadHash,
        walletId: cmd.walletId,
        playerId: cmd.playerId,
        roundId: cmd.roundId,
        gameId: cmd.gameId,
        kind: cmd.kind,
        money,
        referenceExternalTransactionId: cmd.referenceExternalTransactionId,
        createdAt: this.clock(),
      });
    build(); // falha cedo: OPENING, referência ausente em REFUND/ROLLBACK, valor <= 0

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.db.transaction(async (tx) => {
          // Inbox na MESMA transação SQL do saldo, ledger e outbox (só quando a origem é o SQS).
          if (cmd.inbox) await this.inbox.receive(tx, cmd.inbox, this.clock());
          const result = await this.run(tx, cmd, build(), payloadHash);
          if (cmd.inbox) await this.inbox.markProcessed(tx, cmd.inbox, this.clock());
          return result;
        });
      } catch (err) {
        // Perdemos a corrida pelo UNIQUE: na 2ª tentativa a linha vencedora já é visível
        // e cai no caminho de replay (ou de conflito, se o payload for outro).
        if (attempt < 2 && isUniqueViolation(err, IDEMPOTENCY_CONSTRAINTS)) continue;
        throw err;
      }
    }
  }

  /**
   * Reprocessa uma transação PENDING_REFERENCE vencida (chamado pelo worker agendado).
   * Trava a wallet primeiro e SÓ DEPOIS relê a transação: se outra instância já a resolveu
   * enquanto esperávamos o lock, ela não está mais pendente e saímos sem fazer nada.
   * Retorna true se havia trabalho a fazer.
   */
  async reprocessPending(transactionId: string, walletId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const now = this.clock();
      const wallet = await this.wallets.findByIdForUpdate(tx, walletId);
      if (!wallet) return false;

      const stored = await this.transactions.findById(tx, transactionId);
      const t = stored?.transaction;
      if (!t || t.status !== WagerTransactionStatus.PendingReference) return false;
      if (t.nextAttemptAt && t.nextAttemptAt > now) return false;

      const versionBefore = wallet.version;
      const entry = await this.decide(tx, wallet, t, now);
      if (t.status === WagerTransactionStatus.PendingReference && t.attempts >= REFERENCE_MAX_ATTEMPTS) {
        t.reject(FailureCode.ReferenceNotFound); // limite esgotado
      }

      const stillPending = t.status === WagerTransactionStatus.PendingReference;
      await this.transactions.update(tx, t, stillPending ? undefined : wallet.balance);
      if (entry) {
        await this.ledger.insert(tx, entry);
        await this.wallets.updateBalance(tx, wallet, versionBefore);
      }
      // Ainda pendente: o evento WagerTransactionPendingReference já saiu na 1ª vez.
      if (!stillPending) await this.enqueueEvents(tx, {}, t, wallet, entry, now);
      return true;
    });
  }

  private async run(
    tx: SqlExecutor,
    cmd: SubmitTransactionCommand,
    t: WagerTransaction,
    payloadHash: string,
  ): Promise<SubmitTransactionResult> {
    const now = this.clock();

    // 1) LOCK da wallet: daqui até o commit, ninguém mais mexe nesta wallet.
    const wallet = await this.wallets.findByIdForUpdate(tx, cmd.walletId);
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    // 2) Idempotência: já vimos esta chave (ou este externalTransactionId)?
    const existing =
      (await this.transactions.findByIdempotencyKey(tx, t.providerId, cmd.idempotencyKey)) ??
      (await this.transactions.findByExternalId(tx, t.providerId, t.externalTransactionId));
    if (existing) return this.replay(existing, cmd.idempotencyKey, payloadHash);

    // 3) Decide o desfecho (muda `t` e `wallet` só em memória)
    const versionBefore = wallet.version;
    const entry = await this.decide(tx, wallet, t, now);

    // 4) Persiste tudo na mesma transação SQL: transação, ledger, saldo e evento (outbox)
    await this.transactions.insert(tx, t, wallet.balance);
    if (entry) {
      await this.ledger.insert(tx, entry);
      await this.wallets.updateBalance(tx, wallet, versionBefore);
    }
    await this.enqueueEvents(tx, cmd, t, wallet, entry, now);

    return {
      transactionId: t.id,
      status: t.status,
      balance: wallet.balance,
      failureCode: t.failureCode,
      idempotentReplay: false,
    };
  }

  private replay(
    existing: StoredTransaction,
    idempotencyKey: string,
    payloadHash: string,
  ): SubmitTransactionResult {
    const t = existing.transaction;
    if (t.idempotencyKey !== idempotencyKey || !t.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return {
      transactionId: t.id,
      status: t.status,
      balance: existing.observedBalance, // o saldo daquele momento, não o atual
      failureCode: t.failureCode,
      idempotentReplay: true,
    };
  }

  /** Aplica as regras de negócio. Retorna o lançamento de ledger, se houve movimento. */
  private async decide(
    tx: SqlExecutor,
    wallet: Wallet,
    t: WagerTransaction,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    if (wallet.playerId !== t.playerId) {
      t.reject(FailureCode.PlayerWalletMismatch);
      return;
    }
    if (wallet.currency !== t.money.currency) {
      t.reject(FailureCode.CurrencyMismatch);
      return;
    }

    let reference: WagerTransaction | undefined;
    if (t.requiresReference()) {
      const stored = await this.transactions.findByExternalId(
        tx, t.providerId, t.referenceExternalTransactionId!,
      );
      reference = stored?.transaction;
    }

    const evaluation = t.evaluateReference(reference);
    if (evaluation.outcome === 'wait') {
      // fora de ordem: o worker reprocessa. Backoff exponencial pela contagem de tentativas.
      t.markPendingReference(referenceRetryAt(now, t.attempts + 1));
      return;
    }
    if (evaluation.outcome === 'reject') {
      t.reject(evaluation.code);
      return;
    }
    if (reference && (await this.transactions.hasProcessedReversal(tx, reference.id))) {
      t.reject(FailureCode.AlreadyReversed);
      return;
    }

    if (!t.affectsBalance()) { // LOSS: registra o resultado, sem saldo e sem ledger
      t.markProcessed(undefined, now);
      return;
    }

    const movement = { entryId: newId(), transactionId: t.id, amount: t.money, at: now };
    try {
      const entry =
        t.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
      t.markProcessed(reference?.id, now);
      return entry;
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        t.reject(t.insufficientFundsCode()); // BET sem saldo ≠ reversão que estouraria o saldo
        return;
      }
      throw err;
    }
  }

  /** Eventos de integração gravados na outbox, na MESMA transação (nunca antes do commit). */
  private async enqueueEvents(
    tx: SqlExecutor,
    trace: EventTrace,
    t: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    now: Date,
  ): Promise<void> {
    const correlationId = trace.correlationId ?? newId();
    const ctx = (): EventContext => ({
      eventId: newId(), correlationId, causationId: trace.causationId, occurredAt: now,
    });

    const events: IntegrationEvent<unknown>[] = [];
    switch (t.status) {
      case WagerTransactionStatus.Processed:
        events.push(WagerTransactionProcessed.from(t, wallet.balance, ctx()));
        if (entry) events.push(WalletBalanceChanged.from(wallet, entry, ctx())); // só se o saldo mudou
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(t, wallet.balance, ctx()));
        break;
      case WagerTransactionStatus.PendingReference:
        events.push(WagerTransactionPendingReference.from(t, wallet.balance, ctx()));
        break;
    }
    for (const event of events) await this.outbox.insert(tx, OutboxMessage.enqueue(event));
  }
}
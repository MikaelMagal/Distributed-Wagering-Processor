import { IntegrationEvent, type EventContext } from './integration-event';
import type { FailureCode } from './failure-code';
import type { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import type { Money, MoneyProps } from './money';
import type { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import type { Wallet } from './wallet';

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  /** Saldo da wallet depois deste desfecho. */
  balance: MoneyProps;
}

const base = (t: WagerTransaction, balance: Money): TransactionData => ({
  transactionId: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  balance: balance.toJSON(),
});

// ---- WagerTransactionProcessed: qualquer transação aplicada, inclusive LOSS
export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId?: string;
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(t: WagerTransaction, balance: Money, ctx: EventContext) {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: t.walletId,
      data: { ...base(t, balance), referenceTransactionId: t.referenceTransactionId },
    });
  }
}

// ---- WagerTransactionRejected: violação de regra de negócio
export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
}
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(t: WagerTransaction, balance: Money, ctx: EventContext) {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: t.walletId,
      data: { ...base(t, balance), failureCode: t.failureCode! },
    });
  }
}

// ---- WagerTransactionPendingReference: referência ainda não chegou
export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt?: string;
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(t: WagerTransaction, balance: Money, ctx: EventContext) {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: t.walletId,
      data: {
        ...base(t, balance),
        referenceExternalTransactionId: t.referenceExternalTransactionId!,
        attempts: t.attempts,
        nextAttemptAt: t.nextAttemptAt?.toISOString(),
      },
    });
  }
}

// ---- WalletBalanceChanged: SOMENTE quando o saldo muda
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext) {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

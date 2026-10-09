import { InvalidOutboxStateError } from './errors';
import type { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** Nasce pendente e já devida. O id da mensagem é o eventId (serve de dedup no SQS FIFO). */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial (1s, 2s, 4s... teto 60s). */
  scheduleRetry(now: Date): void {
    this.assertPending('scheduleRetry');
    this._attempts += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this._attempts - 1), RETRY_MAX_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  toState(): OutboxMessageState {
    return {
      id: this.id, aggregateId: this.aggregateId, eventType: this.eventType, payload: this.payload,
      occurredAt: this.occurredAt, attempts: this._attempts, nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
    };
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError(`cannot ${action}: message ${this.id} is already published`);
    }
  }
}

import type { OutboxMessage } from '../../domain/outbox-message';
import type { SqlExecutor } from '../database';

export class OutboxRepository {
  /** Chamado DENTRO da transação financeira: o evento só existe se o commit acontecer. */
  async insert(tx: SqlExecutor, message: OutboxMessage): Promise<void> {
    const s = message.toState();
    await tx.query(
      `INSERT INTO outbox_messages
         (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, ?)`,
      [s.id, s.aggregateId, s.eventType, JSON.stringify(s.payload), s.occurredAt.toISOString(),
       s.attempts, (s.nextAttemptAt ?? s.occurredAt).toISOString(), s.publishedAt?.toISOString() ?? null],
    );
  }
}

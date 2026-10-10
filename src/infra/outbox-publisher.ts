import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../domain/outbox-message';
import type { Database } from './database';

interface Row {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string | Date;
  attempts: number | string;
  next_attempt_at: string | Date;
}

/**
 * Publica a outbox no SQS. Vários publishers (instâncias) podem rodar juntos:
 * FOR UPDATE SKIP LOCKED faz cada um pegar um lote diferente, sem bloquear os outros.
 * Se o processo morrer entre o envio e o commit, a linha continua pendente e o evento
 * é reenviado (at-least-once). O MessageDeduplicationId = eventId cobre a janela de 5 min
 * do SQS FIFO e o consumidor final deduplica pelo eventId.
 */
export class OutboxPublisher {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly batchSize = 20,
    private readonly pollMs = 500,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // Ganchos de ciclo de vida do Nest (enableShutdownHooks cobre o SIGTERM).
  onApplicationBootstrap() { this.start(); }
  async onModuleDestroy() { await this.stop(); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight; // termina o lote em andamento antes de fechar
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inflight = this.publishBatch()
        .then((n) => this.schedule(n >= this.batchSize ? 0 : this.pollMs))
        .catch((err) => {
          console.error(JSON.stringify({ level: 'error', msg: 'outbox batch failed', err: String(err) }));
          this.schedule(this.pollMs * 4);
        });
    }, ms);
  }

  /** Um lote numa transação SQL. Retorna quantas mensagens processou. */
  async publishBatch(): Promise<number> {
    const now = this.clock();
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<Row>(
        `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
           FROM outbox_messages
          WHERE published_at IS NULL AND next_attempt_at <= ?
          ORDER BY next_attempt_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [now.toISOString(), this.batchSize],
      );

      for (const r of rows) {
        const msg = OutboxMessage.rehydrate({
          id: r.id, aggregateId: r.aggregate_id, eventType: r.event_type, payload: r.payload,
          occurredAt: new Date(r.occurred_at), attempts: Number(r.attempts),
          nextAttemptAt: new Date(r.next_attempt_at),
        });
        try {
          await this.sqs.send(new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify(r.payload),
            MessageGroupId: r.aggregate_id,
            MessageDeduplicationId: r.id,
          }));
          msg.markPublished(now);
          await tx.query(`UPDATE outbox_messages SET published_at = ? WHERE id = ?`, [now.toISOString(), r.id]);
        } catch (err) {
          msg.scheduleRetry(now); // backoff exponencial do próprio domínio
          const s = msg.toState();
          await tx.query(
            `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ?`,
            [s.attempts, s.nextAttemptAt!.toISOString(), r.id],
          );
          console.warn(JSON.stringify({ level: 'warn', msg: 'outbox publish failed', eventId: r.id, attempts: s.attempts, err: String(err) }));
        }
      }
      return rows.length;
    });
  }
}
import type { SqlExecutor } from '../database';

export interface InboxRef {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export class InboxRepository {
  async receive(tx: SqlExecutor, m: InboxRef, now: Date): Promise<void> {
    await tx.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [m.consumerName, m.messageId, m.payloadHash, now.toISOString()],
    );
  }

  async markProcessed(tx: SqlExecutor, m: InboxRef, now: Date): Promise<void> {
    await tx.query(
      `UPDATE inbox_messages SET processed_at = ?
        WHERE consumer_name = ? AND message_id = ? AND processed_at IS NULL`,
      [now.toISOString(), m.consumerName, m.messageId],
    );
  }
}
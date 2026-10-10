import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

// uso: bun scripts/send-message.ts <walletId> <playerId> <externalId> <kind> <amount> [messageId]
const [walletId, playerId, externalId, kind, amount, messageId = `msg-${externalId}`] = process.argv.slice(2);
const sqs = new SQSClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL });

await sqs.send(new SendMessageCommand({
  QueueUrl: process.env.SQS_QUEUE_URL!,
  MessageGroupId: walletId!,
  MessageDeduplicationId: randomUUID(), // burla a dedup do FIFO de propósito: quem tem que deduplicar é a inbox
  MessageBody: JSON.stringify({
    messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a', externalTransactionId: externalId, idempotencyKey: `provider-a:${externalId}`,
      playerId, walletId, roundId: 'r1', gameId: 'g1', kind, money: { amount, currency: 'BRL' },
    },
  }),
}));
console.log('enviada', messageId);
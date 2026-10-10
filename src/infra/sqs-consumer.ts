import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand,
  type Message, type SQSClient,
} from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import type { SubmitTransactionCommand, SubmitTransactionUseCase } from '../application/submit-transaction';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { InvalidPayloadError } from '../http/invalid-payload.error';

const CONSUMER_NAME = 'wager-transactions-consumer';
const REQUIRED = ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId'] as const;

// Erros que reenviar não resolve: vão direto para a DLQ (ficam auditáveis).
const PERMANENT_CODES = new Set([
  'INVALID_PAYLOAD', 'INVALID_MONEY', 'INVALID_WAGER_TRANSACTION', 'CURRENCY_MISMATCH',
  'WALLET_NOT_FOUND', 'IDEMPOTENCY_CONFLICT',
]);

function isPermanent(err: unknown): boolean {
  if (err instanceof SyntaxError) return true; // JSON malformado
  const code = (err as { code?: string } | null)?.code;
  return !!code && PERMANENT_CODES.has(code);
}

function toCommand(body: string): SubmitTransactionCommand {
  const env = JSON.parse(body);
  if (env?.type !== 'WagerTransactionRequested' || typeof env.messageId !== 'string') {
    throw new InvalidPayloadError('unexpected message type or missing messageId');
  }
  const d = env.data ?? {};
  for (const f of REQUIRED) {
    if (typeof d[f] !== 'string' || !d[f]) throw new InvalidPayloadError(`${f} is required`);
  }
  if (!Object.values(WagerTransactionKind).includes(d.kind)) throw new InvalidPayloadError('invalid kind');
  if (typeof d.money?.amount !== 'string' || typeof d.money?.currency !== 'string') {
    throw new InvalidPayloadError('money must be { amount: string, currency: string }');
  }
  return {
    idempotencyKey: d.idempotencyKey, providerId: d.providerId,
    externalTransactionId: d.externalTransactionId, playerId: d.playerId, walletId: d.walletId,
    roundId: d.roundId, gameId: d.gameId, kind: d.kind, money: d.money,
    referenceExternalTransactionId: d.referenceExternalTransactionId,
    correlationId: env.messageId, causationId: env.messageId,
    inbox: {
      consumerName: CONSUMER_NAME,
      messageId: env.messageId,
      payloadHash: createHash('sha256').update(body).digest('hex'),
    },
  };
}

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra }));

export class SqsConsumer {
  private stopped = true;
  private loopPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly submit: SubmitTransactionUseCase,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
  ) {}

  onApplicationBootstrap() { this.start(); }
  async onModuleDestroy() { await this.stop(); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  /** SIGTERM: para de buscar, termina a mensagem em andamento e devolve as que sobraram no lote. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const out = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 5,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));
        for (const m of out.Messages ?? []) {
          if (this.stopped) await this.changeVisibility(m, 0); // devolve sem esperar o timeout
          else await this.handle(m);
        }
      } catch (err) {
        log('error', 'receive failed', { err: String(err) });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async handle(m: Message): Promise<void> {
    try {
      await this.submit.execute(toCommand(m.Body ?? ''));
      // Negócio (inclusive REJECTED) é resultado terminal: só chegamos aqui DEPOIS do commit.
      await this.ack(m);
    } catch (err) {
      if (isPermanent(err)) {
        await this.deadLetter(m, err);
      } else {
        // Transitório (banco fora, deadlock...): volta à fila com backoff. Após 5 recebimentos o SQS move para a DLQ.
        const receives = Number(m.Attributes?.ApproximateReceiveCount ?? 1);
        const delay = Math.min(2 ** receives, 60);
        log('warn', 'transient failure, will retry', { messageId: m.MessageId, receives, delay, err: String(err) });
        await this.changeVisibility(m, delay);
      }
    }
  }

  private async deadLetter(m: Message, err: unknown): Promise<void> {
    try {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.dlqUrl, MessageBody: m.Body ?? '',
        MessageGroupId: 'permanent-failures', MessageDeduplicationId: m.MessageId!,
        MessageAttributes: { error: { DataType: 'String', StringValue: String(err).slice(0, 500) } },
      }));
      log('error', 'permanent failure sent to DLQ', { messageId: m.MessageId, err: String(err) });
      await this.ack(m);
    } catch (e) {
      log('error', 'could not send to DLQ, will retry', { messageId: m.MessageId, err: String(e) });
      await this.changeVisibility(m, 5);
    }
  }

  private ack(m: Message) {
    return this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: m.ReceiptHandle! }));
  }

  private changeVisibility(m: Message, seconds: number) {
    return this.sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl, ReceiptHandle: m.ReceiptHandle!, VisibilityTimeout: seconds,
    })).catch(() => undefined);
  }
}
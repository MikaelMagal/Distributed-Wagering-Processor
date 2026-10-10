import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { OpenWalletUseCase } from './application/open-wallet';
import { SubmitTransactionUseCase } from './application/submit-transaction';
import { Database } from './infra/database';
import { DomainExceptionFilter } from './http/domain-exception.filter';
import { HealthController } from './http/health.controller';
import { QueriesController } from './http/queries.controller';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { OutboxPublisher } from './infra/outbox-publisher';
import { PendingReferenceWorker } from './infra/pending-reference-worker';
import { SqsConsumer } from './infra/sqs-consumer';

const sqsClient = () =>
  new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.AWS_ENDPOINT_URL });

@Module({
  controllers: [WalletsController, WageringController, QueriesController, HealthController],
  providers: [
    { provide: Database, useFactory: () => Database.connect() },
    { provide: OpenWalletUseCase, useFactory: (db: Database) => new OpenWalletUseCase(db), inject: [Database] },
    { provide: SubmitTransactionUseCase, useFactory: (db: Database) => new SubmitTransactionUseCase(db), inject: [Database] },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    {
      provide: OutboxPublisher,
      inject: [Database],
      useFactory: (db: Database) => new OutboxPublisher(db, sqsClient(), process.env.SQS_EVENTS_QUEUE_URL!),
    },
    {
      provide: SqsConsumer,
      inject: [SubmitTransactionUseCase],
      useFactory: (submit: SubmitTransactionUseCase) =>
        new SqsConsumer(submit, sqsClient(), process.env.SQS_QUEUE_URL!, process.env.SQS_DLQ_URL!),
    },
    {
      provide: PendingReferenceWorker,
      inject: [Database, SubmitTransactionUseCase],
      useFactory: (db: Database, submit: SubmitTransactionUseCase) => new PendingReferenceWorker(db, submit),
    },
  ],
})
export class AppModule {}
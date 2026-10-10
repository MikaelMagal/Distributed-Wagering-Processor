import { Body, Controller, Headers, Inject, Post, Res } from '@nestjs/common';
import { SubmitTransactionUseCase } from '../application/submit-transaction';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { InvalidPayloadError } from './invalid-payload.error';

const REQUIRED = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId'] as const;

@Controller('wagering/transactions')
export class WageringController {
  constructor(@Inject(SubmitTransactionUseCase) private readonly submit: SubmitTransactionUseCase) {}

  @Post()
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() b: Record<string, any>,
    @Res({ passthrough: true }) res: { status(c: number): unknown },
  ) {
    if (!idempotencyKey?.trim()) throw new InvalidPayloadError('Idempotency-Key header is required');
    for (const f of REQUIRED) {
      if (typeof b?.[f] !== 'string' || !b[f]) throw new InvalidPayloadError(`${f} is required`);
    }
    if (!Object.values(WagerTransactionKind).includes(b.kind)) throw new InvalidPayloadError('invalid kind');
    if (typeof b.money?.amount !== 'string' || typeof b.money?.currency !== 'string') {
      throw new InvalidPayloadError('money must be { amount: string, currency: string }');
    }

    const r = await this.submit.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: b.providerId, externalTransactionId: b.externalTransactionId,
      playerId: b.playerId, walletId: b.walletId, roundId: b.roundId, gameId: b.gameId,
      kind: b.kind, money: b.money,
      referenceExternalTransactionId: b.referenceExternalTransactionId,
      correlationId,
    });

    // 200 replay/processado | 202 aguardando referência | 422 rejeitada por regra de negócio
    res.status(
      r.status === WagerTransactionStatus.Rejected ? 422
      : r.status === WagerTransactionStatus.PendingReference ? 202
      : r.idempotentReplay ? 200 : 201,
    );
    return {
      transactionId: r.transactionId,
      status: r.status,
      balance: r.balance.toJSON(),
      failureCode: r.failureCode,
      idempotentReplay: r.idempotentReplay,
    };
  }
}
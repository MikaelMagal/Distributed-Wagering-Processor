import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';

interface Res {
  status(code: number): Res;
  setHeader(k: string, v: string): Res;
  json(body: unknown): Res;
}

// 400 payload inválido | 404 não existe | 409 conflito | 503 transitório (reenviar igual) | 500 bug
const STATUS_BY_CODE: Record<string, number> = {
  INVALID_PAYLOAD: 400,
  '22P02': 400, // UUID malformado (erro do Postgres): payload inválido, não 500
  INVALID_MONEY: 400,
  INVALID_WAGER_TRANSACTION: 400,
  CURRENCY_MISMATCH: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  CONCURRENT_MODIFICATION: 503,
};
const TRANSIENT_PG_OR_NET = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01', '53300']);

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Res>();
    if (err instanceof HttpException) {
      return res.status(err.getStatus()).json({ error: { code: 'HTTP_ERROR', message: err.message } });
    }
    const e = err as { code?: string; message?: string };
    const code = e?.code ?? 'INTERNAL_ERROR';
    const status = STATUS_BY_CODE[code] ?? (TRANSIENT_PG_OR_NET.has(code) ? 503 : 500);
    if (status === 503) res.setHeader('Retry-After', '1');
    if (status === 500) {
      console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', err: String(err) }));
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return res.status(status).json({ error: { code, message: e.message } });
  }
}
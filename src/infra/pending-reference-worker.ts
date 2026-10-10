import type { SubmitTransactionUseCase } from '../application/submit-transaction';
import type { Database } from './database';
import { WagerTransactionRepository } from './repositories/wager-transaction.repository';

/**
 * Worker agendado: reprocessa transações PENDING_REFERENCE vencidas.
 * Seguro com várias instâncias: cada reprocessamento trava a wallet e relê o estado,
 * então só uma instância aplica o efeito; as outras veem a transação já resolvida.
 */
export class PendingReferenceWorker {
  private readonly transactions = new WagerTransactionRepository();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly submit: SubmitTransactionUseCase,
    private readonly batchSize = 20,
    private readonly pollMs = 2000,
    private readonly clock: () => Date = () => new Date(),
  ) {}

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
    await this.inflight;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inflight = this.runOnce()
        .then((n) => this.schedule(n >= this.batchSize ? 0 : this.pollMs))
        .catch((err) => {
          console.error(JSON.stringify({ level: 'error', msg: 'pending-reference worker failed', err: String(err) }));
          this.schedule(this.pollMs * 2);
        });
    }, ms);
  }

  async runOnce(): Promise<number> {
    const due = await this.transactions.findDuePendingReference(this.db, this.clock(), this.batchSize);
    for (const { id, walletId } of due) {
      try {
        await this.submit.reprocessPending(id, walletId);
      } catch (err) {
        // Um erro numa transação não trava as outras; ela volta no próximo ciclo.
        console.warn(JSON.stringify({ level: 'warn', msg: 'reprocess failed', transactionId: id, walletId, err: String(err) }));
      }
    }
    return due.length;
  }
}
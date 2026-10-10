import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { OpenWalletUseCase } from '../application/open-wallet';
import { WalletNotFoundError } from '../application/errors';
import { Database } from '../infra/database';
import { WalletRepository } from '../infra/repositories/wallet.repository';
import type { Wallet } from '../domain/wallet';
import { InvalidPayloadError } from './invalid-payload.error';

const view = (w: Wallet) => ({
  id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version,
});

interface ReconRow {
  currency: string;
  stored: string;
  calculated: string;
  difference: string;
  entries: string;
  consistent: boolean;
}

@Controller('wallets')
export class WalletsController {
  private readonly wallets = new WalletRepository();
  constructor(
    @Inject(OpenWalletUseCase) private readonly open: OpenWalletUseCase,
    @Inject(Database) private readonly db: Database,
  ) {}

  @Post()
  async create(@Body() b: Record<string, any>, @Res({ passthrough: true }) res: { status(c: number): unknown }) {
    if (typeof b?.playerId !== 'string' || !b.playerId) throw new InvalidPayloadError('playerId is required');
    if (typeof b.initialBalance?.amount !== 'string') throw new InvalidPayloadError('initialBalance is required');
    const wallet = await this.open.execute({ playerId: b.playerId, initialBalance: b.initialBalance });
    res.status(201);
    return view(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') id: string) {
    const w = await this.wallets.findById(this.db, id);
    if (!w) throw new WalletNotFoundError(id);
    return view(w);
  }

  /**
   * Compara o saldo materializado com a soma do ledger. NÃO corrige nada:
   * divergência é logada e sinalizada na resposta (consistent: false).
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const rows = await this.db.query<ReconRow>(
      `WITH l AS (
         SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2) AS calc,
                COUNT(*) AS n
           FROM wallet_ledger_entries WHERE wallet_id = ?
       )
       SELECT w.currency AS currency,
              w.balance::text AS stored,
              l.calc::text AS calculated,
              (w.balance - l.calc)::text AS difference,
              l.n::text AS entries,
              (w.balance = l.calc) AS consistent
         FROM wallets w, l WHERE w.id = ?`,
      [walletId, walletId],
    );
    const r = rows[0];
    if (!r) throw new WalletNotFoundError(walletId);
    const currency = r.currency.trim();
    const money = (amount: string) => ({ amount, currency });

    if (!r.consistent) {
      console.error(JSON.stringify({
        level: 'error', msg: 'wallet reconciliation divergence', walletId,
        storedBalance: r.stored, calculatedBalance: r.calculated, difference: r.difference,
      }));
    }
    return {
      walletId,
      storedBalance: money(r.stored),
      calculatedBalance: money(r.calculated),
      difference: money(r.difference),
      consistent: r.consistent,
      checkedEntries: Number(r.entries),
    };
  }
}
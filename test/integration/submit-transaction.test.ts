import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError,
} from '../../src/application/errors';
import { InvalidMoneyError, InvalidWagerTransactionError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import {
  WagerTransactionKind as K, WagerTransactionStatus as S,
} from '../../src/domain/wager-transaction';
import { newId } from '../../src/shared/ids';
import {
  assertWalletInvariants, balanceOf, brl, cmd, ledgerOf, startInstances,
} from './helpers';

let app: Awaited<ReturnType<typeof startInstances>>;
const db = () => app.dbs[0]!;
const wallet = (initial = '100.00') =>
  app.openWallet.execute({ playerId: newId(), initialBalance: brl(initial) });
/** Distribui as chamadas entre as 3 "instâncias" da aplicação. */
const on = (i: number) => app.submit[i % app.submit.length]!;

beforeAll(async () => { app = await startInstances(3); });
afterAll(async () => { await app.close(); });

describe('abertura de wallet', () => {
  test('saldo inicial gera transação OPENING + lançamento CREDIT (balanceBefore = 0)', async () => {
    const w = await wallet('1000.00');
    const ledger = await ledgerOf(db(), w.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: 'CREDIT', amount: '1000.00', balance_before: '0.00', balance_after: '1000.00' });
    const [t] = await db().query<{ kind: string; status: string }>(
      `SELECT kind, status FROM wager_transactions WHERE wallet_id = ?`, [w.id]);
    expect(t).toMatchObject({ kind: 'OPENING', status: 'PROCESSED' });
    await assertWalletInvariants(db(), w.id);
  });

  test('saldo inicial zero não gera ledger', async () => {
    const w = await wallet('0.00');
    expect(await ledgerOf(db(), w.id)).toHaveLength(0);
  });

  test('mesma combinação player + moeda é conflito', async () => {
    const w = await wallet();
    await expect(app.openWallet.execute({ playerId: w.playerId, initialBalance: brl('5.00') }))
      .rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });
});

describe('cenário obrigatório (concorrência)', () => {
  test('saldo 100.00, duas apostas de 80.00 simultâneas em instâncias diferentes', async () => {
    const w = await wallet('100.00');
    const results = await Promise.all([
      on(0).execute(cmd(w, { money: '80.00' })),
      on(1).execute(cmd(w, { money: '80.00' })),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([S.Processed, S.Rejected]);
    expect(results.find((r) => r.status === S.Rejected)!.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await balanceOf(db(), w.id)).toBe('20.00');

    const debits = (await ledgerOf(db(), w.id)).filter((e) => e.direction === 'DEBIT');
    expect(debits).toHaveLength(1);
    await assertWalletInvariants(db(), w.id, { strictDistinctBefore: true });
  });

  test('30 apostas de 10.00 em 3 instâncias, saldo 100.00: exatamente 10 passam', async () => {
    const w = await wallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => on(i).execute(cmd(w, { money: '10.00' }))),
    );
    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(10);
    expect(results.filter((r) => r.status === S.Rejected)).toHaveLength(20);
    expect(await balanceOf(db(), w.id)).toBe('0.00');
    expect((await ledgerOf(db(), w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(10);
    await assertWalletInvariants(db(), w.id, { strictDistinctBefore: true });
  }, 30_000);

  test('wallets diferentes em paralelo: cada uma fecha certo', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => wallet('100.00')));
    const all = await Promise.all(
      wallets.flatMap((w, wi) =>
        Array.from({ length: 4 }, (_, i) => on(wi + i).execute(cmd(w, { money: '30.00' })).then((r) => ({ w, r }))),
      ),
    );
    for (const w of wallets) {
      const mine = all.filter((x) => x.w.id === w.id).map((x) => x.r);
      expect(mine.filter((r) => r.status === S.Processed)).toHaveLength(3);
      expect(await balanceOf(db(), w.id)).toBe('10.00');
      await assertWalletInvariants(db(), w.id, { strictDistinctBefore: true });
    }
  }, 30_000);
});

describe('idempotência', () => {
  test('50 requisições idênticas simultâneas: 1 efeito, 49 replays, mesmo transactionId', async () => {
    const w = await wallet('100.00');
    const same = cmd(w, { money: '30.00' });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => on(i).execute(same)));

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await balanceOf(db(), w.id)).toBe('70.00');
    expect((await ledgerOf(db(), w.id)).filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
    await assertWalletInvariants(db(), w.id);
  }, 30_000);

  test('replay devolve o saldo ORIGINAL, mesmo depois de outras movimentações', async () => {
    const w = await wallet('100.00');
    const first = cmd(w, { money: '30.00' });
    const r1 = await on(0).execute(first);
    await on(1).execute(cmd(w, { money: '10.00' }));
    const replay = await on(2).execute(first);

    expect(r1.balance.toJSON().amount).toBe('70.00');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.toJSON().amount).toBe('70.00'); // e não 60.00
    expect(replay.status).toBe(S.Processed);
  });

  test('replay de uma rejeição devolve a mesma rejeição', async () => {
    const w = await wallet('10.00');
    const big = cmd(w, { money: '50.00' });
    const r1 = await on(0).execute(big);
    const r2 = await on(1).execute(big);
    expect(r1.status).toBe(S.Rejected);
    expect(r2).toMatchObject({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds, idempotentReplay: true });
    expect(r2.transactionId).toBe(r1.transactionId);
  });

  test('mesma key com payload diferente é CONFLITO, não replay', async () => {
    const w = await wallet('100.00');
    const a = cmd(w, { money: '10.00' });
    await on(0).execute(a);
    await expect(on(1).execute({ ...a, money: { amount: '11.00', currency: 'BRL' } }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await balanceOf(db(), w.id)).toBe('90.00');
  });

  test('mesmo externalTransactionId com outra idempotency key também é conflito', async () => {
    const w = await wallet('100.00');
    const a = cmd(w);
    await on(0).execute(a);
    await expect(on(1).execute({ ...a, idempotencyKey: 'outra-key' }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('"25" e "25.00" são o mesmo payload (replay, não conflito)', async () => {
    const w = await wallet('100.00');
    const a = cmd(w, { money: '25.00' });
    await on(0).execute(a);
    const r = await on(1).execute({ ...a, money: { amount: '25', currency: 'BRL' } });
    expect(r.idempotentReplay).toBe(true);
  });
});

describe('regras de negócio', () => {
  test('LOSS é PROCESSED sem mexer em saldo nem ledger', async () => {
    const w = await wallet('100.00');
    const r = await on(0).execute(cmd(w, { kind: K.Loss, money: '40.00' }));
    expect(r.status).toBe(S.Processed);
    expect(r.balance.toJSON().amount).toBe('100.00');
    expect(await ledgerOf(db(), w.id)).toHaveLength(1); // só o OPENING
    await assertWalletInvariants(db(), w.id);
  });

  test('WIN credita', async () => {
    const w = await wallet('100.00');
    const r = await on(0).execute(cmd(w, { kind: K.Win, money: '25.50' }));
    expect(r.balance.toJSON().amount).toBe('125.50');
    await assertWalletInvariants(db(), w.id);
  });

  test('REFUND devolve a BET; segunda reversão (REFUND ou ROLLBACK) é rejeitada', async () => {
    const w = await wallet('100.00');
    const bet = cmd(w, { money: '40.00' });
    await on(0).execute(bet);
    const refund = await on(1).execute(
      cmd(w, { kind: K.Refund, money: '40.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(refund.status).toBe(S.Processed);
    expect(refund.balance.toJSON().amount).toBe('100.00');

    const again = await on(2).execute(
      cmd(w, { kind: K.Refund, money: '40.00', referenceExternalTransactionId: bet.externalTransactionId }));
    const rollback = await on(0).execute(
      cmd(w, { kind: K.Rollback, money: '40.00', referenceExternalTransactionId: bet.externalTransactionId }));
    expect(again).toMatchObject({ status: S.Rejected, failureCode: FailureCode.AlreadyReversed });
    expect(rollback).toMatchObject({ status: S.Rejected, failureCode: FailureCode.AlreadyReversed });

    expect(await balanceOf(db(), w.id)).toBe('100.00'); // creditou UMA vez
    expect(await ledgerOf(db(), w.id)).toHaveLength(3); // opening, bet, refund
    await assertWalletInvariants(db(), w.id);
  });

  test('reversões concorrentes da mesma BET: só uma vale', async () => {
    const w = await wallet('100.00');
    const bet = cmd(w, { money: '40.00' });
    await on(0).execute(bet);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        on(i).execute(cmd(w, {
          kind: i % 2 ? K.Refund : K.Rollback, money: '40.00',
          referenceExternalTransactionId: bet.externalTransactionId,
        }))),
    );
    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(1);
    expect(await balanceOf(db(), w.id)).toBe('100.00');
    await assertWalletInvariants(db(), w.id);
  });

  test('ROLLBACK de WIN debita; se estourar o saldo, código distinto do de aposta sem saldo', async () => {
    const w = await wallet('100.00');
    await on(0).execute(cmd(w, { money: '100.00' }));                       // saldo 0
    const win = cmd(w, { kind: K.Win, money: '50.00' });
    await on(0).execute(win);                                               // saldo 50
    await on(1).execute(cmd(w, { money: '50.00' }));                        // saldo 0

    const rb = await on(2).execute(
      cmd(w, { kind: K.Rollback, money: '50.00', referenceExternalTransactionId: win.externalTransactionId }));
    expect(rb).toMatchObject({ status: S.Rejected, failureCode: FailureCode.ReversalWouldOverdraw });

    const bet = await on(0).execute(cmd(w, { money: '1.00' }));
    expect(bet).toMatchObject({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds });
    await assertWalletInvariants(db(), w.id);
  });

  test('REFUND sobre WIN, valor diferente e referência de outro player são rejeitados', async () => {
    const w = await wallet('100.00');
    const other = await wallet('100.00');
    const bet = cmd(w, { money: '20.00' });
    const win = cmd(w, { kind: K.Win, money: '20.00' });
    await on(0).execute(bet);
    await on(0).execute(win);

    const onWin = await on(1).execute(cmd(w, { kind: K.Refund, money: '20.00', referenceExternalTransactionId: win.externalTransactionId }));
    const diffAmount = await on(1).execute(cmd(w, { kind: K.Refund, money: '19.00', referenceExternalTransactionId: bet.externalTransactionId }));
    const foreign = await on(1).execute(cmd(other, { kind: K.Refund, money: '20.00', referenceExternalTransactionId: bet.externalTransactionId }));

    expect(onWin.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect(diffAmount.failureCode).toBe(FailureCode.AmountMismatch);
    expect(foreign.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('referência ausente: fica PENDING_REFERENCE, sem tocar saldo nem ledger', async () => {
    const w = await wallet('100.00');
    const orphan = cmd(w, { kind: K.Refund, money: '10.00', referenceExternalTransactionId: 'ainda-nao-chegou' });
    const r = await on(0).execute(orphan);
    expect(r.status).toBe(S.PendingReference);
    expect(r.balance.toJSON().amount).toBe('100.00');
    expect(await ledgerOf(db(), w.id)).toHaveLength(1);
    expect((await on(1).execute(orphan)).idempotentReplay).toBe(true);
    await assertWalletInvariants(db(), w.id);
  });

  test('wallet de outro player e moeda diferente são rejeitadas com código próprio', async () => {
    const w = await wallet('100.00');
    const wrongPlayer = await on(0).execute({ ...cmd(w), playerId: newId() });
    const wrongCurrency = await on(0).execute({ ...cmd(w), money: { amount: '1.00', currency: 'USD' } });
    expect(wrongPlayer.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    expect(wrongCurrency.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(await balanceOf(db(), w.id)).toBe('100.00');
  });
});

describe('validação de entrada', () => {
  test('wallet inexistente', async () => {
    await expect(on(0).execute({ ...cmd({ id: newId(), playerId: newId() }) }))
      .rejects.toBeInstanceOf(WalletNotFoundError);
  });
  test('OPENING não pode ser submetido', async () => {
    const w = await wallet();
    await expect(on(0).execute(cmd(w, { kind: K.Opening }))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
  });
  test('REFUND sem referência', async () => {
    const w = await wallet();
    await expect(on(0).execute(cmd(w, { kind: K.Refund }))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
  });
  test('valor com 3 casas decimais', async () => {
    const w = await wallet();
    await expect(on(0).execute(cmd(w, { money: '1.234' }))).rejects.toBeInstanceOf(InvalidMoneyError);
  });
});

describe('outbox', () => {
  const eventsOf = (walletId: string) =>
    db().query<{ event_type: string; payload: Record<string, any> }>(
      `SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id`,
      [walletId],
    );
  const types = async (walletId: string) => (await eventsOf(walletId)).map((e) => e.event_type).sort();

  test('BET processada gera Processed + BalanceChanged; replay não gera nada', async () => {
    const w = await wallet('50.00');
    const before = (await eventsOf(w.id)).length; // abertura não emite evento
    const ok = cmd(w, { money: '20.00' });
    await on(0).execute(ok);
    await on(1).execute(ok); // replay
    expect(await types(w.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(before).toBe(0);
  });

  test('LOSS gera Processed e NÃO gera BalanceChanged (saldo não mudou)', async () => {
    const w = await wallet('50.00');
    await on(0).execute(cmd(w, { kind: K.Loss, money: '5.00' }));
    expect(await types(w.id)).toEqual(['WagerTransactionProcessed']);
  });

  test('rejeitada gera Rejected; referência ausente gera PendingReference', async () => {
    const w = await wallet('50.00');
    await on(0).execute(cmd(w, { money: '500.00' }));
    await on(0).execute(cmd(w, { kind: K.Refund, money: '1.00', referenceExternalTransactionId: 'nao-existe' }));
    expect(await types(w.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });

  test('envelope: eventType/version no tipo, correlationId propagado, dinheiro como MoneyProps', async () => {
    const w = await wallet('50.00');
    await on(0).execute({ ...cmd(w, { money: '20.00' }), correlationId: 'corr-123', causationId: 'msg-9' });
    const bc = (await eventsOf(w.id)).find((e) => e.event_type === 'WalletBalanceChanged')!;
    expect(bc.payload).toMatchObject({
      eventType: 'WalletBalanceChanged', version: 1, aggregateId: w.id,
      correlationId: 'corr-123', causationId: 'msg-9',
      data: {
        direction: 'DEBIT', walletVersion: 2,
        money: { amount: '20.00', currency: 'BRL' },
        balanceBefore: { amount: '50.00', currency: 'BRL' },
        balanceAfter: { amount: '30.00', currency: 'BRL' },
      },
    });
    expect(typeof bc.payload.occurredAt).toBe('string');
  });

  test('atomicidade: crash antes do commit não deixa evento órfão na outbox', async () => {
    const w = await wallet('50.00');
    await expect(
      db().transaction(async (tx) => {
        await tx.query(
          `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
           VALUES (?, ?, 'X', '{}'::jsonb, now())`, [newId(), w.id]);
        throw new Error('crash antes do commit');
      }),
    ).rejects.toThrow('crash antes do commit');
    expect(await eventsOf(w.id)).toHaveLength(0);
  });
});

-- Saldo da wallet no momento em que a transação chegou ao estado atual.
-- Permite devolver, num replay idempotente, o saldo ORIGINAL (regra 7) até para LOSS e REJECTED, que não geram ledger.
ALTER TABLE wager_transactions
  ADD COLUMN observed_balance numeric(19,2) NOT NULL DEFAULT 0 CHECK (observed_balance >= 0);
ALTER TABLE wager_transactions ALTER COLUMN observed_balance DROP DEFAULT;

-- No máximo UMA reversão processada (REFUND ou ROLLBACK) por transação referenciada:
-- impede, por exemplo, REFUND + ROLLBACK da mesma BET creditando duas vezes.
DROP INDEX wager_tx_single_reversal_uk;
CREATE UNIQUE INDEX wager_tx_single_reversal_uk
  ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

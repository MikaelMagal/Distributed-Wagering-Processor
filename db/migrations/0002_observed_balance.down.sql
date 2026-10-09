DROP INDEX wager_tx_single_reversal_uk;
CREATE UNIQUE INDEX wager_tx_single_reversal_uk
  ON wager_transactions (reference_transaction_id, kind)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
ALTER TABLE wager_transactions DROP COLUMN observed_balance;

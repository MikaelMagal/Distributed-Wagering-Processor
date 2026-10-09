DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;
DROP FUNCTION IF EXISTS ledger_immutable();
DROP FUNCTION IF EXISTS wager_tx_terminal_guard();
DROP FUNCTION IF EXISTS wallets_enforce_version();

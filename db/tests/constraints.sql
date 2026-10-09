\set ON_ERROR_STOP off
INSERT INTO wallets (id, player_id, currency, balance) VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000aa','BRL',100.00);
\echo '--- 1. wallet duplicada (player+currency): deve FALHAR'
INSERT INTO wallets (id, player_id, currency, balance) VALUES
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000aa','BRL',0);
\echo '--- 2. saldo negativo: deve FALHAR'
UPDATE wallets SET balance = -1, version = 2 WHERE id='00000000-0000-0000-0000-000000000001';
\echo '--- 3. saldo muda sem incrementar version: deve FALHAR'
UPDATE wallets SET balance = 50 WHERE id='00000000-0000-0000-0000-000000000001';
\echo '--- 4. version muda sem saldo mudar: deve FALHAR'
UPDATE wallets SET version = 2 WHERE id='00000000-0000-0000-0000-000000000001';
\echo '--- 5. saldo + version corretos: deve PASSAR'
UPDATE wallets SET balance = 20, version = 2 WHERE id='00000000-0000-0000-0000-000000000001';

INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at)
VALUES ('10000000-0000-0000-0000-000000000001','p','t1','p:t1','h','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000aa','r1','g','BET',80,'BRL','PROCESSED',now());
\echo '--- 6. mesma idempotency key: deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
VALUES ('10000000-0000-0000-0000-000000000002','p','t2','p:t1','h2','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000aa','r1','g','BET',80,'BRL','PENDING');
\echo '--- 7. REFUND sem referencia: deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
VALUES ('10000000-0000-0000-0000-000000000003','p','t3','p:t3','h','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000aa','r1','g','REFUND',80,'BRL','PENDING');
\echo '--- 8. REJECTED sem failure_code: deve FALHAR'
INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
VALUES ('10000000-0000-0000-0000-000000000004','p','t4','p:t4','h','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000aa','r1','g','BET',80,'BRL','REJECTED');
\echo '--- 9. estado terminal nao muda: deve FALHAR'
UPDATE wager_transactions SET status='FAILED', failure_code='X' WHERE id='10000000-0000-0000-0000-000000000001';

\echo '--- 10. ledger aritmetica errada: deve FALHAR'
INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
VALUES ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','DEBIT',80,'BRL',100,30);
\echo '--- 11. ledger correto: deve PASSAR'
INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
VALUES ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','DEBIT',80,'BRL',100,20);
\echo '--- 12. 2o lancamento p/ mesma wallet+tx: deve FALHAR'
INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
VALUES ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','CREDIT',80,'BRL',20,100);
\echo '--- 13. UPDATE no ledger: deve FALHAR'
UPDATE wallet_ledger_entries SET amount = 1 WHERE id='20000000-0000-0000-0000-000000000001';
\echo '--- 14. DELETE no ledger: deve FALHAR'
DELETE FROM wallet_ledger_entries;
\echo '--- 15. TRUNCATE no ledger: deve FALHAR'
TRUNCATE wallet_ledger_entries;
\echo '--- 16. inbox duplicada: 2a deve FALHAR'
INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c','m1','h');
INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c','m1','h');

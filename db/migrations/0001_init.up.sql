-- Wallets: saldo materializado. Não-negatividade garantida no schema.
CREATE TABLE wallets (
  id          uuid PRIMARY KEY,
  player_id   uuid        NOT NULL,
  currency    char(3)     NOT NULL,
  balance     numeric(19,2) NOT NULL CHECK (balance >= 0),
  version     integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_player_currency_uk UNIQUE (player_id, currency)
);

-- version só incrementa quando o saldo muda (e incrementa sempre que muda).
CREATE FUNCTION wallets_enforce_version() RETURNS trigger AS $$
BEGIN
  IF NEW.balance IS DISTINCT FROM OLD.balance THEN
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'wallet version must increment by 1 when balance changes';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'wallet version must not change when balance is unchanged';
  END IF;
  IF NEW.currency <> OLD.currency OR NEW.player_id <> OLD.player_id THEN
    RAISE EXCEPTION 'wallet currency/player are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER wallets_version_trg BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION wallets_enforce_version();

-- Transações de aposta: idempotência persistente via UNIQUE.
CREATE TABLE wager_transactions (
  id                                uuid PRIMARY KEY,
  provider_id                       text    NOT NULL,
  external_transaction_id           text    NOT NULL,
  idempotency_key                   text    NOT NULL,
  payload_hash                      text    NOT NULL,
  wallet_id                         uuid    NOT NULL REFERENCES wallets(id),
  player_id                         uuid    NOT NULL,
  round_id                          text    NOT NULL,
  game_id                           text    NOT NULL,
  kind                              text    NOT NULL
    CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                            numeric(19,2) NOT NULL CHECK (amount > 0),
  currency                          char(3) NOT NULL,
  status                            text    NOT NULL
    CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  reference_external_transaction_id text,
  reference_transaction_id          uuid REFERENCES wager_transactions(id),
  failure_code                      text,
  attempts                          integer NOT NULL DEFAULT 0,
  next_attempt_at                   timestamptz,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  processed_at                      timestamptz,
  CONSTRAINT wager_tx_external_uk    UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_tx_idempotency_uk UNIQUE (provider_id, idempotency_key),
  CONSTRAINT wager_tx_reference_required CHECK (
    kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_failure_code CHECK (
    (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT wager_tx_processed_at CHECK (
    (status = 'PROCESSED') = (processed_at IS NOT NULL))
);
CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at);
-- Worker de PENDING_REFERENCE varre só o que está pendente e vencido.
CREATE INDEX wager_tx_pending_ref_idx ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';
-- Uma referência só pode ser revertida uma vez por tipo de operação (no schema).
CREATE UNIQUE INDEX wager_tx_single_reversal_uk
  ON wager_transactions (reference_transaction_id, kind)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');

-- Estados terminais não mudam mais.
CREATE FUNCTION wager_tx_terminal_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER wager_tx_terminal_trg BEFORE UPDATE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION wager_tx_terminal_guard();

-- Ledger imutável, com aritmética verificada no schema.
CREATE TABLE wallet_ledger_entries (
  id             uuid PRIMARY KEY,   -- UUIDv7: ordem estável para paginação por cursor
  wallet_id      uuid NOT NULL REFERENCES wallets(id),
  transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
  direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount         numeric(19,2) NOT NULL CHECK (amount > 0),
  currency       char(3) NOT NULL,
  balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),
  balance_after  numeric(19,2) NOT NULL CHECK (balance_after >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- no máximo um lançamento por wallet por transação
  CONSTRAINT ledger_wallet_tx_uk UNIQUE (wallet_id, transaction_id),
  CONSTRAINT ledger_balanced CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount))
);
CREATE INDEX ledger_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, id);

CREATE FUNCTION ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- Inbox: dedup persistente por (consumer, message).
CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id    text NOT NULL,
  payload_hash  text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

-- Outbox: publishers concorrentes usam FOR UPDATE SKIP LOCKED.
CREATE TABLE outbox_messages (
  id              uuid PRIMARY KEY,
  aggregate_id    text  NOT NULL,
  event_type      text  NOT NULL,
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at)
  WHERE published_at IS NULL;

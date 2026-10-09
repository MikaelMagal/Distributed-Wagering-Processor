# Distributed Wagering Processor

## Pré-requisitos
Bun 1.x, Docker + Docker Compose.

## Setup
```bash
cp .env.example .env
bun install
bun run infra:up        # Postgres 16 + LocalStack (filas FIFO + DLQ criadas no boot)
bun run migration:up    # aplica o schema (reversível: bun run migration:down)
bun run test:unit       # unidade (não precisa de infra)
bun run test:integration # integração/concorrência (precisa de infra:up + migration:up)
bun test test/unit test/integration   # tudo
```

## Validar as garantias do schema
```bash
psql postgres://wagering:wagering@localhost:5432/wagering -f db/tests/constraints.sql
```
Cada bloco imprime `deve FALHAR` / `deve PASSAR`; os que devem falhar mostram o `ERROR` da constraint.

## Status
- [x] Docker Compose, filas SQS FIFO + DLQ (redrive após 5 tentativas)
- [x] Schema com constraints, triggers e índices (migration up/down)
- [x] `Money` (decimal.js) + testes de unidade
- [x] Domínio: Wallet, WagerTransaction, WalletLedgerEntry, FailureCode, payloadHash canônico (85 testes)
- [x] Casos de uso OpenWallet e SubmitTransaction: lock por wallet, idempotência, regras de reversão, outbox atômica
- [x] Eventos de integração (envelope + 4 eventos) e OutboxMessage
- [x] Testes de concorrência com 3 instâncias (123 testes no total)
- [ ] API HTTP (NestJS), status HTTP, consultas com cursor, health
- [ ] Outbox publisher (SQS), consumer SQS com inbox/DLQ/shutdown, worker de PENDING_REFERENCE
- [ ] Reconciliação, observabilidade, testes de integração/concorrência

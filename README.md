# Distributed Wagering Processor

## Pré-requisitos
Bun 1.x, Docker + Docker Compose.

## Setup
```bash
cp .env.example .env
bun install
bun run infra:up        # Postgres 16 + LocalStack (filas FIFO + DLQ criadas no boot)
bun run migration:up    # aplica o schema (reversível: bun run migration:down)
bun test                # testes de unidade
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
- [ ] Wallet, WagerTransaction, ledger (domínio)
- [ ] API HTTP, idempotência, concorrência
- [ ] Inbox/outbox, consumer SQS, worker de PENDING_REFERENCE
- [ ] Reconciliação, observabilidade, testes de integração/concorrência

# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND,
ROLLBACK) de múltiplos provedores, com idempotência persistente, ledger imutável, inbox/outbox
transacionais e processamento por SQS. Decisões técnicas e limitações: [ARCHITECTURE.md](ARCHITECTURE.md).

Stack: Bun, TypeScript estrito, NestJS, PostgreSQL 16, MikroORM, AWS SQS (LocalStack), Docker Compose.

## Pré-requisitos
Bun 1.x e Docker + Docker Compose.

## Setup
```bash
cp .env.example .env      # no PowerShell: copy .env.example .env
bun install
bun run infra:up          # Postgres + LocalStack (filas FIFO, DLQ e fila de eventos criadas no boot)
bun run migration:up      # aplica o schema (reversível: bun run migration:down)
bun run start             # API em http://localhost:3000 + consumer SQS + publisher da outbox + worker
```
`bun run infra:down` derruba tudo e apaga os volumes.

## Testes
```bash
bun run typecheck
bun run test:unit          # unidade (não precisa de infra)
bun run test:integration   # PostgreSQL real; precisa de infra:up + migration:up
bun test test/unit test/integration   # tudo
```
Cobertura da integração: abertura de wallet, concorrência com 3 instâncias (incluindo o cenário
obrigatório 100.00 − 2 × 80.00), 50 requisições idênticas em paralelo, idempotência e conflito,
regras de reversão, referência fora de ordem e atomicidade da outbox.

Constraints do schema (cada bloco imprime `deve FALHAR` / `deve PASSAR`):
```bash
psql postgres://wagering:wagering@localhost:5433/wagering -f db/tests/constraints.sql
```

## API

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet; saldo inicial > 0 gera `OPENING` + lançamento `CREDIT` |
| `GET /wallets/:walletId` | Saldo e version |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Ledger paginado (cursor opaco, máx. 200) |
| `POST /wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |
| `POST /wallets/:walletId/reconciliation` | Compara saldo materializado com a soma do ledger (não corrige) |
| `GET /health/live`, `GET /health/ready` | Liveness / readiness (readiness verifica o PostgreSQL) |

Status HTTP: `400` payload inválido · `404` não encontrado · `409` conflito de idempotência ou
wallet duplicada · `422` rejeitada por regra de negócio (com `failureCode`) · `202` aguardando
referência · `201`/`200` processada nova / replay · `503` falha transitória (reenviar igual).

### Exemplo (PowerShell)
```powershell
$w = Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType 'application/json' `
  -Body (@{ playerId = [guid]::NewGuid().ToString(); initialBalance = @{ amount = '100.00'; currency = 'BRL' } } | ConvertTo-Json -Depth 5)
$bet = @{ providerId='provider-a'; externalTransactionId='bet-1'; playerId=$w.playerId; walletId=$w.id; roundId='r1'; gameId='g1'; kind='BET'; money=@{ amount='25.00'; currency='BRL' } } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions -ContentType 'application/json' `
  -Headers @{ 'Idempotency-Key' = 'provider-a:bet-1' } -Body $bet
```

### Entrada por SQS
Envia uma mensagem para `wager-transactions.fifo` (mesmo caso de uso da API):
```bash
bun scripts/send-message.ts <walletId> <playerId> <externalId> <kind> <amount> [messageId]
```
Eventos de integração são publicados pela outbox em `wager-events.fifo`.

## Status
- [x] Docker Compose, filas SQS FIFO + DLQ (redrive após 5 tentativas) e fila de eventos
- [x] Schema com constraints, triggers e índices (migrations up/down)
- [x] `Money` (decimal.js), domínio (Wallet, WagerTransaction, WalletLedgerEntry, FailureCode, payloadHash canônico)
- [x] Casos de uso OpenWallet e SubmitTransaction: lock por wallet, idempotência, reversões, outbox atômica
- [x] API HTTP NestJS, mapeamento de status, consultas com cursor, health
- [x] Outbox publisher (`FOR UPDATE SKIP LOCKED`), consumer SQS com inbox, DLQ e shutdown gracioso
- [x] Worker de `PENDING_REFERENCE` com backoff e limite de tentativas
- [x] Reconciliação de wallet
- [x] Testes de unidade e de integração/concorrência com PostgreSQL real
- [ ] Métricas, `correlationId` em todos os logs, readiness do SQS
- [ ] Testes automatizados do publisher, do consumer e do worker contra o LocalStack
- [ ] Autenticação (decisão e desenho em ARCHITECTURE.md) e teste de carga
# ARCHITECTURE

Serviço de processamento de apostas (wagering) distribuído. Este documento explica as decisões
técnicas, os trade-offs e as limitações conhecidas.

## 1. Visão geral

```
HTTP POST /wagering/transactions ─┐
                                  ├─► SubmitTransactionUseCase ─► PostgreSQL (1 transação SQL)
SQS wager-transactions.fifo ──────┘        │                        ├─ wager_transactions
   (SqsConsumer + inbox)                   │                        ├─ wallets (saldo)
                                           │                        ├─ wallet_ledger_entries
PendingReferenceWorker ─► reprocessPending │                        ├─ inbox_messages
                                           │                        └─ outbox_messages
                                           ▼
                        OutboxPublisher ─► SQS wager-events.fifo
```

Camadas: `domain` (regras puras, sem NestJS nem ORM), `application` (casos de uso),
`infra` (SQL, SQS, workers), `http` (controllers NestJS). Os controllers e o consumer SQS chamam
o **mesmo** `SubmitTransactionUseCase`, então HTTP e fila têm exatamente as mesmas regras.

## 2. Dinheiro

- `Money` é imutável e usa `decimal.js`. Nunca `number`.
- No contrato e nos eventos o valor é string decimal com 2 casas (`"25.00"`).
- No banco é `numeric(19,2)`, com `CHECK (amount > 0)` nas transações e `CHECK (balance >= 0)` nas wallets.
- Entradas inválidas (NaN, notação científica, mais de 2 casas, negativos) são rejeitadas na entrada.
- Moedas diferentes lançam erro de domínio. O desafio roda só com BRL, mas o modelo é multi-moeda.

## 3. Concorrência (múltiplas instâncias)

A unidade de concorrência é a `walletId`.

**Estratégia: lock pessimista por wallet** (`SELECT ... FOR UPDATE` na linha da wallet, dentro da
transação SQL). Quem chega depois na mesma wallet espera; wallets diferentes não se bloqueiam
(não há lock global). Como o lock vive no PostgreSQL, funciona igual com 1 ou N instâncias.

Por que pessimista e não otimista: em uma wallet "quente" (muitas apostas simultâneas), o otimista
gera retries em cascata; com o lock a fila é resolvida no banco, sem retry de aplicação.

Defesas adicionais, todas no schema:
- `UPDATE wallets ... WHERE version = <lida sob o lock>`: se algo escapar do lock, falha com
  `ConcurrentModificationError` (HTTP 503, o provedor reenvia).
- `CHECK (balance >= 0)`: mesmo um bug de aplicação não consegue gerar saldo negativo.
- Trigger `wallets_enforce_version`: `version` só incrementa em +1 quando o saldo muda.
- Deadlock (40P01) e falha de serialização (40001) repetem a transação inteira (até 3 vezes).

Cenário obrigatório (saldo 100.00, duas apostas de 80.00 em paralelo): a segunda só lê a wallet
depois do commit da primeira, vê saldo 20.00 e é `REJECTED` com `INSUFFICIENT_FUNDS`. Saldo final
20.00 e um único débito no ledger. Coberto em `test/integration` com 3 instâncias.

## 4. Idempotência

Persistente, no banco (nunca em memória):
- `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`.
- `payloadHash` = SHA-256 do JSON canônico (chaves ordenadas recursivamente, sem espaços, ausente
  vira `null`) dos **campos de negócio**: providerId, externalTransactionId, playerId, walletId,
  roundId, gameId, kind, money (normalizado via `Money`, então `"25"` e `"25.00"` são iguais) e
  referenceExternalTransactionId. O header `Idempotency-Key` e metadados de transporte
  (correlationId, inbox) ficam de fora, então o mesmo payload gera o mesmo hash por HTTP ou SQS.
- Mesma chave + mesmo hash → replay: devolve o resultado original com `idempotentReplay: true`.
  O saldo devolvido é o `observed_balance` gravado quando a transação chegou ao estado atual, não
  o saldo de agora.
- Mesma chave + hash diferente → `IDEMPOTENCY_CONFLICT` (HTTP 409).
- Se duas requisições com a mesma chave chegam por wallets diferentes ao mesmo tempo, o UNIQUE
  desempata e a perdedora refaz a transação (cai no caminho de replay ou de conflito).

## 5. Ledger e invariantes no schema

- `wallet_ledger_entries` é append-only: triggers bloqueiam UPDATE, DELETE e TRUNCATE.
- `CHECK` valida a aritmética de cada lançamento (`balance_after = balance_before ± amount`).
- `UNIQUE (wallet_id, transaction_id)`: no máximo um lançamento por wallet por transação.
- `LOSS` e transações `REJECTED` não geram lançamento.
- Estados terminais (`PROCESSED`, `REJECTED`, `FAILED`) não mudam mais: trigger no banco.
- Uma referência só pode ser revertida uma vez: índice único parcial em
  `reference_transaction_id` para REFUND/ROLLBACK `PROCESSED`. Isso impede, por exemplo,
  REFUND + ROLLBACK da mesma BET creditando duas vezes.
- Invariante global: `wallet.balance == soma do ledger`, verificada pela reconciliação (seção 9).
- As constraints são testadas em `db/tests/constraints.sql`.

## 6. Transições, reversões e códigos de falha

Transições válidas de `WagerTransaction` (`PROCESSED`, `REJECTED` e `FAILED` são terminais; o domínio
lança `InvalidTransactionStateError` e o banco bloqueia o UPDATE):

```
PENDING            → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE  → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
```

Rejeições carregam um `failureCode` estável (`src/domain/failure-code.ts`), cada um com a ação
sugerida ao provedor:

| Ação | Códigos |
|---|---|
| `GIVE_UP` (reenviar não muda nada) | INSUFFICIENT_FUNDS, REVERSAL_WOULD_OVERDRAW, REFERENCE_NOT_PROCESSED, ALREADY_REVERSED |
| `FIX_PAYLOAD` | REFERENCE_NOT_FOUND, REFERENCE_MISMATCH, INVALID_REFERENCE_KIND, AMOUNT_MISMATCH, CURRENCY_MISMATCH, PLAYER_WALLET_MISMATCH |
| `RETRY_LATER` | INFRASTRUCTURE_ERROR |

Decisões de interpretação:
- Reversão que deixaria o saldo negativo usa `REVERSAL_WOULD_OVERDRAW`, distinto de
  `INSUFFICIENT_FUNDS` (aposta sem saldo), pois são situações operacionais diferentes.
- Só há uma reversão processada por transação referenciada (REFUND **ou** ROLLBACK, não os dois).
- A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve ter o mesmo
  provider, player, wallet, moeda e rodada; REFUND só referencia BET; o valor deve ser igual.

## 7. Referências fora de ordem (worker de PENDING_REFERENCE)

REFUND/ROLLBACK cuja referência ainda não existe (ou ainda não está `PROCESSED`) entram em
`PENDING_REFERENCE`, sem tocar saldo nem ledger, e emitem `WagerTransactionPendingReference` uma
única vez. O `PendingReferenceWorker` varre as vencidas (índice parcial por `next_attempt_at`) e
chama `reprocessPending`, que **trava a wallet e só então relê a transação**: se outra instância já
a resolveu durante a espera do lock, nada é reaplicado.

Backoff exponencial de 2s até 5 min, limite de 10 tentativas (~13 min): um provedor que não envia
a referência nesse prazo provavelmente nunca vai enviar. Esgotado: `REJECTED` com
`REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.

## 8. Mensageria

**Inbox** (entrada SQS): o registro em `inbox_messages (consumer_name, message_id)` é gravado
**na mesma transação SQL** do saldo, ledger e outbox. Redelivery da mesma mensagem não duplica
efeitos: a idempotência da transação devolve o replay.

**Consumer** (`SqsConsumer`):
- `ack` (delete) só depois do commit.
- Resultado de negócio, inclusive `REJECTED`, é terminal: ack.
- Erro permanente (JSON malformado, payload inválido, wallet inexistente, conflito de
  idempotência): vai para a DLQ com o motivo em um atributo e recebe ack.
- Erro transitório: devolve a mensagem com `ChangeMessageVisibility` (backoff exponencial até
  60s). Após 5 recebimentos o SQS move para a DLQ (redrive policy da fila).
- `SIGTERM` (`enableShutdownHooks`): para de buscar, termina a mensagem em andamento e devolve
  as restantes do lote com visibilidade 0.
- A FIFO ordena e deduplica por grupo (`walletId`), mas isso é só otimização: as invariantes
  são garantidas pelo banco.

**Outbox transacional**: os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`,
`WagerTransactionPendingReference`, `WalletBalanceChanged`) são gravados na mesma transação
financeira, então nunca são publicados antes do commit nem se perdem depois dele.
- O `OutboxPublisher` lê lotes com `FOR UPDATE SKIP LOCKED`: vários publishers (instâncias)
  rodam juntos sem pegar as mesmas linhas e sem bloquear uns aos outros.
- Se o processo morre depois do commit e antes de publicar, a linha continua pendente e outra
  instância publica. Se morre depois de enviar e antes de marcar `published_at`, o evento sai de
  novo: entrega at-least-once. O `MessageDeduplicationId` é o `eventId` (cobre a janela de 5 min
  da FIFO) e o consumidor final deve deduplicar pelo `eventId`.
- Falha de publicação: `attempts + 1` e backoff exponencial (1s até 60s).
- Os eventos vão para uma fila própria (`wager-events.fifo`), separada da fila de entrada, para o
  consumer não ler os próprios eventos.

## 9. API, status HTTP e reconciliação

| Situação | Status |
|---|---|
| Payload inválido, header ausente, UUID ou cursor malformado | 400 |
| Wallet ou transação inexistente | 404 |
| Conflito de idempotência / wallet duplicada | 409 |
| Rejeitada por regra de negócio | 422 (com `failureCode` no corpo) |
| Aceita, aguardando referência | 202 |
| Processada (nova) / replay | 201 / 200 |
| Falha transitória (banco fora, modificação concorrente) | 503 + `Retry-After` |

Assim o provedor sabe, só pelo status, se deve reenviar igual (503), corrigir (400/422) ou parar.

O ledger é paginado por cursor opaco: o id do lançamento é UUIDv7 (ordenável), e a página seguinte
usa `id > cursor`, o que é estável mesmo com novos lançamentos chegando.

`POST /wallets/:id/reconciliation` compara `wallets.balance` com a soma do ledger numa única
consulta. Nunca corrige: divergência é logada (nível error) e sinalizada em `consistent: false`.

## 10. ORM

MikroORM 7 (`@mikro-orm/postgresql`), usado para conexão, pool, transações
(`em.transactional`) e migrations. As consultas são SQL parametrizado explícito
(`em.execute`). Motivo: as garantias do desafio (`FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT`,
constraints e triggers) ficam visíveis e auditáveis no SQL, sem depender de comportamento
implícito do Unit of Work.
Trade-off: não usamos Identity Map nem mapeamento de entidades; o mapeamento domínio ↔ linha é
feito à mão nos repositórios (`rehydrate`).

## 11. Autenticação

Não implementada, conforme permitido pelo desafio (não vale pontos). Desenho que eu adotaria:
Keycloak como IdP OIDC; um `AuthGuard` global do NestJS validando o JWT (JWKS) e extraindo o
`providerId` do token para comparar com o `providerId` do payload. Health checks ficam abertos
e as mensagens da fila são tratadas como canal interno confiável.

## 12. Limitações conhecidas

- **Observabilidade parcial**: logs JSON no consumer, publisher, worker e filtro de exceções, mas
  sem métricas (transações por status, duplicatas, retries, DLQ, conflitos de lock, lag da outbox)
  e sem `correlationId` em todos os logs. Divergências de reconciliação são logadas, mas não contadas.
- `/health/ready` verifica só o PostgreSQL, não o SQS.
- Testes de integração cobrem o caso de uso, a concorrência e a atomicidade da outbox com
  PostgreSQL real. O publisher, o consumer e o worker de `PENDING_REFERENCE` foram validados
  manualmente contra o LocalStack, sem testes automatizados.
- Sem teste de carga.
- O limite de 10 tentativas (~13 min) para referência ausente é uma escolha, não uma regra do
  provedor; deve ser calibrado com o tempo real de atraso observado.
- Um evento pode ser publicado mais de uma vez (at-least-once); a deduplicação final é do consumidor.
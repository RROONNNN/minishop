3. Your project: MiniShop
To exercise both RabbitMQ patterns without drowning in a huge domain, build a tiny shop with three small services. It maps one-to-one onto what you've learned:

catalog service — owns products (Mongo / Mongoose)
Exposes an RPC endpoint GET_PRODUCT_PATTERN (and CHECK_STOCK_PATTERN). Mirrors notification's document-store setup.
order service — places orders (Postgres / TypeORM)
A GraphQL mutation placeOrder → a PlaceOrderCommand handler that (1) calls RPC to catalog to check price/stock — it needs the answer now — then (2) publishes an order.placed event and returns. Mirrors payment's relational setup.
notification service — reacts (no DB)
@RabbitSubscribe to order.placed and “sends” a confirmation. It doesn't block the order; it just reacts. Pure pub/sub consumer.
Why this topic: order → catalog is a textbook RPC (synchronous, needs a reply), and order → notification is a textbook pub/sub (fire-and-forget, zero-or-many listeners). You'll also naturally build a catalog-service-types contract package and a catalog-service-sdk client — the exact patterns this repo uses for StorageClient.

4. Libraries to use
Keep the core stack that defines the architecture; drop the enterprise extras until you need them.

Core — keep (this is the architecture)
Runtime & workspace
pnpm workspaces, typescript, Node 20+.
Framework
@nestjs/core, @nestjs/common, @nestjs/platform-fastify.
GraphQL API
@nestjs/graphql, @nestjs/apollo, @apollo/server, graphql.
Messaging (Lesson 1)
@golevelup/nestjs-rabbitmq — the backbone of RPC + pub/sub.
Databases (use both, one per service, to mirror the repo)
Relational: @nestjs/typeorm, typeorm, pg. Document: @nestjs/mongoose, mongoose.
Validation / transform
class-validator, class-transformer.
Dev tooling
@biomejs/biome (lint + format), vitest (tests), husky + @commitlint/* + lint-staged (git hooks), syncpack (version pinning).
Drop for now — add only when the need is real
The repo also uses OpenTelemetry, nestjs-i18n, Winston, BullMQ, Redis cache + mutex, a permission/feature-access system, Excel export, and the @enosta-api/* query-core adapters. All valuable, none essential to learn the architecture. Start without them; you can layer BullMQ or Redis in once the three services talk to each other cleanly.

One thing you must build yourself
libs/common here is an internal package (@smartos/common) — the mediator, the RabbitMQ helpers, RequestContext, ServiceName, and the exchange-key functions all live there. For MiniShop you'll create a slim @minishop/common with just those pieces. That package is the architecture; the services are thin shells around it.
5. The folder tree (copy this)
minishop/
├─ package.json                 # pnpm workspaces + ordered build scripts (common→types→sdks→services)
├─ pnpm-workspace.yaml          # packages: libs/*, libs/types/*, libs/sdks/*, services/*
├─ biome.json                   # 4-space, single quotes, trailing commas, organize-imports
├─ vitest.workspace.ts
├─ commitlint.config.js         # conventional commits
├─ .syncpackrc.js  .lintstagedrc
├─ .husky/{commit-msg, pre-commit}
├─ docker-compose.yml           # rabbitmq + postgres + mongo (local infra)
│
├─ libs/
│  ├─ common/                        # @minishop/common  ── the backbone
│  │  └─ src/
│  │     ├─ constants/
│  │     │  ├─ service-name.enum.ts       # ServiceName enum (ORDER, CATALOG, NOTIFICATION)
│  │     │  └─ exchange-key.constant.ts   # directExchangeKey / topicExchangeKey / fanoutExchangeKey / queueKey
│  │     ├─ modules/
│  │     │  ├─ mediator/                  # BaseCommand/Query/Event, CommandHandler(), Mediator, MediatorModule
│  │     │  └─ request-context/           # AsyncLocalStorage RequestContext (+ serialize/deserialize)
│  │     ├─ utils/
│  │     │  └─ rabbitmq.utils.ts          # RpcHandler, callRpc, sendEvent   ← from Lesson 1
│  │     ├─ config.ts
│  │     └─ index.ts                      # barrel: export * from './...'
│  │
│  ├─ types/                         # CONTRACTS ONLY — no logic
│  │  ├─ catalog-service/            # @minishop/catalog-service-types
│  │  │  └─ src/
│  │  │     ├─ get-product.contract.ts    # GET_PRODUCT_PATTERN + GetProductRequest/Response
│  │  │     ├─ check-stock.contract.ts    # CHECK_STOCK_PATTERN + request/response
│  │  │     └─ index.ts
│  │  └─ order-service/              # @minishop/order-service-types
│  │     └─ src/
│  │        ├─ order.event.ts             # OrderPlacedEvent payload + routing keys
│  │        └─ index.ts
│  │
│  └─ sdks/
│     └─ catalog-service/            # @minishop/catalog-service-sdk
│        └─ src/
│           ├─ catalog.client.ts          # CatalogClient: one method per RPC pattern (wraps callRpc)
│           ├─ catalog.sdk.module.ts      # Nest module exporting the client
│           └─ index.ts
│
└─ services/
   ├─ catalog/                       # Mongo + Mongoose  (document data)
   │  └─ src/
   │     ├─ main.ts   app.module.ts   config.ts
   │     ├─ domain/entities/product.entity.ts
   │     ├─ modules/
   │     │  ├─ database.module.ts         # MongooseModule.forRoot / forFeature
   │     │  └─ communication.module.ts    # RabbitMQModule config (exchanges)
   │     └─ features/product/
   │        ├─ product.pms.module.ts          # GraphQL module
   │        ├─ product.integration.module.ts  # RPC-handler module
   │        ├─ core/{product.service.ts, product.interface.ts}
   │        ├─ use-cases/{create-product.command.ts, get-product.query.ts}
   │        ├─ resolvers/product.pms.resolver.ts
   │        └─ integrations/product.integration.handler.ts   # @RpcHandler GET_PRODUCT / CHECK_STOCK
   │
   ├─ order/                         # Postgres + TypeORM  (relational data)
   │  └─ src/
   │     ├─ main.ts   app.module.ts   config.ts   data-source.ts
   │     ├─ domain/{entities/order.entity.ts, enums/order-status.enum.ts}
   │     ├─ modules/{database.module.ts, communication.module.ts}
   │     └─ features/order/
   │        ├─ order.pms.module.ts
   │        ├─ core/{order.service.ts, order.interface.ts}
   │        ├─ use-cases/place-order.command.ts   # callRpc→catalog, then sendEvent('order.placed')
   │        └─ resolvers/order.pms.resolver.ts
   │
   └─ notification/                  # no DB — pure event consumer
      └─ src/
         ├─ main.ts   app.module.ts   config.ts
         ├─ modules/communication.module.ts
         └─ features/order-notification/
            ├─ order-notification.integration.module.ts
            └─ integrations/order-notification.integration.handler.ts   # @RabbitSubscribe 'order.placed'
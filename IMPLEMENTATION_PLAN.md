# MiniShop — Step-by-Step Implementation Plan

A learning-first guide to building the three-service MiniShop system. The goal is not just to make it work, but to understand **why** each piece exists and how the RabbitMQ patterns (RPC + pub/sub) and the monorepo contract layering fit together.

Read each step's **"Concept"** block before you write code. After each step there is a **"Verify"** block — do not move on until it passes. Build the system bottom-up (shared code first, services last) so that every layer you depend on already compiles.

---

## 0. The mental model (read this first)

### The domain, in one sentence
A customer places an order. The order service must know the product's **price and stock right now** (so it asks catalog and waits), then it **announces** the order happened (and doesn't care who listens).

### Two messaging patterns, one system
| Interaction | Pattern | Why | Who waits? |
|---|---|---|---|
| order → catalog (get price / check stock) | **RPC** (request/reply) | The order can't be created without an answer | Caller blocks for the reply |
| order → notification (order placed) | **Pub/Sub** (event) | Fire-and-forget; zero-or-many listeners | Nobody waits |

If you remember one thing: **RPC = "I need an answer now."  Event = "This happened, react if you care."**

### Dependency direction (never point the arrow backwards)
```
libs/common  ──►  libs/types/*  ──►  libs/sdks/*  ──►  services/*
 (helpers,        (contracts:        (typed client    (real business
  enums,           patterns +         wrapping RPC)     logic + DBs)
  rabbitmq utils)  DTOs, no logic)
```
- **common**: framework-agnostic backbone. No service knows about another service through it.
- **types**: pure contracts (a routing-key string + request/response interfaces). No runtime logic, no dependencies. This is the *only* thing a consumer and a provider both import — that's how they agree on the message shape without importing each other.
- **sdks**: a friendly typed client that hides `callRpc(...)` behind a method like `catalog.getProduct(id)`. Depends on `common` (for `callRpc`) and `types` (for the contract).
- **services**: import sdks + types + common. Never import another service's `src`.

The build order in `package.json` (`common → types → sdks → services`) exists **because of this arrow**. Each layer is compiled to `dist/` before the next layer consumes it.

### Why a monorepo with `dist/` imports
Every internal package is referenced with `workspace:*` and consumed from its compiled `dist/`. That means: **you must build a lib before a service can use its new code.** During the tutorial you'll run `pnpm build:libs` a lot. (There's a note in Step 1 about a shortcut/cleanup for this.)

---

## Current state (what already exists — don't rebuild it)

Done for you:
- Root tooling: `pnpm-workspace.yaml`, `biome.json`, `.husky/*`, `commitlint`, `.syncpackrc.json`, `.lintstagedrc.json`, `vitest.config.ts`, `tsconfig.base.json`.
- `docker-compose.yml`: RabbitMQ (+ management UI on 15672), Postgres, Mongo — all with healthchecks and creds `minishop:minishop`.
- `@minishop/common`: `ServiceName` enum, exchange-key helpers (`directExchangeKey`, `topicExchangeKey`, `fanoutExchangeKey`, `queueKey`), rabbitmq utils (`callRpc`, `sendEvent`, `RpcHandler`), and a passing spec for the key helpers.
- `@minishop/catalog-service-types`: `get-product.contract.ts` and `check-stock.contract.ts` (already defined).
- `services/catalog`: `main.ts`, `app.module.ts`, `communication.module.ts` (RabbitMQ direct+topic exchanges), `health.controller.ts`, and `product.interface.ts`.
- All three services have `main.ts` + a bare `app.module.ts` and correct `.env` files.

Still to build (this plan):
- `@minishop/common`: mediator + request-context modules (optional but part of the architecture — Step 2).
- `@minishop/order-service-types`: the `order.placed` event contract (Step 3).
- `@minishop/catalog-service-sdk`: the real `CatalogClient` (Step 6).
- `services/catalog`: Mongoose DB module + Product schema, `product.service`, use-cases, GraphQL resolver, and the RPC integration handler (Steps 4–5).
- `services/order`: TypeORM DB module + Order entity, `place-order` use-case, GraphQL resolver (Step 7).
- `services/notification`: the `@RabbitSubscribe` consumer (Step 8).

One inconsistency to be aware of: `services/catalog/src/modules/communication.module.ts` currently imports from a **relative path** `'../../../../libs/common/dist'` instead of the package name `@minishop/common`. We'll fix that in Step 1 so all imports use the package name.

---

## 1. Orientation & infrastructure

**Goal:** get the moving parts running and prove the build order works before writing a single new line.

**Concept:** A microservice system is only as reliable as its infra. RabbitMQ is the *broker* — every message between services passes through it. Postgres backs the order service (relational, transactional), Mongo backs the catalog (document store). Two databases on purpose: to feel the difference between TypeORM and Mongoose.

**Steps:**
1. Start infra:
   ```bash
   pnpm infra:up
   docker compose ps        # all three should be "healthy"
   ```
2. Open the RabbitMQ management UI at http://localhost:15672 (login `minishop` / `minishop`). Keep this tab open all tutorial — you'll watch exchanges, queues, and message rates appear here as you build.
3. Build every library once and confirm the ordered build works:
   ```bash
   pnpm build:libs
   ```
4. Fix the one import inconsistency: in `services/catalog/src/modules/communication.module.ts`, change the import from `'../../../../libs/common/dist'` to `'@minishop/common'`. Rebuild the service (`pnpm --filter @minishop/catalog build`) to confirm the package resolves.

**Verify:**
- `docker compose ps` shows rabbitmq, postgres, mongo all healthy.
- `pnpm build:libs` exits 0.
- The RabbitMQ UI loads.

**Workflow tip for the rest of the tutorial:** every time you change a `libs/*` file, run `pnpm build:libs` (or the single-package filter) before starting a service, because services consume the compiled `dist/`.

---

## 2. `@minishop/common` — the mediator & request-context (the backbone)

> If you want the fastest path to a working system, you *can* skip the mediator and call services directly. But the mediator + request-context are the heart of the architecture this project is modeling, so build them and route your use-cases through them.

### 2a. Review what's already here (understand before adding)
Open and read, in this order:
- `constants/service-name.enum.ts` — one enum, the single source of truth for service identity. Every exchange/queue name derives from it.
- `constants/exchange-key.constant.ts` — note the naming scheme `minishop.<service>.<type>`. **Concept:** exchange *type* matters. `direct` = route by exact key (used for RPC). `topic` = route by pattern (used for events). `fanout` = broadcast to all bound queues. `queueKey` normalizes a human name into a stable queue name so a consumer always binds to the same queue across restarts (important — a new random queue every restart would drop messages).
- `utils/rabbitmq.utils.ts` — three tiny wrappers:
  - `callRpc` → `connection.request()` (publishes to an exchange with a `replyTo`, waits for the reply, times out). This is **RPC**.
  - `sendEvent` → `connection.publish()` with `persistent: true`. Fire-and-forget. This is **pub/sub** from the producer side.
  - `RpcHandler` → thin alias over `@golevelup`'s `RabbitRPC` decorator, marking a method as an RPC responder.
- Run the existing test to see the key helpers pass: `pnpm test`.

### 2b. Build the mediator
**Concept:** The *mediator pattern* decouples "what you want done" (a Command/Query object) from "who does it" (a handler). Your resolvers create a command and hand it to the mediator; they never call services directly. This keeps controllers/resolvers thin and use-cases independently testable.

Create under `libs/common/src/modules/mediator/`:
- `base-messages.ts` — abstract base classes `BaseCommand<TResult>`, `BaseQuery<TResult>`, `BaseEvent`. They carry a generic result type so the mediator can be type-safe.
- `command-handler.decorator.ts` — a `@CommandHandler(CommandClass)` decorator that stamps metadata linking a handler class to the message class it handles (use `reflect-metadata` / Nest's `SetMetadata` + `DiscoveryService`).
- `mediator.service.ts` — a `Mediator` with a `send(message)` method. On module init it uses Nest's `DiscoveryService` to find every provider decorated with `@CommandHandler`, builds a `Map<messageClass, handlerInstance>`, and `send()` looks up the handler and calls its `execute(message)`.
- `mediator.module.ts` — a `@Global()` module that imports `DiscoveryModule`, provides and exports `Mediator`.
- barrel `index.ts` for the folder.

**Why a `Map` built once at startup?** Handler lookup becomes O(1) and wiring is declarative — you add a handler by decorating it, not by editing a registry.

### 2c. Build request-context
**Concept:** `AsyncLocalStorage` gives you a per-request "ambient" store that survives `await`s without threading a parameter through every function. Use it to carry things like a correlation ID or user id across the RPC boundary.

Create under `libs/common/src/modules/request-context/`:
- `request-context.ts` — an `AsyncLocalStorage`-backed store with `run(context, callback)`, `get()`, and `serialize()/deserialize()` helpers (so the context can travel in RabbitMQ message headers and be rebuilt on the consumer side).

### 2d. Export and build
- Add the new modules to `libs/common/src/index.ts`.
- `pnpm build:common`.

**Verify:**
- `pnpm build:common` exits 0.
- `pnpm test` still green.
- You can articulate: "A resolver builds a Command → `mediator.send()` → the decorated handler's `execute()` runs." If you can't, re-read 2b.

---

## 3. `@minishop/order-service-types` — the event contract

**Goal:** define the shape of the `order.placed` event so the order service (producer) and notification service (consumer) agree without importing each other.

**Concept:** An event contract is *just* a routing key + a payload interface. It lives in `types` precisely because **both** sides depend on it and neither should depend on the other's implementation. Changing this file is a breaking change to the wire protocol — treat it with care (this is what "contract" means).

**Steps:**
1. Replace the placeholder in `libs/types/order-service/src/`. Create `order.event.ts` with:
   - `ORDER_PLACED_ROUTING_KEY = 'order.placed'` (the topic routing key).
   - `OrderPlacedEvent` interface: `orderId`, `productId`, `quantity`, `unitPrice`, `totalPrice`, `placedAt` (ISO string), and enough to render a confirmation (e.g. `customerEmail` if you add one).
2. Export it from `libs/types/order-service/src/index.ts` (remove the `CATALOG_SERVICE_SDK_READY` placeholder).
3. Review the already-written `catalog-service-types` contracts (`get-product.contract.ts`, `check-stock.contract.ts`) — notice they follow the same shape: a pattern constant + request/response interfaces. (Minor: `get-product` exports `GET_PRODUCT_CONTRACT` while `check-stock` exports `CHECK_STOCK_PATTERN` — pick one naming convention, e.g. `*_PATTERN`, and align them so it's consistent.)
4. `pnpm build:types`.

**Verify:** `pnpm build:types` exits 0 and `dist/` contains `order.event.d.ts`.

---

## 4. Catalog service — persistence layer (Mongo + Mongoose)

**Goal:** give catalog a place to store products, so later the RPC handler has real data to return.

**Concept:** Catalog is a *document store* service. A product is a self-contained document — no joins needed — which is exactly what MongoDB is good at. `@nestjs/mongoose` gives you `MongooseModule.forRootAsync` (the connection) and `forFeature` (register a schema/model).

**Steps:**
1. Create `services/catalog/src/modules/database.module.ts`: `MongooseModule.forRootAsync` reading `MONGODB_URI` from `ConfigService`. Export the module.
2. Create `services/catalog/src/domain/entities/product.entity.ts`: a `@Schema()` class `Product` with `name: string`, `price: number`, `availableStock: number`, plus the generated `SchemaFactory.createForClass(Product)`. **Concept:** Mongo stores `_id` (an ObjectId); your public contract uses a string `id`. Decide now that the boundary converts `_id.toString()` → `id`.
3. Import `DatabaseModule` into `app.module.ts`.

**Verify:** `pnpm --filter @minishop/catalog build` succeeds. Start the service (`pnpm dev:catalog`) and confirm it connects to Mongo (no connection error in logs; `GET /health` returns ok). Stop it after checking.

---

## 5. Catalog service — product feature (core, use-cases, GraphQL, RPC handler)

This is the biggest step. Build it inner-out: core service → use-cases → GraphQL (to seed data) → RPC handler (what order will call).

### 5a. Core service
- Implement `features/product/core/product.service.ts` against the existing `product.interface.ts`. Inject the Mongoose `Product` model. Methods: `create(input)`, `findById(id)`, and a `checkStock(productId, quantity)` that returns `{ productExists, available, availableStock }`.
- **Concept:** the *core* holds persistence + domain logic and knows nothing about GraphQL or RabbitMQ. Both the GraphQL resolver and the RPC handler are thin adapters that call it. One brain, many mouths.

### 5b. Use-cases via the mediator
- `use-cases/create-product.command.ts`: a `CreateProductCommand` (extends `BaseCommand`) + a `@CommandHandler(CreateProductCommand)` class whose `execute()` calls `productService.create(...)`.
- `use-cases/get-product.query.ts`: a `GetProductQuery` + handler calling `productService.findById(...)`.
- **Concept:** feel the indirection — the resolver won't touch `ProductService`; it sends a command/query. This is what makes the use-case testable in isolation and reusable from both GraphQL and RPC entry points.

### 5c. GraphQL module (so you can create/read products by hand)
- `features/product/resolvers/product.pms.resolver.ts`: a `@Resolver`, with a `createProduct` mutation and a `product(id)` query, each building a command/query and calling `mediator.send()`.
- `features/product/product.pms.module.ts`: wires the resolver, `ProductService`, the command/query handlers, and `MongooseModule.forFeature([Product])`.
- Enable GraphQL in `app.module.ts` via `GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true })`.
- **Why GraphQL here?** It's your manual seeding + inspection tool. You need a way to put products in Mongo before order can ask about them.

### 5d. RPC integration handler (the reason order needs catalog)
- Implement `features/product/integrations/product.integration.handler.ts`: a provider with two methods decorated with `@RpcHandler({ exchange: directExchangeKey(ServiceName.CATALOG), routingKey: <pattern>, queue: queueKey(ServiceName.CATALOG, ...) })`:
  - one for `GET_PRODUCT_PATTERN` → returns `GetProductResponse`,
  - one for `CHECK_STOCK_PATTERN` → returns `CheckStockResponse`.
  Each method calls `ProductService` (directly or through the mediator) and maps to the **contract's** response type from `@minishop/catalog-service-types`.
- Implement `features/product/product.integration.module.ts`: provides the handler + `ProductService` + `forFeature([Product])`.
- Import the integration module into `app.module.ts`.
- **Concept:** `@RpcHandler` binds a queue to the catalog **direct** exchange on that routing key. When someone `callRpc`s that key, RabbitMQ delivers to this queue, your method runs, and its return value is sent back on the reply queue. The `queue` name comes from `queueKey(...)` so it's stable across restarts.

**Verify:**
1. Start catalog (`pnpm dev:catalog`). In the RabbitMQ UI, confirm the catalog direct exchange and the RPC handler queues now exist.
2. Open the GraphQL playground (default `http://localhost:3001/graphql`), run `createProduct`, then `product(id:...)` — data round-trips through Mongo.
3. (Optional sanity RPC test) You'll fully exercise the RPC in Step 7 from the order side.

---

## 6. `@minishop/catalog-service-sdk` — the typed client

**Goal:** wrap the raw `callRpc` + contract into `CatalogClient.getProduct()` / `checkStock()` so the order service never handles routing keys or exchanges directly.

**Concept:** An SDK is the *consumer-facing* half of a contract. The provider (catalog) implements handlers; the SDK gives every consumer a typed method so they can't get the routing key or payload shape wrong. If the contract changes, the SDK is the single place the call site updates.

**Steps:**
1. `libs/sdks/catalog-service/src/catalog.client.ts`: an injectable `CatalogClient` that takes `AmqpConnection`. Methods:
   - `getProduct(productId)` → `callRpc<GetProductRequest, GetProductResponse>({ connection, exchange: directExchangeKey(ServiceName.CATALOG), routingKey: GET_PRODUCT_PATTERN, payload })`.
   - `checkStock(productId, quantity)` → same shape with the check-stock contract.
2. `libs/sdks/catalog-service/src/catalog.sdk.module.ts`: a Nest module that provides and exports `CatalogClient`. (It assumes the consuming app already registered `RabbitMQModule`, so `AmqpConnection` is injectable.)
3. Export both from `index.ts` (remove the placeholder).
4. `pnpm build:sdks`.

**Verify:** `pnpm build:sdks` exits 0; `dist/` exposes `CatalogClient` and `CatalogSdkModule`.

---

## 7. Order service — RPC caller + event publisher (Postgres + TypeORM)

**Goal:** implement `placeOrder`: ask catalog (RPC), persist the order (Postgres), publish `order.placed` (event).

### 7a. Persistence (TypeORM)
- `services/order/src/domain/enums/order-status.enum.ts`: `PENDING`, `CONFIRMED`, etc.
- `services/order/src/domain/entities/order.entity.ts`: `@Entity()` `Order` with `id` (uuid), `productId`, `quantity`, `unitPrice`, `totalPrice`, `status`, `createdAt`.
- `services/order/src/data-source.ts`: a TypeORM `DataSource` (used by the CLI for migrations and as the config source).
- `services/order/src/modules/database.module.ts`: `TypeOrmModule.forRootAsync` reading the `POSTGRES_*` env vars, registering the `Order` entity.
- **Concept:** relational + transactional. Unlike Mongo's single document, an order is a row you may later join (order items, customers). TypeORM's `synchronize: true` is fine for this tutorial; in real life you'd use migrations.

### 7b. Communication module
- `services/order/src/modules/communication.module.ts`: `RabbitMQModule.forRootAsync` declaring the order **topic** exchange (`topicExchangeKey(ServiceName.ORDER)`), so the order can publish `order.placed`. Export `RabbitMQModule` so `AmqpConnection` is injectable.
- **Concept:** the *producer* declares the topic exchange it publishes to. Whether anyone is listening is not the producer's concern — that's the whole point of pub/sub.

### 7c. The use-case (the star of the show)
- `features/order/core/order.service.ts`: persistence for orders (`create`, `updateStatus`).
- `features/order/use-cases/place-order.command.ts`: a `PlaceOrderCommand` + `@CommandHandler` whose `execute()` does, in order:
  1. `catalogClient.checkStock(productId, quantity)` (or `getProduct`) — **RPC, awaits the reply.** If the product doesn't exist or stock is insufficient, throw (order fails fast — this is why it's synchronous).
  2. Persist the order via `OrderService` using the price returned by catalog.
  3. `sendEvent({ connection, exchange: topicExchangeKey(ServiceName.ORDER), routingKey: ORDER_PLACED_ROUTING_KEY, payload: OrderPlacedEvent })` — **event, does not await a consumer.**
  4. Return the created order.
- **Concept — this one step contains both patterns.** Step 1 blocks because the answer changes the outcome. Step 3 doesn't block because notification is optional and must not slow down or break order placement. Sit with that contrast; it's the core lesson.

### 7d. GraphQL
- `features/order/resolvers/order.pms.resolver.ts`: a `placeOrder` mutation that builds `PlaceOrderCommand` and calls `mediator.send()`.
- `features/order/order.pms.module.ts`: wires the resolver, `OrderService`, the handler, `TypeOrmModule.forFeature([Order])`, and imports `CatalogSdkModule`.
- Enable GraphQL + import `DatabaseModule`, `CommunicationModule`, `MediatorModule` (global), and the order feature module in `app.module.ts`.

**Verify:**
1. Both catalog and order running (`pnpm dev:catalog`, `pnpm dev:order`).
2. Create a product via catalog GraphQL; copy its `id`.
3. Run `placeOrder` via order GraphQL (`http://localhost:3002/graphql`) with that `productId`.
4. Expect: mutation returns the created order; the row exists in Postgres; the RabbitMQ UI shows one message published to the order topic exchange. (Nothing consumes it yet — that's Step 8. Confirm it's sitting/routed, or that no queue is bound yet.)
5. Negative test: `placeOrder` with a bad `productId` or huge quantity → the mutation errors and **no** order row is created and **no** event is published. This proves the RPC gate works.

---

## 8. Notification service — the pub/sub consumer (no DB)

**Goal:** react to `order.placed` and "send" a confirmation (log it). Prove events are fire-and-forget and that adding a consumer doesn't touch the producer.

**Concept:** The consumer *binds a queue* to the order topic exchange on the `order.placed` routing key. `@RabbitSubscribe` handles the binding. The order service has no idea this exists — you could add five more subscribers and never redeploy order. That's the payoff of pub/sub.

**Steps:**
1. `services/notification/src/modules/communication.module.ts`: `RabbitMQModule.forRootAsync` declaring the **same** order topic exchange (`topicExchangeKey(ServiceName.ORDER)`) so it can bind to it.
2. `features/order-notification/integrations/order-notification.integration.handler.ts`: a provider with a method decorated `@RabbitSubscribe({ exchange: topicExchangeKey(ServiceName.ORDER), routingKey: ORDER_PLACED_ROUTING_KEY, queue: queueKey(ServiceName.NOTIFICATION, 'order-placed') })`. The method receives `OrderPlacedEvent` (typed from `@minishop/order-service-types`) and logs a "confirmation sent to ..." message.
3. `features/order-notification/order-notification.integration.module.ts`: provides the handler.
4. Import `CommunicationModule` + the integration module into `app.module.ts`. Note `notification/main.ts` uses `createApplicationContext` (no HTTP server) — it's a pure worker. Good; leave it.

**Verify (full end-to-end):**
1. All three running: `pnpm dev` (or the three `dev:*` scripts).
2. In RabbitMQ UI, confirm the notification queue is now **bound** to the order topic exchange.
3. `placeOrder` from order GraphQL → within a moment the **notification logs** print the confirmation. Order returned its response *before* notification ran — reorder-independent.
4. Stop the notification service, place another order: order still succeeds; the message queues up. Restart notification: it drains the queued message (because the queue is durable and stably named via `queueKey`). This demonstrates the resilience pub/sub buys you.

---

## 9. Wrap-up & self-check

Rebuild everything clean and run the test suite:
```bash
pnpm build && pnpm test && pnpm lint
```

You've truly understood MiniShop if you can answer these without looking:
1. Why does `placeOrder` **await** the catalog call but **not** await notification?
2. If catalog is down, what happens to `placeOrder`? What happens to a would-be notification?
3. Why do `order-service-types` and `catalog-service-types` exist as separate packages instead of a shared interfaces file inside each service?
4. What does `queueKey(...)` protect you from, and what would break if every consumer used an auto-generated queue name?
5. Where would you add a second reaction to `order.placed` (say, an analytics service), and which existing files would you have to change to do it? (Answer: a new service; **none** of the existing ones.)
6. Trace one `placeOrder` request through every layer: resolver → mediator → command handler → SDK → `callRpc` → catalog exchange → RPC handler → reply → persist → `sendEvent` → topic exchange → notification queue → subscriber.

### Suggested commit checkpoints (conventional commits, matches the husky/commitlint setup)
- `feat(common): add mediator and request-context modules`
- `feat(order-types): add order.placed event contract`
- `feat(catalog): add mongoose persistence and product feature`
- `feat(catalog): expose get-product and check-stock rpc handlers`
- `feat(catalog-sdk): add typed CatalogClient`
- `feat(order): implement placeOrder with rpc gate and event publish`
- `feat(notification): subscribe to order.placed`

---

## Quick command reference
```bash
pnpm infra:up            # start rabbitmq + postgres + mongo
pnpm infra:down          # stop infra
pnpm infra:reset         # stop + wipe volumes (fresh DBs)
pnpm build:libs          # build common + types + sdks (run after editing any lib)
pnpm build               # build everything in order
pnpm dev                 # run all services in watch mode
pnpm dev:catalog         # run one service
pnpm test                # vitest run
pnpm lint                # biome check
```

Remember the golden rule of this monorepo: **edit a lib → build the lib → then the service sees it.**

# Steps 6 & 7 — Catalog SDK + Order service (the RPC caller & event publisher)

Copy-along guide. Step 6 is small (the typed client). Step 7 is where both messaging patterns finally meet in one method: `placeOrder` **awaits** an RPC to catalog, then **fires** an event and moves on. Build Step 6 first — the order service depends on it.

Final layout:
```
libs/sdks/catalog-service/src/
├─ catalog.client.ts        (new)
├─ catalog.sdk.module.ts    (new)
└─ index.ts                 (replace placeholder)

services/order/src/
├─ app.module.ts            (replace)
├─ main.ts  health.controller.ts (exist)
├─ data-source.ts           (new — TypeORM CLI/config)
├─ domain/
│  ├─ entities/order.entity.ts   (new)
│  └─ enums/order-status.enum.ts (new)
├─ modules/
│  ├─ database.module.ts    (new — TypeORM)
│  └─ communication.module.ts (new — RabbitMQ)
└─ features/order/
   ├─ core/
   │  ├─ order.interface.ts (new)
   │  └─ order.service.ts   (new)
   ├─ use-cases/place-order.command.ts (new — the star)
   ├─ resolvers/
   │  ├─ order.pms.dto.ts   (new)
   │  └─ order.pms.resolver.ts (new)
   └─ order.pms.module.ts   (new)
```

---

# Step 6 — `@minishop/catalog-service-sdk`

## Phase 6a — `catalog.client.ts`

**File:** `libs/sdks/catalog-service/src/catalog.client.ts`
```ts
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq'
import {
    CHECK_STOCK_PATTERN,
    type CheckStockRequest,
    type CheckStockResponse,
    GET_PRODUCT_PATTERN,
    type GetProductRequest,
    type GetProductResponse,
} from '@minishop/catalog-service-types'
import { callRpc, directExchangeKey, ServiceName } from '@minishop/common'
import { Injectable } from '@nestjs/common'

@Injectable()
export class CatalogClient {
    constructor(private readonly connection: AmqpConnection) {}

    getProduct(productId: string): Promise<GetProductResponse> {
        return callRpc<GetProductRequest, GetProductResponse>({
            connection: this.connection,
            exchange: directExchangeKey(ServiceName.CATALOG),
            routingKey: GET_PRODUCT_PATTERN,
            payload: { productId },
        })
    }

    checkStock(productId: string, quantity: number): Promise<CheckStockResponse> {
        return callRpc<CheckStockRequest, CheckStockResponse>({
            connection: this.connection,
            exchange: directExchangeKey(ServiceName.CATALOG),
            routingKey: CHECK_STOCK_PATTERN,
            payload: { productId, quantity },
        })
    }
}
```

**Understand it — the SDK is the mirror image of the RPC handler:** in Step 5d the catalog service *implemented* handlers for `GET_PRODUCT_PATTERN` and `CHECK_STOCK_PATTERN` on its direct exchange. Here the SDK *calls* those exact keys on the exact same exchange. Both sides import the routing keys and DTOs from `@minishop/catalog-service-types`, so they physically cannot disagree. The order service will inject `CatalogClient` and call `catalog.getProduct(id)` — it never sees a routing key, an exchange name, or `AmqpConnection`. If the contract ever changes, this one file is the only place a consumer updates.

## Phase 6b — `catalog.sdk.module.ts`

**File:** `libs/sdks/catalog-service/src/catalog.sdk.module.ts`
```ts
import { Module } from '@nestjs/common'

import { CatalogClient } from './catalog.client'

@Module({
    providers: [CatalogClient],
    exports: [CatalogClient],
})
export class CatalogSdkModule {}
```

**Understand it:** the module provides and exports `CatalogClient`. It deliberately does **not** configure RabbitMQ — it assumes the consuming app already set up `RabbitMQModule` (the order service does, in its `CommunicationModule`). Because golevelup's `RabbitMQModule` registers `AmqpConnection` globally, `CatalogClient` can inject it as long as the host app initialized it somewhere. An SDK configures *its own client*, not the transport.

## Phase 6c — barrel + build

**File:** `libs/sdks/catalog-service/src/index.ts`
```ts
export * from './catalog.client'
export * from './catalog.sdk.module'
```

```bash
pnpm build:sdks
```

**Verify:** exits 0; `libs/sdks/catalog-service/dist/` contains `catalog.client.js`, `catalog.sdk.module.js`, and their `.d.ts`, and `index.d.ts` re-exports both.

---

# Step 7 — Order service

## Phase 7a — persistence (Postgres + TypeORM)

**File:** `services/order/src/domain/enums/order-status.enum.ts`
```ts
export enum OrderStatus {
    PENDING = 'pending',
    CONFIRMED = 'confirmed',
    CANCELLED = 'cancelled',
}
```

**File:** `services/order/src/domain/entities/order.entity.ts`
```ts
import { randomUUID } from 'node:crypto'

import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

import { OrderStatus } from '../enums/order-status.enum'

/**
 * TypeORM returns `numeric`/`decimal` columns as strings (to avoid float
 * precision loss). This transformer keeps our domain in `number` on the way in
 * and out, so prices are numbers everywhere above the DB.
 */
const numericTransformer = {
    to: (value: number): number => value,
    from: (value: string): number => Number.parseFloat(value),
}

@Entity({ name: 'orders' })
export class Order {
    // Generated in the app (not by Postgres) so we don't depend on a DB uuid extension.
    @PrimaryColumn({ type: 'uuid' })
    id: string = randomUUID()

    // NOTE: this is a Mongo ObjectId string from catalog, NOT a Postgres uuid.
    @Column({ type: 'varchar' })
    productId: string

    @Column({ type: 'varchar' })
    productName: string

    @Column({ type: 'int' })
    quantity: number

    @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
    unitPrice: number

    @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
    totalPrice: number

    @Column({ type: 'varchar' })
    customerEmail: string

    @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
    status: OrderStatus

    @CreateDateColumn({ type: 'timestamptz' })
    createdAt: Date
}
```

**Understand it — the relational contrasts with Mongo:**
- **`productId` is `varchar`, not `uuid`.** Catalog stores products in Mongo, so the id it hands back is a 24-char hex ObjectId string. If you typed this column `uuid`, every insert would fail. This is a real cross-database gotcha — the id type is whatever the *owning* service uses.
- **App-generated id.** `@PrimaryColumn('uuid')` + a `randomUUID()` field default sidesteps needing a Postgres uuid extension (`uuid-ossp`/`pgcrypto`). Alternative: `@PrimaryGeneratedColumn('uuid')` lets the DB generate it, but that depends on the extension being present. App-side is simpler and portable.
- **`numeric` + transformer for money.** TypeORM returns `numeric` columns as strings to protect precision. The transformer converts back to `number` so `unitPrice`/`totalPrice` are numbers in your domain and in the event payload (which declares them `number`).

**File:** `services/order/src/data-source.ts`
```ts
import 'reflect-metadata'

import { DataSource } from 'typeorm'

import { Order } from './domain/entities/order.entity'

/**
 * Standalone DataSource for the TypeORM CLI (migrations, schema tools).
 * The running app does NOT use this — it builds its config from ConfigService
 * in database.module.ts. This exists so `typeorm` CLI commands have a config.
 */
export const AppDataSource = new DataSource({
    type: 'postgres',
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    username: process.env.POSTGRES_USERNAME ?? 'minishop',
    password: process.env.POSTGRES_PASSWORD ?? 'minishop',
    database: process.env.POSTGRES_DATABASE ?? 'minishop_order',
    entities: [Order],
    synchronize: true,
})
```

**File:** `services/order/src/modules/database.module.ts`
```ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { TypeOrmModule } from '@nestjs/typeorm'

import { Order } from '../domain/entities/order.entity'

@Module({
    imports: [
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                type: 'postgres' as const,
                host: config.getOrThrow<string>('POSTGRES_HOST'),
                port: Number(config.getOrThrow<string>('POSTGRES_PORT')),
                username: config.getOrThrow<string>('POSTGRES_USERNAME'),
                password: config.getOrThrow<string>('POSTGRES_PASSWORD'),
                database: config.getOrThrow<string>('POSTGRES_DATABASE'),
                entities: [Order],
                synchronize: true,
            }),
        }),
    ],
})
export class DatabaseModule {}
```

**Understand it:** `synchronize: true` makes TypeORM auto-create/alter the `orders` table from your entity on boot — great for a tutorial, dangerous in production (it can drop columns). In a real system you'd set it `false` and use migrations (that's what `data-source.ts` would drive). `forRootAsync` opens the connection pool; `forFeature([Order])` (in the feature module) exposes the `Order` repository.

## Phase 7b — communication module (the producer side)

**File:** `services/order/src/modules/communication.module.ts`
```ts
import { type RabbitMQConfig, RabbitMQModule } from '@golevelup/nestjs-rabbitmq'
import { directExchangeKey, ServiceName, topicExchangeKey } from '@minishop/common'
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'

@Module({
    imports: [
        RabbitMQModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService): RabbitMQConfig => ({
                uri: configService.getOrThrow<string>('RABBITMQ_URI'),
                exchanges: [
                    // Publish `order.placed` here (pub/sub producer).
                    { name: topicExchangeKey(ServiceName.ORDER), type: 'topic' },
                    // RPC-call catalog here. We declare it so requests work
                    // even if the order service boots before catalog.
                    { name: directExchangeKey(ServiceName.CATALOG), type: 'direct' },
                ],
            }),
        }),
    ],
    exports: [RabbitMQModule],
})
export class CommunicationModule {}
```

**Understand it — why order declares *two* exchanges:**
- The **order topic** exchange is what order *publishes* to. As a producer it declares its own exchange; whether anyone is bound to it is not its concern (that's the essence of pub/sub — Step 8 adds the listener without touching this code).
- The **catalog direct** exchange is where order *sends RPC requests*. Declaring it here is idempotent and makes the RPC robust to startup order — if order comes up first and tries to call catalog, publishing to an undeclared exchange would error. Declaring it guarantees the exchange exists.

## Phase 7c — core service

**File:** `services/order/src/features/order/core/order.interface.ts`
```ts
import type { OrderStatus } from '../../../domain/enums/order-status.enum'

export interface CreateOrderData {
    productId: string
    productName: string
    quantity: number
    unitPrice: number
    totalPrice: number
    customerEmail: string
    status: OrderStatus
}
```

**File:** `services/order/src/features/order/core/order.service.ts`
```ts
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { Order } from '../../../domain/entities/order.entity'
import type { OrderStatus } from '../../../domain/enums/order-status.enum'
import type { CreateOrderData } from './order.interface'

@Injectable()
export class OrderService {
    constructor(
        @InjectRepository(Order)
        private readonly orders: Repository<Order>,
    ) {}

    create(data: CreateOrderData): Promise<Order> {
        const order = this.orders.create(data)
        return this.orders.save(order)
    }

    async updateStatus(id: string, status: OrderStatus): Promise<void> {
        await this.orders.update({ id }, { status })
    }
}
```

**Understand it:** unlike catalog (where the service mapped Mongo `_id` → domain `id`), here the TypeORM `Order` entity already has a `string id` and plain fields, so it *is* the domain object — no mapping needed. `repo.create(data)` builds an entity instance (running the `randomUUID()` default for `id`); `repo.save` inserts it and returns the persisted row.

## Phase 7d — the use-case (both patterns in one method)

**File:** `services/order/src/features/order/use-cases/place-order.command.ts`
```ts
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq'
import { CatalogClient } from '@minishop/catalog-service-sdk'
import {
    BaseCommand,
    CommandHandler,
    type IHandler,
    sendEvent,
    ServiceName,
    topicExchangeKey,
} from '@minishop/common'
import { ORDER_PLACED_ROUTING_KEY, type OrderPlacedEvent } from '@minishop/order-service-types'
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'

import { Order } from '../../../domain/entities/order.entity'
import { OrderStatus } from '../../../domain/enums/order-status.enum'
import { OrderService } from '../core/order.service'

export class PlaceOrderCommand extends BaseCommand<Order> {
    constructor(
        public readonly productId: string,
        public readonly quantity: number,
        public readonly customerEmail: string,
    ) {
        super()
    }
}

@Injectable()
@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements IHandler<PlaceOrderCommand, Order> {
    constructor(
        private readonly catalog: CatalogClient,
        private readonly orders: OrderService,
        private readonly amqp: AmqpConnection,
    ) {}

    async execute(command: PlaceOrderCommand): Promise<Order> {
        // (1) RPC — we NEED the answer before we can proceed. This blocks.
        const { product } = await this.catalog.getProduct(command.productId)
        if (!product) {
            throw new NotFoundException(`Product ${command.productId} not found`)
        }
        if (product.availableStock < command.quantity) {
            throw new BadRequestException(
                `Insufficient stock: requested ${command.quantity}, available ${product.availableStock}`,
            )
        }

        // (2) Persist using the price CATALOG reported — never trust a client price.
        const order = await this.orders.create({
            productId: product.id,
            productName: product.name,
            quantity: command.quantity,
            unitPrice: product.price,
            totalPrice: product.price * command.quantity,
            customerEmail: command.customerEmail,
            status: OrderStatus.CONFIRMED,
        })

        // (3) Event — fire and forget. We do NOT await any consumer.
        const event: OrderPlacedEvent = {
            orderId: order.id,
            productId: order.productId,
            productName: order.productName,
            quantity: order.quantity,
            unitPrice: order.unitPrice,
            totalPrice: order.totalPrice,
            customerEmail: order.customerEmail,
            placedAt: new Date().toISOString(),
        }
        await sendEvent({
            connection: this.amqp,
            exchange: topicExchangeKey(ServiceName.ORDER),
            routingKey: ORDER_PLACED_ROUTING_KEY,
            payload: event,
        })

        // (4) Return immediately — notification runs on its own time.
        return order
    }
}
```

**Understand it — this is the lesson the whole project builds toward:**
- **Step (1) is RPC and it blocks on purpose.** The order cannot be priced or stock-checked without catalog's answer, so `await this.catalog.getProduct(...)` waits for the reply. If catalog says "not found" or "not enough stock", the handler throws and *nothing else happens* — no row, no event. This is the synchronous "I need an answer now" pattern. (I used `getProduct` because it returns name + price + stock in one round trip — everything the event needs. Use `checkStock` instead when you only need a yes/no gate and not the product data.)
- **Step (3) is pub/sub and it does not block on a consumer.** `await sendEvent(...)` waits only for the *broker* to accept the message (a publish confirm), not for notification to process it. The order returns as soon as the fact is recorded. Notification could be down, slow, or not exist yet — order placement is unaffected.
- **Sit with the contrast:** same method, two philosophies. Coupling where correctness demands it (price/stock), decoupling where it doesn't (confirmation). Getting this boundary right is most of what "microservice design" means.
- **Security aside:** the total is computed from catalog's price, never from anything the client sent — a client can pick the product and quantity, not the price.

## Phase 7e — GraphQL

**File:** `services/order/src/features/order/resolvers/order.pms.dto.ts`
```ts
import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql'
import { IsEmail, IsInt, IsMongoId, IsPositive } from 'class-validator'

@ObjectType('Order')
export class OrderObjectType {
    @Field(() => ID)
    id: string

    @Field()
    productId: string

    @Field()
    productName: string

    @Field(() => Int)
    quantity: number

    @Field(() => Float)
    unitPrice: number

    @Field(() => Float)
    totalPrice: number

    @Field()
    customerEmail: string

    @Field()
    status: string

    @Field()
    createdAt: Date
}

@InputType()
export class PlaceOrderInput {
    // Catalog ids are Mongo ObjectIds — validate the format before we spend an RPC.
    @Field()
    @IsMongoId()
    productId: string

    @Field(() => Int)
    @IsInt()
    @IsPositive()
    quantity: number

    @Field()
    @IsEmail()
    customerEmail: string
}
```

**File:** `services/order/src/features/order/resolvers/order.pms.resolver.ts`
```ts
import { Mediator } from '@minishop/common'
import { Args, Mutation, Resolver } from '@nestjs/graphql'

import { Order } from '../../../domain/entities/order.entity'
import { PlaceOrderCommand } from '../use-cases/place-order.command'
import { OrderObjectType, PlaceOrderInput } from './order.pms.dto'

@Resolver(() => OrderObjectType)
export class OrderResolver {
    constructor(private readonly mediator: Mediator) {}

    @Mutation(() => OrderObjectType)
    placeOrder(@Args('input') input: PlaceOrderInput): Promise<Order> {
        return this.mediator.send(
            new PlaceOrderCommand(input.productId, input.quantity, input.customerEmail),
        )
    }
}
```

**File:** `services/order/src/features/order/order.pms.module.ts`
```ts
import { CatalogSdkModule } from '@minishop/catalog-service-sdk'
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { Order } from '../../domain/entities/order.entity'
import { OrderService } from './core/order.service'
import { OrderResolver } from './resolvers/order.pms.resolver'
import { PlaceOrderHandler } from './use-cases/place-order.command'

@Module({
    imports: [TypeOrmModule.forFeature([Order]), CatalogSdkModule],
    providers: [OrderService, OrderResolver, PlaceOrderHandler],
})
export class OrderPmsModule {}
```

**Understand it:** `PlaceOrderHandler` injects `CatalogClient`, so `OrderPmsModule` imports `CatalogSdkModule` (which exports it). `TypeOrmModule.forFeature([Order])` gives `OrderService` its repository. `@IsMongoId()` on the input rejects malformed ids before the resolver even runs, so you don't waste an RPC round trip on garbage — validation at the edge, RPC gate deeper in.

## Phase 7f — wire `app.module.ts`

**File:** `services/order/src/app.module.ts`
```ts
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo'
import { MediatorModule } from '@minishop/common'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { GraphQLModule } from '@nestjs/graphql'

import { OrderPmsModule } from './features/order/order.pms.module'
import { HealthController } from './health.controller'
import { CommunicationModule } from './modules/communication.module'
import { DatabaseModule } from './modules/database.module'

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        GraphQLModule.forRoot<ApolloDriverConfig>({
            driver: ApolloDriver,
            autoSchemaFile: true,
        }),
        MediatorModule,
        DatabaseModule,
        CommunicationModule,
        OrderPmsModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}
```

---

## Full verify (Step 7)

```bash
pnpm build:libs
pnpm build:sdks
pnpm --filter @minishop/order build
# run both services (two terminals, or `pnpm dev`)
pnpm dev:catalog
pnpm dev:order
```

1. **Create a product** via catalog GraphQL (`http://localhost:3001/graphql`) and copy its `id`.
2. **Place an order** via order GraphQL (`http://localhost:3002/graphql`):
   ```graphql
   mutation {
     placeOrder(input: {
       productId: "PASTE_CATALOG_PRODUCT_ID"
       quantity: 2
       customerEmail: "buyer@example.com"
     }) {
       id productName quantity unitPrice totalPrice status createdAt
     }
   }
   ```
   Expect: the mutation returns the order with `unitPrice`/`totalPrice` filled from catalog. A row exists in Postgres (`select * from orders;` in the postgres container). In the RabbitMQ UI, the `minishop.order.topic` exchange shows publish activity.
3. **Where did the event go?** Nothing is bound to the order topic exchange yet, so RabbitMQ **discards** the message (a topic exchange with no matching binding drops it — it is not stored anywhere). You'll see it published on the exchange but sitting in no queue. That's expected until Step 8 adds the notification subscriber.
4. **Negative test — the RPC gate:**
   - Nonexistent product: use a valid-format but unknown id like `000000000000000000000000` → mutation errors (`Product ... not found`), **no** order row, **no** event.
   - Over-order: real product id with `quantity: 999999` → errors (`Insufficient stock`), no row, no event.
   - Malformed id: `productId: "abc"` → rejected by `@IsMongoId()` before any RPC even fires.

If all three negatives fail cleanly and the happy path persists + publishes, your synchronous RPC gate and your async event publish are both correct.

---

## Notes & gotchas
- **`CatalogClient` can't resolve `AmqpConnection`?** The order app must import `CommunicationModule` (it configures the global `RabbitMQModule`). It does, in `app.module.ts`.
- **RPC times out (~5s) with catalog running?** Check both services point at the same `RABBITMQ_URI`, and that catalog's RPC queues exist (Step 5 verify). A timeout usually means the routing key or exchange name differs — but since both import from the contract + `directExchangeKey`, that should match by construction.
- **`numeric` prices come back as strings?** That's the transformer's job — confirm `unitPrice`/`totalPrice` are numbers in the GraphQL response. If they're strings, the transformer isn't applied to that column.
- **`synchronize: true`** is convenient now; before any real deployment, switch to migrations driven by `data-source.ts`.
- **Idempotency (real-world note, not needed here):** publishing the event after the DB commit means a crash between commit and publish could lose the event. Production systems use the transactional-outbox pattern to fix this. For MiniShop, the simple "save then publish" is fine — just know the seam exists.
```

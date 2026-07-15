# Steps 4 & 5 — Catalog service: persistence + product feature

Copy-along guide. Build **inner-out**: DB connection → schema → core service → use-cases → GraphQL (to seed data by hand) → RPC handler (what the order service will call). Each phase compiles on its own; wire it into `app.module.ts` as you go so you can start the service and watch it grow.

Final layout you'll reach:
```
services/catalog/src/
├─ app.module.ts                 (update as you go)
├─ main.ts  health.controller.ts (exist)
├─ domain/entities/product.entity.ts        (new — Mongoose schema)
├─ modules/
│  ├─ communication.module.ts    (exists — RabbitMQ)
│  └─ database.module.ts         (new — Mongoose connection)
└─ features/product/
   ├─ core/
   │  ├─ product.interface.ts     (exists — extend it)
   │  └─ product.service.ts       (new — the "brain")
   ├─ use-cases/
   │  ├─ create-product.command.ts (new)
   │  └─ get-product.query.ts      (new)
   ├─ resolvers/
   │  ├─ product.pms.dto.ts         (new — GraphQL types)
   │  └─ product.pms.resolver.ts    (new)
   ├─ integrations/
   │  └─ product.integration.handler.ts  (new — @RpcHandler)
   ├─ product.pms.module.ts         (new — GraphQL wiring)
   └─ product.integration.module.ts (new — RPC wiring)
```

Everything below matches your style (4-space, single quotes, no semicolons) and your deps (`@nestjs/mongoose` 11, `mongoose` 9, `@nestjs/apollo` 13, Apollo Server 5, Fastify).

---

# Step 4 — persistence (Mongo + Mongoose)

## Phase 4a — `database.module.ts`

**File:** `services/catalog/src/modules/database.module.ts`
```ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { MongooseModule } from '@nestjs/mongoose'

@Module({
    imports: [
        MongooseModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                uri: config.getOrThrow<string>('MONGODB_URI'),
            }),
        }),
    ],
})
export class DatabaseModule {}
```

**Understand it:** `forRootAsync` opens **the connection** (once per app) and reads `MONGODB_URI` from your `.env` (`mongodb://minishop:minishop@localhost:27017/minishop_catalog?authSource=admin`). It's async because the URI comes from `ConfigService`, which isn't available until config loads. `getOrThrow` fails loudly at boot if the env var is missing — better than a cryptic connection error later. `forRoot`/`forRootAsync` register the connection globally; individual schemas get registered per-feature with `forFeature` (Phase 5). Connection vs. models: one connection, many models.

## Phase 4b — `product.entity.ts` (the Mongoose schema)

**File:** `services/catalog/src/domain/entities/product.entity.ts`
```ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import type { HydratedDocument } from 'mongoose'

/** A Product document as it lives in Mongo (note: it has `_id`, not `id`). */
export type ProductDocument = HydratedDocument<Product>

@Schema({ collection: 'products', timestamps: true })
export class Product {
    @Prop({ required: true, trim: true })
    name: string

    @Prop({ required: true, min: 0 })
    price: number

    @Prop({ required: true, min: 0, default: 0 })
    availableStock: number
}

export const ProductSchema = SchemaFactory.createForClass(Product)
```

**Understand it — `_id` vs `id`, the boundary rule:** Mongo assigns every document an `ObjectId` `_id`. Your **contract** (`CatalogProduct`) and your **domain** (`Product` interface) both use a plain `string id`. Decide the rule now and never break it: *the persistence layer speaks `_id`; everything above it speaks `string id`; the service converts `_id.toString()` → `id` at the boundary.* This keeps Mongo-specific types (`ObjectId`) from leaking into your GraphQL API or your RabbitMQ contracts. `@Schema`/`@Prop` are the declarative way to define the schema; `SchemaFactory.createForClass` turns the decorated class into a real Mongoose schema. `timestamps: true` adds `createdAt`/`updatedAt` for free.

## Phase 4c — wire `DatabaseModule` and verify Mongo

Add `DatabaseModule` to `app.module.ts` imports (leave the rest for Step 5):
```ts
import { DatabaseModule } from './modules/database.module'
// ...
imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    CommunicationModule,
],
```

**Verify:**
```bash
pnpm infra:up                       # if not already running
pnpm --filter @minishop/catalog build
pnpm dev:catalog
```
Expect logs showing a Mongoose connection with no error, and `GET http://localhost:3001/health` returns ok. Stop the service (`Ctrl-C`) once confirmed.

---

# Step 5 — the product feature

## Phase 5a — extend `product.interface.ts`, then the core service

First, extend the existing domain interface with the two DTO shapes the service needs.

**File:** `services/catalog/src/features/product/core/product.interface.ts`
```ts
/** Domain shape returned to callers (GraphQL + RPC). String id, no Mongo types. */
export interface Product {
    id: string
    name: string
    price: number
    availableStock: number
}

export interface CreateProductInput {
    name: string
    price: number
    availableStock: number
}

export interface StockCheckResult {
    productExists: boolean
    available: boolean
    availableStock: number
}
```

**File:** `services/catalog/src/features/product/core/product.service.ts`
```ts
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { isValidObjectId, type Model } from 'mongoose'

import { Product as ProductEntity, type ProductDocument } from '../../../domain/entities/product.entity'
import type { CreateProductInput, Product, StockCheckResult } from './product.interface'

@Injectable()
export class ProductService {
    constructor(
        @InjectModel(ProductEntity.name)
        private readonly productModel: Model<ProductDocument>,
    ) {}

    async create(input: CreateProductInput): Promise<Product> {
        const created = await this.productModel.create(input)
        return this.toDomain(created)
    }

    async findById(id: string): Promise<Product | null> {
        if (!isValidObjectId(id)) {
            return null
        }
        const doc = await this.productModel.findById(id).exec()
        return doc ? this.toDomain(doc) : null
    }

    async checkStock(productId: string, quantity: number): Promise<StockCheckResult> {
        if (!isValidObjectId(productId)) {
            return { productExists: false, available: false, availableStock: 0 }
        }
        const doc = await this.productModel.findById(productId).exec()
        if (!doc) {
            return { productExists: false, available: false, availableStock: 0 }
        }
        return {
            productExists: true,
            available: doc.availableStock >= quantity,
            availableStock: doc.availableStock,
        }
    }

    /** The boundary conversion: Mongo document -> domain object. */
    private toDomain(doc: ProductDocument): Product {
        return {
            id: String(doc._id),
            name: doc.name,
            price: doc.price,
            availableStock: doc.availableStock,
        }
    }
}
```

**Understand it — "one brain, many mouths":** `ProductService` is the *only* place that knows about Mongoose. It returns plain domain `Product` objects. The GraphQL resolver and the RPC handler will both call it and neither will touch the DB directly. That's why the same logic can serve two entry points without duplication.
- The `isValidObjectId` guards matter: the order service will pass whatever `productId` a client sent. A malformed id would make `findById` throw a `CastError`; we'd rather return "not found" cleanly so `checkStock` can answer `productExists: false`.
- I aliased the entity import as `ProductEntity` so it doesn't collide with the domain `Product` interface. `ProductEntity.name` is still the string `'Product'` (the class's real name), which is the model token Mongoose registers under.

## Phase 5b — use-cases (mediator commands/queries)

**File:** `services/catalog/src/features/product/use-cases/create-product.command.ts`
```ts
import { BaseCommand, CommandHandler, type IHandler } from '@minishop/common'
import { Injectable } from '@nestjs/common'

import type { CreateProductInput, Product } from '../core/product.interface'
import { ProductService } from '../core/product.service'

export class CreateProductCommand extends BaseCommand<Product> {
    constructor(public readonly input: CreateProductInput) {
        super()
    }
}

@Injectable()
@CommandHandler(CreateProductCommand)
export class CreateProductHandler implements IHandler<CreateProductCommand, Product> {
    constructor(private readonly products: ProductService) {}

    execute(command: CreateProductCommand): Promise<Product> {
        return this.products.create(command.input)
    }
}
```

**File:** `services/catalog/src/features/product/use-cases/get-product.query.ts`
```ts
import { BaseQuery, CommandHandler, type IHandler } from '@minishop/common'
import { Injectable } from '@nestjs/common'

import type { Product } from '../core/product.interface'
import { ProductService } from '../core/product.service'

export class GetProductQuery extends BaseQuery<Product | null> {
    constructor(public readonly productId: string) {
        super()
    }
}

@Injectable()
@CommandHandler(GetProductQuery)
export class GetProductHandler implements IHandler<GetProductQuery, Product | null> {
    constructor(private readonly products: ProductService) {}

    execute(query: GetProductQuery): Promise<Product | null> {
        return this.products.findById(query.productId)
    }
}
```

**Understand it — why the indirection is worth it:** the resolver won't call `ProductService`; it'll build a `CreateProductCommand`/`GetProductQuery` and hand it to `Mediator`. Recall the phantom-generic trick from Step 2: because `CreateProductCommand extends BaseCommand<Product>`, `mediator.send(new CreateProductCommand(...))` is typed as `Promise<Product>` automatically. Each handler is `@Injectable()` (so Nest instantiates it) **and** `@CommandHandler(...)` (so the Mediator discovers it) — miss either and dispatch fails. Note `@CommandHandler` is used for the query too; in this project it's the single dispatch decorator for both commands and queries.

## Phase 5c — GraphQL (your manual seeding + inspection tool)

**File:** `services/catalog/src/features/product/resolvers/product.pms.dto.ts`
```ts
import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql'
import { IsInt, IsNotEmpty, IsNumber, IsString, Min } from 'class-validator'

/** GraphQL output type. Type name in the schema is "Product". */
@ObjectType('Product')
export class ProductObjectType {
    @Field(() => ID)
    id: string

    @Field()
    name: string

    @Field(() => Float)
    price: number

    @Field(() => Int)
    availableStock: number
}

/** GraphQL input type. Validated by the global ValidationPipe via class-validator. */
@InputType()
export class CreateProductInput {
    @Field()
    @IsString()
    @IsNotEmpty()
    name: string

    @Field(() => Float)
    @IsNumber()
    @Min(0)
    price: number

    @Field(() => Int)
    @IsInt()
    @Min(0)
    availableStock: number
}
```

**File:** `services/catalog/src/features/product/resolvers/product.pms.resolver.ts`
```ts
import { Mediator } from '@minishop/common'
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql'

import type { Product } from '../core/product.interface'
import { CreateProductCommand } from '../use-cases/create-product.command'
import { GetProductQuery } from '../use-cases/get-product.query'
import { CreateProductInput, ProductObjectType } from './product.pms.dto'

@Resolver(() => ProductObjectType)
export class ProductResolver {
    constructor(private readonly mediator: Mediator) {}

    @Mutation(() => ProductObjectType)
    createProduct(@Args('input') input: CreateProductInput): Promise<Product> {
        return this.mediator.send(new CreateProductCommand(input))
    }

    @Query(() => ProductObjectType, { nullable: true })
    product(@Args('id', { type: () => ID }) id: string): Promise<Product | null> {
        return this.mediator.send(new GetProductQuery(id))
    }
}
```

**File:** `services/catalog/src/features/product/product.pms.module.ts`
```ts
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { Product, ProductSchema } from '../../domain/entities/product.entity'
import { ProductService } from './core/product.service'
import { ProductResolver } from './resolvers/product.pms.resolver'
import { CreateProductHandler } from './use-cases/create-product.command'
import { GetProductHandler } from './use-cases/get-product.query'

@Module({
    imports: [MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema }])],
    providers: [ProductService, ProductResolver, CreateProductHandler, GetProductHandler],
})
export class ProductPmsModule {}
```

**Enable GraphQL + the mediator in `app.module.ts`:**
```ts
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo'
import { MediatorModule } from '@minishop/common'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { GraphQLModule } from '@nestjs/graphql'

import { ProductPmsModule } from './features/product/product.pms.module'
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
        ProductPmsModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}
```

**Understand it:**
- `autoSchemaFile: true` = **code-first** GraphQL: Nest generates the SDL from your `@ObjectType`/`@InputType` decorators at boot, so you never hand-write a `.graphql` schema. Your resolver returns a plain domain `Product`; Apollo maps it onto `ProductObjectType` by matching field names — that's why the interface and the object type share the same field names.
- `MediatorModule` is imported once here (it's `@Global`), so `ProductResolver` can inject `Mediator`. The handlers are discovered because they're providers in `ProductPmsModule`.
- Browse to `http://localhost:3001/graphql` — Apollo serves its Sandbox UI. (If you prefer the classic in-page IDE, add `graphiql: true` to the GraphQL options. `playground` is deprecated in Apollo Server 5, so I left it off.)

## Phase 5d — the RPC integration handler (why order needs catalog)

**File:** `services/catalog/src/features/product/integrations/product.integration.handler.ts`
```ts
import {
    CHECK_STOCK_PATTERN,
    type CheckStockRequest,
    type CheckStockResponse,
    GET_PRODUCT_PATTERN,
    type GetProductRequest,
    type GetProductResponse,
} from '@minishop/catalog-service-types'
import { directExchangeKey, queueKey, RpcHandler, ServiceName } from '@minishop/common'
import { Injectable } from '@nestjs/common'

import { ProductService } from '../core/product.service'

@Injectable()
export class ProductIntegrationHandler {
    constructor(private readonly products: ProductService) {}

    @RpcHandler({
        exchange: directExchangeKey(ServiceName.CATALOG),
        routingKey: GET_PRODUCT_PATTERN,
        queue: queueKey(ServiceName.CATALOG, 'get-product-rpc'),
    })
    async getProduct(request: GetProductRequest): Promise<GetProductResponse> {
        const product = await this.products.findById(request.productId)
        return { product }
    }

    @RpcHandler({
        exchange: directExchangeKey(ServiceName.CATALOG),
        routingKey: CHECK_STOCK_PATTERN,
        queue: queueKey(ServiceName.CATALOG, 'check-stock-rpc'),
    })
    checkStock(request: CheckStockRequest): Promise<CheckStockResponse> {
        return this.products.checkStock(request.productId, request.quantity)
    }
}
```

**File:** `services/catalog/src/features/product/product.integration.module.ts`
```ts
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { Product, ProductSchema } from '../../domain/entities/product.entity'
import { ProductService } from './core/product.service'
import { ProductIntegrationHandler } from './integrations/product.integration.handler'

@Module({
    imports: [MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema }])],
    providers: [ProductService, ProductIntegrationHandler],
})
export class ProductIntegrationModule {}
```

**Add it to `app.module.ts` imports:** append `ProductIntegrationModule` after `ProductPmsModule`.

**Understand it — the RPC responder side:**
- `@RpcHandler({...})` (your alias over golevelup's `RabbitRPC`) tells RabbitMQ: *declare this queue, bind it to the catalog **direct** exchange on this routing key, and when a message arrives, run this method and send its return value back on the caller's reply queue.* That's the server half of RPC; `callRpc` (from the order side in Step 7) is the client half.
- **`direct` exchange, not topic:** RPC routes by an exact key match — there's exactly one responder for `catalog.product.get`. (Events use `topic` because many consumers may want pattern matches. Right tool per job.)
- **`queueKey(...)` gives a stable name** (`minishop.catalog.get-product-rpc.queue`). On restart the handler binds to the *same* queue, so an RPC request that arrived during a blip isn't dropped. An auto-generated random queue name would lose it.
- **Type alignment for free:** `findById` returns the domain `Product | null`, which is structurally identical to the contract's `CatalogProduct | null`, so `return { product }` satisfies `GetProductResponse` with no mapping. Likewise `checkStock` returns exactly `CheckStockResponse`'s shape. This is the payoff of designing the domain and the contract to agree.
- **Discovery:** golevelup finds `@RpcHandler` methods on any provider in the app, so `ProductIntegrationHandler` just needs to be a provider (it is) with `RabbitMQModule` initialized (via `CommunicationModule`, already imported).

---

## Full verify (Step 5)

```bash
pnpm build:libs                      # in case common/types changed
pnpm --filter @minishop/catalog build
pnpm dev:catalog
```
1. **RabbitMQ UI** (http://localhost:15672): under *Exchanges* see `minishop.catalog.direct`; under *Queues* see `minishop.catalog.get-product-rpc.queue` and `...check-stock-rpc.queue`, each bound to the direct exchange on its routing key.
2. **GraphQL** (http://localhost:3001/graphql), create then read a product:
   ```graphql
   mutation {
     createProduct(input: { name: "Coffee Mug", price: 12.5, availableStock: 100 }) {
       id name price availableStock
     }
   }
   ```
   ```graphql
   query {
     product(id: "PASTE_ID_HERE") { id name price availableStock }
   }
   ```
   Data round-trips through Mongo. Copy an `id` — you'll use it in Step 7 to place an order.
3. Full RPC exercise happens in Step 7 from the order side.

---

## Notes & gotchas
- **`ProductService` is registered in two modules** (`ProductPmsModule` and `ProductIntegrationModule`), so Nest creates two instances. That's harmless here because the service is stateless. If it bothers you, extract a tiny `ProductCoreModule` that `providers: [ProductService]` + `exports: [ProductService]` and `imports` the `forFeature`, then import that module in both — one shared instance. Optional; the plan keeps them separate for simplicity.
- **Fastify + Apollo:** `@nestjs/apollo`'s `ApolloDriver` auto-detects the Fastify adapter you use in `main.ts`. No extra setup. If the browser page looks unfamiliar, it's Apollo Sandbox — the modern replacement for the old Playground.
- **Global ValidationPipe** (already in `main.ts` with `whitelist` + `forbidNonWhitelisted`) validates your `@InputType` via its class-validator decorators. Try `price: -1` and watch it get rejected before any handler runs.
- **If a handler "isn't found" by the Mediator:** confirm it's in a module's `providers` and has both `@Injectable()` and `@CommandHandler(...)`.
- **If the RPC queue doesn't appear:** confirm `ProductIntegrationModule` is imported in `app.module.ts` and `CommunicationModule` initialized RabbitMQ (it declares the direct exchange the handler binds to).
```

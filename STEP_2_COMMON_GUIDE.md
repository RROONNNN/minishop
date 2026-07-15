# Step 2 — Building `@minishop/common`: Mediator + Request-Context

This is a copy-along guide. Each phase has: **what you're building**, **why it works that way**, the **full file content** to copy into your `src`, and a small **understand-it** note. Nothing here is written into your source tree for you — you copy it, so you feel every file.

Target layout you'll end up with:
```
libs/common/src/
├─ constants/            (already exists)
├─ utils/                (already exists)
├─ modules/
│  ├─ mediator/
│  │  ├─ base-messages.ts
│  │  ├─ command-handler.decorator.ts
│  │  ├─ mediator.service.ts
│  │  ├─ mediator.module.ts
│  │  └─ index.ts
│  └─ request-context/
│     ├─ request-context.ts
│     └─ index.ts
└─ index.ts             (update the barrel)
```

Conventions I'm matching from your repo: 4-space indent, single quotes, **no semicolons**, trailing commas, `import` groups ordered node → packages → relative. Everything compiles under your `strict` + `experimentalDecorators` tsconfig, and avoids `any`/`Function` so Biome stays quiet.

---

## Phase 2b-1 — `base-messages.ts`

**What:** the vocabulary of the mediator — the base types every command/query/event and every handler extends.

**File:** `libs/common/src/modules/mediator/base-messages.ts`
```ts
/**
 * A command changes state (create/update/delete). A query reads state.
 * Both carry a phantom `TResult` so the Mediator can infer the return type
 * from the message you pass in — see the note below.
 */
export abstract class BaseCommand<TResult = void> {
    // Phantom field. It has no runtime value; it only exists so TypeScript
    // keeps TResult attached to the class and can infer it in `mediator.send()`.
    readonly __result?: TResult
}

export abstract class BaseQuery<TResult = void> {
    readonly __result?: TResult
}

/**
 * An event is a fact: "something happened". It has no result — nobody is
 * waiting on a return value. `occurredAt` is a handy default timestamp.
 */
export abstract class BaseEvent {
    readonly occurredAt: string = new Date().toISOString()
}

/**
 * Every handler implements this. `execute` may be sync or async — the Mediator
 * awaits it either way.
 */
export interface IHandler<TMessage = unknown, TResult = unknown> {
    execute(message: TMessage): Promise<TResult> | TResult
}
```

**Understand it — the phantom `__result`:** TypeScript only infers a generic if it appears in the type. `BaseCommand<TResult>` with nothing using `TResult` would let TS silently drop it. The unused `readonly __result?: TResult` field "pins" the generic so that later, when you write `mediator.send(new GetProductQuery(id))` and `GetProductQuery extends BaseQuery<ProductDto>`, the mediator's return type resolves to `Promise<ProductDto>` automatically. No runtime cost — the field is never assigned.

---

## Phase 2b-2 — `command-handler.decorator.ts`

**What:** the `@CommandHandler(SomeCommand)` marker you put on a handler class. It just stamps metadata; the Mediator reads that metadata at startup.

**File:** `libs/common/src/modules/mediator/command-handler.decorator.ts`
```ts
import { SetMetadata, type Type } from '@nestjs/common'

/** The reflect-metadata key under which we store "which message this handles". */
export const COMMAND_HANDLER_METADATA = 'minishop:command-handler'

/**
 * Marks a class as the handler for a given command/query class.
 *
 * Usage:
 *   @CommandHandler(GetProductQuery)
 *   export class GetProductHandler implements IHandler<GetProductQuery, ProductDto> { ... }
 *
 * `message` is the class itself (the constructor), not an instance. We store it
 * as metadata on the handler class so the Mediator can build a
 * message-class -> handler-instance map.
 */
export const CommandHandler = (message: Type): ClassDecorator =>
    SetMetadata(COMMAND_HANDLER_METADATA, message)
```

**Understand it:** `SetMetadata` is Nest's thin wrapper over `reflect-metadata`'s `Reflect.defineMetadata`. It attaches a key/value pair to the class. The decorator does no wiring by itself — it's a sticky note. The Mediator does the actual reading. `Type` is Nest's "any class constructor" type, so we don't hand-roll a constructor type (and don't trip Biome's no-`any` rule).

---

## Phase 2b-3 — `mediator.service.ts`

**What:** the dispatcher. At startup it scans every provider Nest knows about, finds the ones marked with `@CommandHandler`, and builds an O(1) lookup map. `send()` finds the handler for a message and runs it.

**File:** `libs/common/src/modules/mediator/mediator.service.ts`
```ts
import { Injectable, Logger, type OnModuleInit, type Type } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'

import type { BaseCommand, BaseQuery, IHandler } from './base-messages'
import { COMMAND_HANDLER_METADATA } from './command-handler.decorator'

@Injectable()
export class Mediator implements OnModuleInit {
    private readonly handlers = new Map<Type, IHandler>()
    private readonly logger = new Logger(Mediator.name)

    constructor(private readonly discovery: DiscoveryService) {}

    /**
     * Runs once when the module is initialized. Walks every provider in the
     * app, keeps the ones decorated with @CommandHandler, and registers them.
     */
    onModuleInit(): void {
        for (const wrapper of this.discovery.getProviders()) {
            const { instance, metatype } = wrapper

            // Skip value providers / unresolved instances (no class behind them).
            if (!instance || !metatype) {
                continue
            }

            const messageType: Type | undefined = Reflect.getMetadata(
                COMMAND_HANDLER_METADATA,
                metatype,
            )
            if (!messageType) {
                continue
            }

            const handler = instance as IHandler
            if (typeof handler.execute !== 'function') {
                throw new Error(`Handler ${metatype.name} must implement execute()`)
            }
            if (this.handlers.has(messageType)) {
                throw new Error(`Duplicate handler registered for ${messageType.name}`)
            }

            this.handlers.set(messageType, handler)
            this.logger.log(`Registered ${metatype.name} -> ${messageType.name}`)
        }
    }

    /**
     * Dispatch a command or query to its handler and return the handler's result.
     * TResult is inferred from the message's base class (see phantom __result).
     */
    async send<TResult>(message: BaseCommand<TResult> | BaseQuery<TResult>): Promise<TResult> {
        const messageType = (message as object).constructor as Type
        const handler = this.handlers.get(messageType)

        if (!handler) {
            throw new Error(`No handler registered for ${messageType.name}`)
        }

        return handler.execute(message) as Promise<TResult>
    }
}
```

**Understand it — why scan at startup, not per call:**
- `DiscoveryService.getProviders()` gives you every provider instance in the Nest container. Each `wrapper` has the live `instance` and its `metatype` (the class). We read the metadata your decorator stamped and, if present, map `messageClass -> handlerInstance`.
- Building the `Map` once means `send()` is a single `Map.get` — O(1), no scanning on the hot path.
- The two `throw`s turn silent mistakes into loud startup failures: forget `execute()`, or register two handlers for the same command, and the app refuses to boot instead of misbehaving at runtime.
- The lookup key in `send()` is `message.constructor` — the class of the instance you passed — which matches the class you stored the metadata against.

---

## Phase 2b-4 — `mediator.module.ts`

**What:** the Nest module that provides `Mediator`. It's `@Global()` so any feature module can inject `Mediator` without importing this module every time.

**File:** `libs/common/src/modules/mediator/mediator.module.ts`
```ts
import { Global, Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'

import { Mediator } from './mediator.service'

@Global()
@Module({
    imports: [DiscoveryModule],
    providers: [Mediator],
    exports: [Mediator],
})
export class MediatorModule {}
```

**Understand it:**
- `DiscoveryModule` is what makes `DiscoveryService` injectable — without importing it, the Mediator can't scan providers.
- `@Global()` means: import `MediatorModule` **once** in each service's `AppModule`, and every feature module can inject `Mediator`. Without `@Global()` you'd re-import it everywhere.
- **Important wiring rule:** your handler classes must still be listed in some module's `providers` array (and be `@Injectable`, which `@CommandHandler` does not add — add it yourself, or rely on it being registered as a provider). The Mediator only *discovers* providers Nest already created; it doesn't instantiate them.

---

## Phase 2b-5 — mediator barrel `index.ts`

**File:** `libs/common/src/modules/mediator/index.ts`
```ts
export * from './base-messages'
export * from './command-handler.decorator'
export * from './mediator.service'
export * from './mediator.module'
```

---

## Phase 2c-1 — `request-context.ts`

**What:** a per-request ambient store built on Node's `AsyncLocalStorage`, plus `serialize()/deserialize()` so the context can ride along in RabbitMQ message headers and be rebuilt on the consumer side.

**File:** `libs/common/src/modules/request-context/request-context.ts`
```ts
import { AsyncLocalStorage } from 'node:async_hooks'

/** Prefix used when the context travels as RabbitMQ headers. */
const HEADER_PREFIX = 'x-ctx-'

export interface RequestContextData {
    correlationId?: string
    userId?: string
    [key: string]: unknown
}

/**
 * Ambient per-request store. `AsyncLocalStorage` keeps a separate store for
 * each async call chain, so you can read the current context anywhere without
 * passing it through every function argument.
 */
export class RequestContext {
    private static readonly storage = new AsyncLocalStorage<RequestContextData>()

    /** Run `callback` with `context` as the active store for its whole async chain. */
    static run<T>(context: RequestContextData, callback: () => T): T {
        return RequestContext.storage.run(context, callback)
    }

    /** Read the active context (undefined if called outside a `run`). */
    static get(): RequestContextData | undefined {
        return RequestContext.storage.getStore()
    }

    /** Set/overwrite a single field on the active context. */
    static set(key: string, value: unknown): void {
        const store = RequestContext.storage.getStore()
        if (store) {
            store[key] = value
        }
    }

    /**
     * Flatten the active context into string headers (prefixed) so it can be
     * attached to an outgoing RabbitMQ message.
     */
    static serialize(): Record<string, string> {
        const store = RequestContext.storage.getStore()
        const headers: Record<string, string> = {}
        if (!store) {
            return headers
        }
        for (const [key, value] of Object.entries(store)) {
            if (value !== undefined && value !== null) {
                headers[`${HEADER_PREFIX}${key}`] = String(value)
            }
        }
        return headers
    }

    /**
     * Rebuild a context object from incoming message headers (inverse of
     * `serialize`). Call this on the consumer side, then `run(ctx, ...)`.
     */
    static deserialize(headers: Record<string, unknown> | undefined): RequestContextData {
        const context: RequestContextData = {}
        if (!headers) {
            return context
        }
        for (const [key, value] of Object.entries(headers)) {
            if (key.startsWith(HEADER_PREFIX)) {
                context[key.slice(HEADER_PREFIX.length)] = value
            }
        }
        return context
    }
}
```

**Understand it — why `AsyncLocalStorage`:** In a request you often need a correlation id in logs, DB calls, and outgoing messages. Threading a `ctx` parameter through every function is noisy and easy to forget. `AsyncLocalStorage` gives you an "ambient" value that automatically follows the async chain started by `run()` — every `await` inside still sees the same store. `serialize/deserialize` exist because a new service (across the RabbitMQ boundary) is a brand-new process with an empty store; you carry the ids as headers and re-establish the context there.

---

## Phase 2c-2 — request-context barrel `index.ts`

**File:** `libs/common/src/modules/request-context/index.ts`
```ts
export * from './request-context'
```

---

## Phase 2d — export from the package barrel & build

**Update:** `libs/common/src/index.ts` — add the two module barrels. Final file:
```ts
export * from './constants/exchange-key.constant'
export * from './constants/service-name.enum'
export * from './modules/mediator'
export * from './modules/request-context'
export * from './utils/rabbitmq.utils'
```
(Biome's import/export organizer prefers alphabetical order within a group, hence `modules/*` sits between `constants/*` and `utils/*`.)

**Build & check:**
```bash
pnpm --filter @minishop/common build
# or, from repo root, the ordered libs build:
pnpm build:libs

pnpm test    # existing exchange-key spec should still pass
```

**Verify (from the plan):**
- `pnpm --filter @minishop/common build` exits 0.
- `pnpm test` still green.
- You can say out loud: *"A resolver builds a Command → `mediator.send(command)` → the Mediator looks up the class in its map → the decorated handler's `execute()` runs and returns the result."*

---

## How you'll actually use this later (preview, don't build yet)

In Step 5 (catalog) a use-case + handler will look like this — keep it in mind so the base classes make sense now:
```ts
// use-case message
export class GetProductQuery extends BaseQuery<ProductDto> {
    constructor(public readonly productId: string) {
        super()
    }
}

// handler
@Injectable()
@CommandHandler(GetProductQuery)
export class GetProductHandler implements IHandler<GetProductQuery, ProductDto> {
    constructor(private readonly products: ProductService) {}

    execute(query: GetProductQuery): Promise<ProductDto> {
        return this.products.findById(query.productId)
    }
}

// resolver (thin — no business logic)
const product = await this.mediator.send(new GetProductQuery(id)) // typed as ProductDto
```
Note the handler is both `@Injectable()` and `@CommandHandler(...)`, and it must be listed in its feature module's `providers`. That's the wiring the Mediator relies on.

---

## Common gotchas
- **Handler not found at runtime?** It isn't in any module's `providers`, or you forgot `@Injectable()`, or you decorated the *instance* instead of the *class* in `@CommandHandler`.
- **`Reflect.getMetadata` is undefined?** `reflect-metadata` must be imported once at process start. Nest bootstrap (`@nestjs/core`) already imports it; in a bare Vitest unit test, add `import 'reflect-metadata'` at the top of the test file.
- **`send()` returns `unknown`?** Your command/query didn't `extends BaseCommand<T>` / `BaseQuery<T>`, so the phantom `__result` isn't there to infer from.
- **Two handlers, one command:** intentional hard error at startup — split them or merge the logic.
```

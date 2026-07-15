# Step 3 — Building `@minishop/order-service-types`: the event contract

Copy-along guide. This package is tiny on purpose — a contract is *just* a routing key + a payload shape. The value isn't the code, it's understanding **why a shared contract package exists** and **why the payload looks the way it does**.

Layout you'll end up with:
```
libs/types/order-service/src/
├─ order.event.ts     (new — the order.placed contract)
└─ index.ts           (replace the placeholder)
```

Conventions matched from your repo: 4-space indent, single quotes, no semicolons, `export interface` per shape, one routing-key constant per event. No imports, no dependencies — this package must stay pure.

---

## Why this package exists (read before coding)

The order service **publishes** `order.placed`. The notification service **consumes** it. They must agree on two things:
1. the **routing key** string (`order.placed`) — get one character wrong and RabbitMQ silently never delivers,
2. the **payload shape** — the consumer reads fields the producer promised to send.

If order defined the event and notification imported it from order's `src`, notification would depend on the order service's entire implementation (its DB, its Nest modules) just to know a string and an interface. That's backwards — a consumer should never pull in a producer. So the agreement lives in a **third, neutral package** that both sides import. Neither service depends on the other; both depend on the contract.

That's the whole idea of the `types/` layer: **contracts are the public API of a service; the service is the private implementation.**

---

## Phase 3a — `order.event.ts`

**File:** `libs/types/order-service/src/order.event.ts`
```ts
/**
 * Topic routing key for the "an order was placed" event.
 *
 * The order service publishes to its topic exchange with this key; the
 * notification service binds a queue to the same exchange with this key.
 * Both sides import THIS constant so the string can never drift out of sync.
 *
 * Dotted namespacing (`order.placed`) is a topic-exchange convention: a
 * consumer could later bind `order.*` or `order.#` to catch every order event
 * without the producer changing anything.
 */
export const ORDER_PLACED_ROUTING_KEY = 'order.placed'

/**
 * The payload carried by an `order.placed` event.
 *
 * Design rules for an event payload:
 *  - Include everything a reasonable consumer needs so it doesn't have to call
 *    back to ask (notification wants to render a confirmation without an RPC).
 *  - Use wire-safe primitive types only. No Date objects, no class instances —
 *    this is serialized to JSON and sent over RabbitMQ.
 *  - Treat it as an immutable fact about the past: it describes what happened,
 *    not a request to do something.
 */
export interface OrderPlacedEvent {
    orderId: string
    productId: string
    productName: string
    quantity: number
    unitPrice: number
    totalPrice: number
    /** Where the confirmation "email" goes. Lets notification act with no extra lookup. */
    customerEmail: string
    /** ISO-8601 string (e.g. new Date().toISOString()). NOT a Date — see note below. */
    placedAt: string
}
```

**Understand it — why `placedAt` is a `string`, not a `Date`:** the event is serialized to JSON before it hits RabbitMQ. `JSON.stringify(new Date())` produces a string anyway, and `JSON.parse` gives you back a *string*, not a `Date`. If the interface claimed `placedAt: Date`, the consumer's type would lie about what actually arrives at runtime. Declaring the wire format honestly (`string`) prevents a whole class of "it typechecked but crashed" bugs. The consumer can `new Date(placedAt)` if it needs a real date object.

**Understand it — why include `productName`, `unitPrice`, `customerEmail`:** an event should be *self-sufficient*. Notification's whole job is to send a confirmation; if the payload only had `orderId`, notification would have to call back into order (or catalog) to fetch details — turning a clean fire-and-forget event into a chatty dependency. Carry what consumers need. (Don't over-carry either: no need for internal order status or DB timestamps a consumer never uses.)

---

## Phase 3b — replace the barrel `index.ts`

Delete the placeholder line and re-export the contract.

**File:** `libs/types/order-service/src/index.ts`
```ts
export * from './order.event'
```

That removes `export const CATALOG_SERVICE_SDK_READY = true` (a scaffold placeholder that never belonged here — note it even had the wrong name for this package).

---

## Phase 3c — (optional, recommended) align the catalog naming

Your catalog contracts are inconsistent: `get-product.contract.ts` exports `GET_PRODUCT_CONTRACT`, but `check-stock.contract.ts` exports `CHECK_STOCK_PATTERN`. Pick one — `*_PATTERN` reads best (it's the RabbitMQ routing pattern). Nothing imports `GET_PRODUCT_CONTRACT` yet (the SDK and handler come in Steps 5–6), so renaming now is free; do it later and you'll have to chase call sites.

Change in `libs/types/catalog-service/src/get-product.contract.ts`:
```ts
// before
export const GET_PRODUCT_CONTRACT = 'catalog.product.get'
// after
export const GET_PRODUCT_PATTERN = 'catalog.product.get'
```
The barrel (`export * from './get-product.contract'`) needs no change — it re-exports whatever the file exports. Just remember the new name when you build the SDK/handler.

---

## Phase 3d — build & verify

```bash
pnpm --filter @minishop/order-service-types build
# or the ordered build of all contract packages:
pnpm build:types
```

If you did Phase 3c, also rebuild catalog types (`pnpm build:types` covers both).

**Verify (from the plan):**
- `pnpm build:types` exits 0.
- `libs/types/order-service/dist/` now contains `order.event.js`, `order.event.d.ts`, and an `index.d.ts` that re-exports them.
- Quick check: `ls libs/types/order-service/dist`.

---

## How it gets used later (preview, don't build yet)

**Producer — order service, Step 7** (`place-order.command`):
```ts
import { ORDER_PLACED_ROUTING_KEY, type OrderPlacedEvent } from '@minishop/order-service-types'

const event: OrderPlacedEvent = {
    orderId: order.id,
    productId: order.productId,
    productName: product.name,
    quantity: order.quantity,
    unitPrice: order.unitPrice,
    totalPrice: order.totalPrice,
    customerEmail: input.customerEmail,
    placedAt: new Date().toISOString(),
}

await sendEvent({
    connection,
    exchange: topicExchangeKey(ServiceName.ORDER),
    routingKey: ORDER_PLACED_ROUTING_KEY,
    payload: event,
})
```

**Consumer — notification service, Step 8** (`@RabbitSubscribe`):
```ts
import { ORDER_PLACED_ROUTING_KEY, type OrderPlacedEvent } from '@minishop/order-service-types'

@RabbitSubscribe({
    exchange: topicExchangeKey(ServiceName.ORDER),
    routingKey: ORDER_PLACED_ROUTING_KEY,
    queue: queueKey(ServiceName.NOTIFICATION, 'order-placed'),
})
async onOrderPlaced(event: OrderPlacedEvent) {
    this.logger.log(`Confirmation for order ${event.orderId} -> ${event.customerEmail}`)
}
```

Notice both sides import the **same** constant and the **same** interface from this package — that's the contract doing its job. Neither service imports the other.

---

## Gotchas & good habits
- **Keep it pure.** No `@nestjs/*`, no class-validator, no runtime logic here. The moment a contract package imports a framework, it stops being a neutral meeting point. Validation belongs in the services, not the contract.
- **Changing a published field is a breaking change.** Adding an optional field is safe; renaming/removing/retyping one breaks every consumer at runtime even if TypeScript is happy on your side. This is exactly why the plan says "treat with care."
- **Contract types describe the wire, not your DB.** `id` is a string here even though order stores a uuid and catalog stores a Mongo `_id`. The service maps its internal representation to the contract at the boundary.
- **Routing key is data, not a type.** It's a runtime string constant (`export const`), so it survives into `dist/*.js`. The interfaces are types only and vanish at compile time — that's fine, consumers only need them for compile-time safety.
```

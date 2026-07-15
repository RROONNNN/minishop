import { AsyncLocalStorage } from 'node:async_hooks'

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
const storage = new AsyncLocalStorage<RequestContextData>()

/** Run `callback` with `context` as the active store for its whole async chain. */
function run<T>(context: RequestContextData, callback: () => T): T {
    return storage.run(context, callback)
}

/** Read the active context (undefined if called outside a `run`). */
function get(): RequestContextData | undefined {
    return storage.getStore()
}

/** Set/overwrite a single field on the active context. */
function set(key: string, value: unknown): void {
    const store = storage.getStore()
    if (store) {
        store[key] = value
    }
}

/**
 * Flatten the active context into string headers (prefixed) so it can be
 * attached to an outgoing RabbitMQ message.
 */
function serialize(): Record<string, string> {
    const store = storage.getStore()
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
function deserialize(headers: Record<string, unknown> | undefined): RequestContextData {
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

export const RequestContext = {
    run,
    get,
    set,
    serialize,
    deserialize,
} as const

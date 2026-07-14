import { type AmqpConnection, RabbitRPC } from '@golevelup/nestjs-rabbitmq'

export type MessageHeaders = Record<string, boolean | number | string>

export interface CallRpcOptions<TPayload> {
    connection: AmqpConnection
    exchange: string
    routingKey: string
    payload: TPayload
    timeout?: number
    correlationId?: string
    headers?: MessageHeaders
}

export async function callRpc<TPayload, TResponse>(
    options: CallRpcOptions<TPayload>,
): Promise<TResponse> {
    const {
        connection,
        exchange,
        routingKey,
        payload,
        timeout = 5_000,
        correlationId,
        headers,
    } = options

    return connection.request<TResponse>({
        exchange,
        routingKey,
        payload,
        timeout,
        correlationId,
        headers,
    })
}

export interface SendEventOptions<TPayload> {
    connection: AmqpConnection
    exchange: string
    routingKey: string
    payload: TPayload
    headers?: MessageHeaders
}

export async function sendEvent<TPayload>(options: SendEventOptions<TPayload>): Promise<void> {
    const { connection, exchange, routingKey, payload, headers } = options

    await connection.publish(exchange, routingKey, payload, {
        persistent: true,
        headers,
    })
}

export type RpcHandlerOptions = Parameters<typeof RabbitRPC>[0]

export function RpcHandler(options: RpcHandlerOptions): MethodDecorator {
    return RabbitRPC(options)
}

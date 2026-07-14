import type { ServiceName } from './service-name.enum'

const APPLICATION_PREFIX = 'minishop'
export function directExchangeKey(service: ServiceName): string {
    return `${APPLICATION_PREFIX}.${service}.direct`
}
export function topicExchangeKey(service: ServiceName): string {
    return `${APPLICATION_PREFIX}.${service}.topic`
}
export function fanoutExchangeKey(service: ServiceName): string {
    return `${APPLICATION_PREFIX}.${service}.fanout`
}

export function queueKey(service: ServiceName, consumerName: string): string {
    const normalizedConsumerName = consumerName
        .trim()
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replaceAll(/^-|-$/g, '')
    if (!normalizedConsumerName) {
        throw new Error('Consumer name cannot be empty')
    }

    return `${APPLICATION_PREFIX}.${service}.${normalizedConsumerName}.queue`
}

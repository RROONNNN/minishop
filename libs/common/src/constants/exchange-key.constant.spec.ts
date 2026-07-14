import { describe, expect, it } from 'vitest'

import {
    directExchangeKey,
    fanoutExchangeKey,
    queueKey,
    topicExchangeKey,
} from './exchange-key.constant'
import { ServiceName } from './service-name.enum'

describe('exchange-key helpers', () => {
    it('creates a direct exchange name', () => {
        expect(directExchangeKey(ServiceName.CATALOG)).toBe('minishop.catalog.direct')
    })

    it('creates a topic exchange name', () => {
        expect(topicExchangeKey(ServiceName.ORDER)).toBe('minishop.order.topic')
    })

    it('creates a fanout exchange name', () => {
        expect(fanoutExchangeKey(ServiceName.NOTIFICATION)).toBe('minishop.notification.fanout')
    })

    it('normalizes the queue consumer name', () => {
        expect(queueKey(ServiceName.NOTIFICATION, 'Order Placed Handler')).toBe(
            'minishop.notification.order-placed-handler.queue',
        )
    })

    it('rejects an empty consumer name', () => {
        expect(() => {
            queueKey(ServiceName.CATALOG, '   ')
        }).toThrow('Consumer name cannot be empty')
    })
})

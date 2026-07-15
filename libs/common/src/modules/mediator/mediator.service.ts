import { Injectable, Logger, type OnModuleInit, type Type } from '@nestjs/common'
import type { DiscoveryService } from '@nestjs/core'

import type { BaseCommand, BaseQuery, IHandler } from './base-messages'
import { COMMAND_HANDLER_METADATA } from './command-handler.decorator'

@Injectable()
export class Mediator implements OnModuleInit {
    private readonly handlers = new Map<Type, IHandler>()
    private readonly logger = new Logger(Mediator.name)

    constructor(private readonly discovery: DiscoveryService) {}

    onModuleInit(): void {
        const providers = this.discovery.getProviders()
        for (const provider of providers) {
            const { instance, metatype } = provider
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
    async send<TResult>(message: BaseCommand<TResult> | BaseQuery<TResult>): Promise<TResult> {
        const messageType = (message as object).constructor as Type
        const handler = this.handlers.get(messageType)
        if (!handler) {
            throw new Error(`No handler registered for ${messageType.name}`)
        }
        return handler.execute(message) as Promise<TResult>
    }
}

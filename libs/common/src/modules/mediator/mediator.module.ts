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

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { HealthController } from './health.controller'
import { CommunicationModule } from './modules/communication.module'

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
        }),
        CommunicationModule,
    ],
    controllers: [HealthController],
})
export class AppModule {}

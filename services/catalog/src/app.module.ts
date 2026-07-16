import { MediatorModule } from '@minishop/common'
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { GraphQLModule } from '@nestjs/graphql'

import { ProductPmsModule } from './features/product/product.pms.module'
import { HealthController } from './health.controller'
import { CommunicationModule } from './modules/communication.module'
import { DatabaseModule } from './modules/database.module'
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
        }),
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

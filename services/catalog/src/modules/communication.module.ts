import { type RabbitMQConfig, RabbitMQModule } from '@golevelup/nestjs-rabbitmq'
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'

import { directExchangeKey, ServiceName, topicExchangeKey } from '../../../../libs/common/dist'
@Module({
    imports: [
        RabbitMQModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService): RabbitMQConfig => ({
                uri: configService.getOrThrow<string>('RABBITMQ_URI'),
                exchanges: [
                    {
                        name: directExchangeKey(ServiceName.CATALOG),
                        type: 'direct',
                    },
                    {
                        name: topicExchangeKey(ServiceName.CATALOG),
                        type: 'topic',
                    },
                ],
            }),
        }),
    ],
    exports: [RabbitMQModule],
})
export class CommunicationModule {}

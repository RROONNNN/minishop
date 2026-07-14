import { AmqpConnection } from '@golevelup/nestjs-rabbitmq'
import { Controller, Get, Inject } from '@nestjs/common'
@Controller('health')
export class HealthController {
    constructor(@Inject(AmqpConnection) private readonly amqpConnection: AmqpConnection) {}
    @Get()
    check() {
        return {
            status: 'ok',
            service: 'catalog',
            rabbitmq: {
                connected: this.amqpConnection.connected,
            },
        }
    }
}

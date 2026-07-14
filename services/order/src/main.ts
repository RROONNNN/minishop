import { ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import {
    FastifyAdapter,
    type NestFastifyApplication,
} from '@nestjs/platform-fastify'

import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter(),
    )

    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
        }),
    )

    const port = Number(process.env.PORT ?? 3002)

    await app.listen(port, '0.0.0.0')

    console.log(`Order service running on port ${port}`)
}

void bootstrap()
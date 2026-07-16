import { Injectable } from '@nestjs/common'
import type { DiscoveryService } from '@nestjs/core'

@Injectable()
export class Foo {
    constructor(private readonly d: DiscoveryService) {}
}

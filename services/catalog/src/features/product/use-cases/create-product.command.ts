import { BaseCommand, CommandHandler, type IHandler } from '@minishop/common'
import { Injectable } from '@nestjs/common'

import type { CreateProductInput, Product } from '../core/product.interface'
import type { ProductService } from '../core/product.service'

export class CreateProductCommand extends BaseCommand<Product> {
    constructor(public readonly input: CreateProductInput) {
        super()
    }
}
@Injectable()
@CommandHandler(CreateProductCommand)
export class CreateProductHandler implements IHandler<CreateProductCommand, Product> {
    constructor(private readonly products: ProductService) {}

    execute(command: CreateProductCommand): Promise<Product> {
        return this.products.create(command.input)
    }
}

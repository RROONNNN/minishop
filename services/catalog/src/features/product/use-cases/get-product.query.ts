import { BaseQuery, CommandHandler, type IHandler } from '@minishop/common'
import { Injectable } from '@nestjs/common'

import type { Product } from '../core/product.interface'
import type { ProductService } from '../core/product.service'

export class GetProductQuery extends BaseQuery<Product | null> {
    constructor(public readonly productId: string) {
        super()
    }
}

@Injectable()
@CommandHandler(GetProductQuery)
export class GetProductHandler implements IHandler<GetProductQuery, Product | null> {
    constructor(private readonly products: ProductService) {}

    execute(query: GetProductQuery): Promise<Product | null> {
        return this.products.findById(query.productId)
    }
}

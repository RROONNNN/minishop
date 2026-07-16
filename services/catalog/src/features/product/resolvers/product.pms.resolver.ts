import type { Mediator } from '@minishop/common'
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql'

import { CreateProductInput, ProductObjectType } from './product.pms.dto'
import type { Product } from '../core/product.interface'
import { CreateProductCommand } from '../use-cases/create-product.command'
import { GetProductQuery } from '../use-cases/get-product.query'

@Resolver(() => ProductObjectType)
export class ProductResolver {
    constructor(private readonly mediator: Mediator) {}
    @Mutation(() => ProductObjectType)
    createProduct(
        @Args('input', { type: () => CreateProductInput }) input: CreateProductInput,
    ): Promise<Product> {
        return this.mediator.send(new CreateProductCommand(input))
    }
    @Query(() => ProductObjectType, { nullable: true })
    product(@Args('id', { type: () => ID }) id: string): Promise<Product | null> {
        return this.mediator.send(new GetProductQuery(id))
    }
}

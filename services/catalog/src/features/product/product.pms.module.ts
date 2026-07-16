import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'

import { ProductService } from './core/product.service'
import { ProductResolver } from './resolvers/product.pms.resolver'
import { CreateProductHandler } from './use-cases/create-product.command'
import { GetProductHandler } from './use-cases/get-product.query'
import { Product, ProductSchema } from '../../domain/entities/product.entity'

@Module({
    imports: [MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema }])],
    providers: [ProductService, ProductResolver, CreateProductHandler, GetProductHandler],
})
export class ProductPmsModule {}

import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { isValidObjectId, type Model } from 'mongoose'

import type { CreateProductInput, Product, StockCheckResult } from './product.interface'
import {
    type ProductDocument,
    Product as ProductEntity,
} from '../../../domain/entities/product.entity'

@Injectable()
export class ProductService {
    constructor(
        @InjectModel(ProductEntity.name)
        private readonly productModel: Model<ProductDocument>,
    ) {}

    async create(input: CreateProductInput): Promise<Product> {
        const created = await this.productModel.create(input)
        return this.toDomain(created)
    }
    async findById(id: string): Promise<Product | null> {
        const created = await this.productModel.findById(id)
        if (!created) {
            return null
        }
        return this.toDomain(created)
    }
    async checkStock(productId: string, quantity: number): Promise<StockCheckResult> {
        if (!isValidObjectId(productId)) {
            return { productExists: false, available: false, availableStock: 0 }
        }
        const doc = await this.productModel.findById(productId).exec()
        if (!doc) {
            return { productExists: false, available: false, availableStock: 0 }
        }
        return {
            productExists: true,
            available: doc.availableStock >= quantity,
            availableStock: doc.availableStock,
        }
    }

    private toDomain(doc: ProductDocument): Product {
        return {
            id: String(doc._id),
            name: doc.name,
            price: doc.price,
            availableStock: doc.availableStock,
        }
    }
}

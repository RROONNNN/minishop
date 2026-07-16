import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import type { HydratedDocument } from 'mongoose'

export type ProductDocument = HydratedDocument<Product>

@Schema({ collection: 'products', timestamps: true })
export class Product {
    @Prop({ required: true, trim: true })
    name: string
    @Prop({ required: true, min: 0 })
    price: number

    @Prop({ required: true, min: 0, default: 0 })
    availableStock: number
}
export const ProductSchema = SchemaFactory.createForClass(Product)

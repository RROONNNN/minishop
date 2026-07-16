import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql'
import { IsInt, IsNotEmpty, IsNumber, IsString, Min } from 'class-validator'

@ObjectType('Product')
export class ProductObjectType {
    @Field(() => ID)
    id: string

    @Field()
    name: string

    @Field(() => Float)
    price: number

    @Field(() => Int)
    availableStock: number
}

/** GraphQL input type. Validated by the global ValidationPipe via class-validator. */
@InputType()
export class CreateProductInput {
    @Field()
    @IsString()
    @IsNotEmpty()
    name: string

    @Field(() => Float)
    @IsNumber()
    @Min(0)
    price: number

    @Field(() => Int)
    @IsInt()
    @Min(0)
    availableStock: number
}

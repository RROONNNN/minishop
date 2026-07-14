export const GET_PRODUCT_CONTRACT = 'catalog.product.get'

export interface CatalogProduct {
    id: string
    name: string
    price: number
    availableStock: number
}

export interface GetProductRequest {
    productId: string
}
export interface GetProductResponse {
    product: CatalogProduct | null
}

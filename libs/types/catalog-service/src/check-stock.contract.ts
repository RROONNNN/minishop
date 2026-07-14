export const CHECK_STOCK_PATTERN = 'catalog.product.check-stock'

export interface CheckStockRequest {
    productId: string
    quantity: number
}

export interface CheckStockResponse {
    productExists: boolean
    available: boolean
    availableStock: number
}

export interface Product {
    id: string
    name: string
    price: number
    availableStock: number
}
export interface CreateProductInput {
    name: string
    price: number
    availableStock: number
}

export interface StockCheckResult {
    productExists: boolean
    available: boolean
    availableStock: number
}

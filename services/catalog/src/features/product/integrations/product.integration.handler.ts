import { directExchangeKey, queueKey, RpcHandler, ServiceName } from '@minishop/common'

import {
    CHECK_STOCK_PATTERN,
    type CheckStockRequest,
    type CheckStockResponse,
    GET_PRODUCT_PATTERN,
    type GetProductRequest,
    type GetProductResponse,
} from '../../../../../../libs/types/catalog-service/dist'
import type { ProductService } from '../core/product.service'

export class ProductIntegrationHandler {
    constructor(private readonly products: ProductService) {}
    @RpcHandler({
        exchange: directExchangeKey(ServiceName.CATALOG),
        routingKey: GET_PRODUCT_PATTERN,
        queue: queueKey(ServiceName.CATALOG, 'get-product-rpc'),
    })
    async getProduct(request: GetProductRequest): Promise<GetProductResponse> {
        const product = await this.products.findById(request.productId)
        return {
            product,
        }
    }
    @RpcHandler({
        exchange: directExchangeKey(ServiceName.CATALOG),
        routingKey: CHECK_STOCK_PATTERN,
        queue: queueKey(ServiceName.CATALOG, 'check-stock-rpc'),
    })
    checkStock(request: CheckStockRequest): Promise<CheckStockResponse> {
        return this.products.checkStock(request.productId, request.quantity)
    }
}

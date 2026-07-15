export const ORDER_PLACED_ROUTING_KEY = 'order.placed'
export interface OrderPlacedEvent {
    orderId: string
    productId: string
    productName: string
    quantity: number
    unitPrice: number
    totalPrice: number
    /** Where the confirmation "email" goes. Lets notification act with no extra lookup. */
    customerEmail: string
    /** ISO-8601 string (e.g. new Date().toISOString()). */
    placedAt: string
}

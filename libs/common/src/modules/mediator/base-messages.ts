export abstract class BaseCommand<TResult = void> {
    readonly __result?: TResult
}
export abstract class BaseQuery<TResult = void> {
    readonly __result?: TResult
}
export abstract class BaseEvent {
    readonly occurredAt: string = new Date().toISOString()
}
export interface IHandler<TMessage = unknown, TResult = unknown> {
    execute(message: TMessage): Promise<TResult> | TResult
}

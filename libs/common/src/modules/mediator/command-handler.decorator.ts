import type { Type } from '@nestjs/common'
import { SetMetadata } from '@nestjs/common/decorators'

export const COMMAND_HANDLER_METADATA = 'minishop:command-handler'
export const CommandHandler = (message: Type): ClassDecorator =>
    SetMetadata(COMMAND_HANDLER_METADATA, message)

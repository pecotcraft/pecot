// 案内（domain/command-hint.ts）の再 export と、定義の登録。出し先は CommandIo の surface で決まり、無ければ CLI の形。
import { registerHintCommands } from '../domain/command-hint.js'
import type { CommandDefinition } from './command-definition.js'

export { commandHint, globalRepositoryHint, hinted, hintedTextOf, inputHint, inputNameHint, joinHinted, placeholder } from '../domain/command-hint.js'
export type { CommandHint, HintedText } from '../domain/command-hint.js'

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型
export function registerCommandHints(definitions: readonly CommandDefinition[]): void {
  registerHintCommands(definitions.map(definition => ({
    path: definition.path,
    positional: definition.positional,
    inputs: Object.keys(definition.input.shape),
    hasOwnRepo: definition.hasOwnRepo,
  })))
}

// 案内（domain/command-hint.ts）の再 export と、ツールの定義の登録。
import { registerHintCommands } from '../domain/command-hint.js'
import type { ToolDefinition } from './command-definition.js'

export { commandHint, globalRepositoryHint, hinted, hintedTextOf, inputHint, inputNameHint, joinHinted, placeholder, RUN, RUN_COLON, runAgain } from '../domain/command-hint.js'
export type { HintedText } from '../domain/command-hint.js'

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod の型
export function registerToolHints(definitions: readonly ToolDefinition[]): void {
  registerHintCommands(definitions.map(definition => ({ name: definition.name, inputs: Object.keys(definition.input.shape) })))
}

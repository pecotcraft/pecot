// tools/list の annotations。定義書の書き出しも同じ値を使い、effects との一致は interface-spec の検証が確かめる。
import type { ToolAnnotations } from '@modelcontextprotocol/server'

import type { CommandDefinition } from '../commands/registry.js'

/**
readOnlyHint だけを付ける。effects の destructive は MCP の destructiveHint より狭く、false を導くと上書きを「足すだけ」と偽るので、既定値の true に任せる
*/
export function toolAnnotationsOf(definition: Readonly<Pick<CommandDefinition, 'readOnly'>>): ToolAnnotations {
  return { readOnlyHint: definition.readOnly }
}

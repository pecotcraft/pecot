// tools/list の annotations。定義書の書き出しも同じ値を使い、effects との一致は interface-spec の検証が確かめる。
import type { ToolAnnotations } from '@modelcontextprotocol/server'

import type { ToolDefinition } from '../commands/registry.js'

/**
readOnlyHint だけを付ける。effects の種類は MCP の annotations に合わせてある。destructiveHint は付けず、既定値に任せる
*/
export function toolAnnotationsOf(definition: Readonly<Pick<ToolDefinition, 'readOnly'>>): ToolAnnotations {
  return { readOnlyHint: definition.readOnly }
}

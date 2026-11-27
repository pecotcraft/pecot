// MCP の Tool の annotations を、ツールの定義から作る。
import type { ToolAnnotations } from '@modelcontextprotocol/server'

import type { ToolDefinition } from '../commands/registry.js'

/**
読むだけの印は readOnlyHint に、外の世界に触れない印は openWorldHint: false にする。openWorldHint は印が無ければ出さない（既定の true のまま）
*/
export function toolAnnotationsOf(definition: Readonly<Pick<ToolDefinition, 'readOnly' | 'openWorld'>>): ToolAnnotations {
  return { readOnlyHint: definition.readOnly, ...definition.openWorld === false && { openWorldHint: false } }
}

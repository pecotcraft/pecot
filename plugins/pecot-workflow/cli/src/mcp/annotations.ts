// MCP の Tool の annotations を、ツールの定義から作る。
import type { ToolAnnotations } from '@modelcontextprotocol/server'

import type { ToolDefinition } from '../commands/registry.js'

/**
読むだけの印は readOnlyHint に、外の世界に触れない印は openWorldHint: false に、書き込む印は destructiveHint・idempotentHint にする。
openWorldHint は印が無ければ出さない（既定の true のまま）。2 つのヒントは readOnlyHint が false のときだけ意味を持つ
*/
export function toolAnnotationsOf(definition: Readonly<Pick<ToolDefinition, 'readOnly' | 'openWorld' | 'writes'>>): ToolAnnotations {
  return {
    readOnlyHint: definition.readOnly,
    ...definition.writes !== undefined && { destructiveHint: definition.writes.destructive, idempotentHint: definition.writes.idempotent },
    ...definition.openWorld === false && { openWorldHint: false },
  }
}

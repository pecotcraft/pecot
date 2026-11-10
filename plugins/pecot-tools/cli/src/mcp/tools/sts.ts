// STS 系のツール定義。

import { z } from 'zod'

import { STS_GET_CALLER_IDENTITY } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import { allowlistedTool, COMMON_INPUT_SHAPE, type ToolOptions } from './_shared.js'

export function stsTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: STS_GET_CALLER_IDENTITY,
      title: 'Get caller identity',
      description: 'Returns the account ID, user ID, and ARN of the current credentials. Use it to check that authentication works',
      inputSchema: z.object({ ...COMMON_INPUT_SHAPE }),
    }, options),
  ]
}

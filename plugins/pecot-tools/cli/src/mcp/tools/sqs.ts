// SQS 系のツール定義。

import { z } from 'zod'

import { SQS_GET_QUEUE_ATTRIBUTES, SQS_LIST_QUEUES } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ToolOptions,
} from './_shared.js'

/**
Attribute names to get. Defaults to all attributes。
*/
const ATTRIBUTE_NAMES_INPUT = z.array(z.string()).default(['All']).describe('Attribute names to get. Defaults to all attributes')

export function sqsTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: SQS_LIST_QUEUES,
      title: 'List queues',
      description: 'Lists SQS queue URLs. Narrow by name prefix with queue_name_prefix',
      inputSchema: z.object({
        queue_name_prefix: z.string().optional().describe('Queue name prefix'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: SQS_GET_QUEUE_ATTRIBUTES,
      title: 'Get queue attributes',
      description: 'Returns the attributes of one queue (backlog counts, visibility timeout, dead-letter queue settings, etc.)',
      inputSchema: z.object({
        queue_url: z.string().describe('Queue URL (starts with https://)'),
        attribute_names: ATTRIBUTE_NAMES_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

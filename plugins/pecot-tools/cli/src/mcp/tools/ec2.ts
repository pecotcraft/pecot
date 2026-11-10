// EC2 系のツール定義。

import { z } from 'zod'

import { EC2_DESCRIBE_INSTANCES } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ToolOptions,
} from './_shared.js'

/**
絞り込み条件 1 件。`values` のいずれかに一致すれば対象になる。

`z.object` は宣言外のキーを通知せず削るため strictObject を使う。
JSON Schema では `items.additionalProperties: false` になり、SDK が入力検証エラーで拒否する。
*/
const FILTER_ELEMENT = z.strictObject({
  name: z.string().describe('Filter name (e.g. instance-state-name, tag:Name)'),
  values: z.array(z.string()).min(1).describe('Values; an instance matches if any one matches'),
})

const INSTANCE_IDS_INPUT = z.array(z.string()).min(1).optional().describe('Instance IDs to get (i-... form)')

export function ec2Tools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: EC2_DESCRIBE_INSTANCES,
      title: 'List EC2 instances',
      description: 'Returns instance state, type, tags, and network configuration. Output is large, so narrow it with max_items or filters',
      inputSchema: z.object({
        instance_ids: INSTANCE_IDS_INPUT,
        filters: z.array(FILTER_ELEMENT).optional().describe('Filter conditions. With several, only instances matching all are returned'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

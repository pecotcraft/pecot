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
取得する属性名。既定は全属性。
*/
const ATTRIBUTE_NAMES_INPUT = z.array(z.string()).default(['All']).describe('取得する属性名。既定は全属性')

export function sqsTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: SQS_LIST_QUEUES,
      title: 'キューの一覧',
      description: 'SQS のキュー URL を一覧する。queue_name_prefix でキュー名の前方一致に絞れる',
      inputSchema: z.object({
        queue_name_prefix: z.string().optional().describe('キュー名の前方一致'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: SQS_GET_QUEUE_ATTRIBUTES,
      title: 'キュー属性の取得',
      description: 'キュー 1 本の属性（滞留件数・可視性タイムアウト・デッドレターキュー設定等）を返す',
      inputSchema: z.object({
        queue_url: z.string().describe('キューの URL（https:// で始まる）'),
        attribute_names: ATTRIBUTE_NAMES_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

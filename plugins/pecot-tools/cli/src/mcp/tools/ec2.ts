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
  name: z.string().describe('フィルタ名（instance-state-name・tag:Name 等）'),
  values: z.array(z.string()).min(1).describe('いずれかに一致すれば対象になる値'),
})

const INSTANCE_IDS_INPUT = z.array(z.string()).min(1).optional().describe('取得するインスタンス ID（i-… の形式）')

export function ec2Tools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: EC2_DESCRIBE_INSTANCES,
      title: 'EC2 インスタンスの一覧',
      description: 'インスタンスの状態・タイプ・タグ・ネットワーク構成を返す。出力が大きいので max_items か filters で絞る',
      inputSchema: z.object({
        instance_ids: INSTANCE_IDS_INPUT,
        filters: z.array(FILTER_ELEMENT).optional().describe('絞り込み条件。複数指定すると全てに一致するものが返る'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

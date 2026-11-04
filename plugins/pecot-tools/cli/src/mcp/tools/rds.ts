// RDS 系のツール定義。
//
// 3 件とも `--filters` は公開しない。API が受ける属性はバージョンで変わるため、契約に固定できる
// 引数だけに絞っている。

import { z } from 'zod'

import {
  RDS_DESCRIBE_DB_CLUSTERS,
  RDS_DESCRIBE_DB_INSTANCES,
  RDS_DESCRIBE_EVENTS,
  RDS_SOURCE_TYPE_VALUES,
} from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ToolOptions,
} from './_shared.js'

/**
イベントを引ける発生元の種別。許可リストと同じ配列を読む（綴りの定義元は allowlist.ts）。
*/
const SOURCE_TYPE_ENUM = z.enum(RDS_SOURCE_TYPE_VALUES)

/**
絞り込むイベントカテゴリ。
*/
const EVENT_CATEGORIES_INPUT = z.array(z.string()).min(1).optional()
  .describe('絞り込むイベントカテゴリ（availability・failover 等）')

export function rdsTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: RDS_DESCRIBE_EVENTS,
      title: 'RDS イベントの取得',
      description: 'DB インスタンス・クラスタのイベント履歴（停止・起動・フェイルオーバー等）を返す。指定しない場合は直近 1 時間ぶんで、保持期間は 14 日',
      inputSchema: z.object({
        source_identifier: z.string().optional()
          .describe('イベントの発生元の識別子。指定するときは source_type も併せて指定する'),
        source_type: SOURCE_TYPE_ENUM.optional().describe('イベントの発生元の種別'),
        start_time: z.string().optional()
          .describe('取得開始時刻。ISO 8601 形式で、タイムゾーン（Z か +09:00 形式）必須（2026-09-01T00:00:00Z / 2026-09-01T09:00:00+09:00）'),
        end_time: z.string().optional()
          .describe('取得終了時刻。ISO 8601 形式で、タイムゾーン（Z か +09:00 形式）必須（start_time と同じ書式）'),
        duration: z.number().int().min(1).optional()
          .describe('現在から遡る分数。start_time / end_time とは併用できない'),
        event_categories: EVENT_CATEGORIES_INPUT,
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: RDS_DESCRIBE_DB_CLUSTERS,
      title: 'DB クラスタの一覧',
      description: 'Aurora / Multi-AZ DB クラスタの構成と状態を返す。db_cluster_identifier で 1 本に絞れる',
      inputSchema: z.object({
        db_cluster_identifier: z.string().optional().describe('クラスタ識別子または ARN。未指定なら全件'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: RDS_DESCRIBE_DB_INSTANCES,
      title: 'DB インスタンスの一覧',
      description: 'DB インスタンスの構成と状態（DBInstanceStatus・エンドポイント等）を返す。db_instance_identifier で 1 台に絞れる',
      inputSchema: z.object({
        db_instance_identifier: z.string().optional().describe('インスタンス識別子または ARN。未指定なら全件'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

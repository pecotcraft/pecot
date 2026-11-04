// CloudWatch（メトリクス）系のツール定義。
//
// ログ系は logs.ts が持つ。こちらはメトリクスの統計取得だけを公開する。

import { z } from 'zod'

import { CLOUDWATCH_GET_METRIC_STATISTICS, CLOUDWATCH_UNIT_VALUES } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import { allowlistedTool, COMMON_INPUT_SHAPE, type ToolOptions } from './_shared.js'

/**
ディメンション 1 件。`z.object` は宣言外のキーを通知せず削るため strictObject を使う。
JSON Schema では `items.additionalProperties: false` になり、SDK が入力検証エラーで拒否する。
*/
const DIMENSION_ELEMENT = z.strictObject({
  name: z.string().describe('ディメンション名（QueueName・FunctionName 等）'),
  value: z.string().describe('ディメンション値'),
})

/**
取得できる統計値。パーセンタイル（ExtendedStatistics）は公開しない。
*/
const STATISTIC_ENUM = z.enum(['SampleCount', 'Average', 'Sum', 'Minimum', 'Maximum'])

/**
CloudWatch の標準単位。許可リストと同じ配列を読む（綴りの定義は allowlist.ts）。
*/
const UNIT_ENUM = z.enum(CLOUDWATCH_UNIT_VALUES)

export function cloudwatchTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: CLOUDWATCH_GET_METRIC_STATISTICS,
      title: 'メトリクス統計の取得',
      description: 'メトリクス 1 本の統計値を期間指定で取得する。dimensions はメトリクス作成時と同じ組み合わせを全て指定しないと空の結果になる',
      inputSchema: z.object({
        namespace: z.string().describe('メトリクスの名前空間（AWS/SQS・AWS/Lambda 等）'),
        metric_name: z.string().describe('メトリクス名（NumberOfMessagesSent 等）'),
        dimensions: z.array(DIMENSION_ELEMENT).max(30).optional()
          .describe('絞り込むディメンション。メトリクスが持つ組み合わせを過不足なく指定する'),
        start_time: z.string().describe('取得開始時刻。ISO 8601 形式で、タイムゾーン（Z か +09:00 形式）必須（2026-09-01T00:00:00Z / 2026-09-01T09:00:00+09:00）'),
        end_time: z.string().describe('取得終了時刻。ISO 8601 形式で、タイムゾーン（Z か +09:00 形式）必須（start_time と同じ書式）'),
        period: z.number().int().min(1).describe('集計間隔（秒）。60 の倍数で指定する'),
        statistics: z.array(STATISTIC_ENUM).min(1).max(5)
          .describe('取得する統計値。1〜5 件を指定する'),
        unit: UNIT_ENUM.optional()
          .describe('絞り込む単位。データの単位と一致しないと結果が空になる'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

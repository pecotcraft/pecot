// CloudWatch（メトリクス）系のツール定義。ログ系は logs.ts が持つ。

import { z } from 'zod'

import { CLOUDWATCH_GET_METRIC_STATISTICS, CLOUDWATCH_UNIT_VALUES } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import { allowlistedTool, COMMON_INPUT_SHAPE, type ToolOptions } from './_shared.js'

/**
ディメンション 1 件。`z.object` は宣言外のキーを通知せず削るため strictObject を使う。
JSON Schema では `items.additionalProperties: false` になり、SDK が入力検証エラーで拒否する。
*/
const DIMENSION_ELEMENT = z.strictObject({
  name: z.string().describe('Dimension name (e.g. QueueName, FunctionName)'),
  value: z.string().describe('Dimension value'),
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
      title: 'Get metric statistics',
      description: 'Gets statistics of one metric over a time range. Specify all dimensions exactly as when the metric was published, or the result is empty',
      inputSchema: z.object({
        namespace: z.string().describe('Metric namespace (e.g. AWS/SQS, AWS/Lambda)'),
        metric_name: z.string().describe('Metric name (e.g. NumberOfMessagesSent)'),
        dimensions: z.array(DIMENSION_ELEMENT).max(30).optional()
          .describe('Dimensions to filter by. Specify exactly the combination the metric has'),
        start_time: z.string().describe('Start time. ISO 8601 with a required timezone (Z or +09:00 form), e.g. 2026-09-01T00:00:00Z / 2026-09-01T09:00:00+09:00'),
        end_time: z.string().describe('End time. ISO 8601 with a required timezone (Z or +09:00 form), same format as start_time'),
        period: z.number().int().min(1).describe('Aggregation period in seconds. Must be a multiple of 60'),
        statistics: z.array(STATISTIC_ENUM).min(1).max(5)
          .describe('Statistics to get. Specify 1 to 5'),
        unit: UNIT_ENUM.optional()
          .describe('Unit to filter by. The result is empty if it does not match the unit of the data'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

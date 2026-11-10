// RDS 系のツール定義。`--filters` は公開しない。API の受ける属性がバージョンで変わるため。

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
  .describe('Event categories to filter by (e.g. availability, failover)')

export function rdsTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: RDS_DESCRIBE_EVENTS,
      title: 'Get RDS events',
      description: 'Returns the event history of DB instances and clusters (stop, start, failover, etc.). Without a range, covers the last 1 hour; events are retained for 14 days',
      inputSchema: z.object({
        source_identifier: z.string().optional()
          .describe('Identifier of the event source. When specified, also specify source_type'),
        source_type: SOURCE_TYPE_ENUM.optional().describe('Type of the event source'),
        start_time: z.string().optional()
          .describe('Start time. ISO 8601 with a required timezone (Z or +09:00 form), e.g. 2026-09-01T00:00:00Z / 2026-09-01T09:00:00+09:00'),
        end_time: z.string().optional()
          .describe('End time. ISO 8601 with a required timezone (Z or +09:00 form), same format as start_time'),
        duration: z.number().int().min(1).optional()
          .describe('Number of minutes back from now. Cannot be combined with start_time / end_time'),
        event_categories: EVENT_CATEGORIES_INPUT,
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: RDS_DESCRIBE_DB_CLUSTERS,
      title: 'List DB clusters',
      description: 'Returns the configuration and state of Aurora / Multi-AZ DB clusters. Narrow to one with db_cluster_identifier',
      inputSchema: z.object({
        db_cluster_identifier: z.string().optional().describe('Cluster identifier or ARN. If omitted, all clusters'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: RDS_DESCRIBE_DB_INSTANCES,
      title: 'List DB instances',
      description: 'Returns the configuration and state of DB instances (DBInstanceStatus, endpoint, etc.). Narrow to one with db_instance_identifier',
      inputSchema: z.object({
        db_instance_identifier: z.string().optional().describe('Instance identifier or ARN. If omitted, all instances'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

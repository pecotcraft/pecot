// EventBridge Scheduler 系のツール定義。

import { z } from 'zod'

import { SCHEDULER_GET_SCHEDULE, SCHEDULER_LIST_SCHEDULES } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ToolOptions,
} from './_shared.js'

/**
一覧の絞り込みに使うスケジュールグループ名。未指定なら全グループが対象で、get-schedule の default とは意味が違う。
*/
const LIST_GROUP_NAME_INPUT = z.string().optional()
  .describe('Schedule group name to filter by. If omitted, lists all groups')

/**
単体取得の対象になるスケジュールグループ名。
*/
const GET_GROUP_NAME_INPUT = z.string().optional()
  .describe('Schedule group name. If omitted, the default group is used')

export function schedulerTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: SCHEDULER_LIST_SCHEDULES,
      title: 'List schedules',
      description: 'Lists EventBridge Scheduler schedules. Get details (expression, target) with aws_scheduler_get_schedule',
      inputSchema: z.object({
        group_name: LIST_GROUP_NAME_INPUT,
        name_prefix: z.string().optional().describe('Schedule name prefix'),
        state: z.enum(['ENABLED', 'DISABLED']).optional().describe('State to filter by'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: SCHEDULER_GET_SCHEDULE,
      title: 'Get schedule details',
      description: 'Returns the schedule expression (ScheduleExpression), timezone, target, and state of one schedule',
      inputSchema: z.object({
        name: z.string().describe('Schedule name'),
        group_name: GET_GROUP_NAME_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

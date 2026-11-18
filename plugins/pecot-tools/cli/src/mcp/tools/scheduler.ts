// EventBridge Scheduler 系のツール定義。

import { z } from 'zod'

import { SCHEDULER_GET_SCHEDULE, SCHEDULER_LIST_SCHEDULES } from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  awsObject,
  awsObjects,
  awsTimestamp,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ResponseShape,
  type ToolOptions,
} from './_shared.js'

function schedule(description: string): string {
  return `${description} (EventBridge Scheduler GetSchedule response)`
}

/**
GetSchedule の応答の最上位のキー。
*/
const GET_SCHEDULE_RESPONSE: ResponseShape = {
  ActionAfterCompletion: z.string().describe(schedule('Action after the schedule completes (NONE or DELETE)')),
  Arn: z.string().describe(schedule('Schedule ARN')),
  CreationDate: awsTimestamp(schedule('Creation time')),
  Description: z.string().describe(schedule('Schedule description')),
  EndDate: awsTimestamp(schedule('Time before which the schedule can invoke its target')),
  FlexibleTimeWindow: awsObject(schedule('FlexibleTimeWindow object')),
  GroupName: z.string().describe(schedule('Schedule group name')),
  KmsKeyArn: z.string().describe(schedule('Customer managed KMS key ARN')),
  LastModificationDate: awsTimestamp(schedule('Last modification time')),
  Name: z.string().describe(schedule('Schedule name')),
  ScheduleExpression: z.string().describe(schedule('Schedule expression (at, rate, or cron)')),
  ScheduleExpressionTimezone: z.string().describe(schedule('Timezone of the schedule expression')),
  StartDate: awsTimestamp(schedule('Time after which the schedule can invoke its target')),
  State: z.string().describe(schedule('ENABLED or DISABLED')),
  Target: awsObject(schedule('Target object')),
}

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
      responseShape: {
        Schedules: awsObjects('ScheduleSummary objects of the EventBridge Scheduler ListSchedules response'),
      },
      responseRequired: ['Schedules'],
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
      responseShape: GET_SCHEDULE_RESPONSE,
    }, options),
  ]
}

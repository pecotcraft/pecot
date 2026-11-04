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
一覧の絞り込みに使うスケジュールグループ名。

`list-schedules` の `--group-name` は未指定なら全グループが対象で、`get-schedule` の
既定（default グループ）とは意味が違うので定数を分ける。
*/
const LIST_GROUP_NAME_INPUT = z.string().optional()
  .describe('絞り込むスケジュールグループ名。未指定なら全グループを一覧する')

/**
単体取得の対象になるスケジュールグループ名。
*/
const GET_GROUP_NAME_INPUT = z.string().optional()
  .describe('スケジュールグループ名。未指定なら default グループを見る')

export function schedulerTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: SCHEDULER_LIST_SCHEDULES,
      title: 'スケジュールの一覧',
      description: 'EventBridge Scheduler のスケジュールを一覧する。詳細（実行式・ターゲット）は aws_scheduler_get_schedule で取る',
      inputSchema: z.object({
        group_name: LIST_GROUP_NAME_INPUT,
        name_prefix: z.string().optional().describe('スケジュール名の前方一致'),
        state: z.enum(['ENABLED', 'DISABLED']).optional().describe('絞り込む状態'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: SCHEDULER_GET_SCHEDULE,
      title: 'スケジュールの詳細取得',
      description: 'スケジュール 1 件の実行式（ScheduleExpression）・タイムゾーン・ターゲット・状態を返す',
      inputSchema: z.object({
        name: z.string().describe('スケジュール名'),
        group_name: GET_GROUP_NAME_INPUT,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

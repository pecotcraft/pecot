// CloudWatch Logs 系のツール定義。

import { z } from 'zod'

import {
  LOGS_DESCRIBE_LOG_GROUPS,
  LOGS_DESCRIBE_LOG_STREAMS,
  LOGS_FILTER_LOG_EVENTS,
  LOGS_GET_LOG_EVENTS,
} from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  LIMIT_NEXT_TOKEN_PAGINATION_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ToolOptions,
} from './_shared.js'

/**
並び順の指定。既定は昇順（false）。
*/
const DESCENDING_INPUT = z.boolean().default(false).describe('true なら降順に並べる')

/**
検索対象のログストリーム名の一覧。
*/
const LOG_STREAM_NAMES_INPUT = z.array(z.string()).optional()
  .describe('検索対象のログストリーム名。log_stream_name_prefix とは併用できない')

/**
期間の絞り込み。epoch ミリ秒で、両ツールとも同じ意味を持つ。
*/
const TIME_RANGE_SHAPE = {
  start_time: z.number().int().optional().describe('取得開始時刻（UNIX epoch ミリ秒）'),
  end_time: z.number().int().optional().describe('取得終了時刻（UNIX epoch ミリ秒）'),
}

export function logsTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: LOGS_DESCRIBE_LOG_GROUPS,
      title: 'ロググループの一覧',
      description: 'CloudWatch Logs のロググループを一覧する。log_group_name_prefix で前方一致に絞れる',
      inputSchema: z.object({
        log_group_name_prefix: z.string().optional().describe('ロググループ名の前方一致'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: LOGS_DESCRIBE_LOG_STREAMS,
      title: 'ログストリームの一覧',
      description: 'ロググループ内のログストリームを一覧する。最新のストリームを探すには order_by に LastEventTime を指定して descending を true にする',
      inputSchema: z.object({
        log_group_name: z.string().describe('対象のロググループ名'),
        log_stream_name_prefix: z.string().optional().describe('ログストリーム名の前方一致'),
        order_by: z.enum(['LogStreamName', 'LastEventTime']).optional().describe('並び替えの基準'),
        descending: DESCENDING_INPUT,
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: LOGS_GET_LOG_EVENTS,
      title: 'ログイベントの取得',
      description: 'ログストリーム 1 本のイベントを取得する。続きは応答の nextForwardToken を next_token に渡す',
      inputSchema: z.object({
        log_group_name: z.string().describe('対象のロググループ名'),
        log_stream_name: z.string().describe('対象のログストリーム名'),
        ...TIME_RANGE_SHAPE,
        ...LIMIT_NEXT_TOKEN_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: LOGS_FILTER_LOG_EVENTS,
      title: 'ログイベントの検索',
      description: 'ロググループ横断でログイベントを検索する。log_stream_names と log_stream_name_prefix は同時に指定できない',
      inputSchema: z.object({
        log_group_name: z.string().describe('対象のロググループ名'),
        log_stream_names: LOG_STREAM_NAMES_INPUT,
        log_stream_name_prefix: z.string().optional().describe('検索対象のログストリーム名の前方一致。log_stream_names とは併用できない'),
        filter_pattern: z.string().optional().describe('CloudWatch Logs のフィルタパターン'),
        ...TIME_RANGE_SHAPE,
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

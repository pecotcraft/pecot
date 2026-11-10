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
const DESCENDING_INPUT = z.boolean().default(false).describe('If true, sorts in descending order')

/**
検索Target log stream nameの一覧。
*/
const LOG_STREAM_NAMES_INPUT = z.array(z.string()).optional()
  .describe('Log stream names to search. Cannot be combined with log_stream_name_prefix')

/**
期間の絞り込み。epoch ミリ秒で、両ツールとも同じ意味を持つ。
*/
const TIME_RANGE_SHAPE = {
  start_time: z.number().int().optional().describe('Start time (UNIX epoch milliseconds)'),
  end_time: z.number().int().optional().describe('End time (UNIX epoch milliseconds)'),
}

export function logsTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: LOGS_DESCRIBE_LOG_GROUPS,
      title: 'List log groups',
      description: 'Lists CloudWatch Logs log groups. Narrow by prefix with log_group_name_prefix',
      inputSchema: z.object({
        log_group_name_prefix: z.string().optional().describe('Log group name prefix'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: LOGS_DESCRIBE_LOG_STREAMS,
      title: 'List log streams',
      description: 'Lists log streams in a log group. To find the latest stream, set order_by to LastEventTime and descending to true',
      inputSchema: z.object({
        log_group_name: z.string().describe('Target log group name'),
        log_stream_name_prefix: z.string().optional().describe('Log stream name prefix'),
        order_by: z.enum(['LogStreamName', 'LastEventTime']).optional().describe('Sort key'),
        descending: DESCENDING_INPUT,
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: LOGS_GET_LOG_EVENTS,
      title: 'Get log events',
      description: 'Gets events of one log stream. To continue, pass nextForwardToken from the response as next_token',
      inputSchema: z.object({
        log_group_name: z.string().describe('Target log group name'),
        log_stream_name: z.string().describe('Target log stream name'),
        ...TIME_RANGE_SHAPE,
        ...LIMIT_NEXT_TOKEN_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: LOGS_FILTER_LOG_EVENTS,
      title: 'Search log events',
      description: 'Searches log events across a log group. log_stream_names and log_stream_name_prefix cannot be specified together',
      inputSchema: z.object({
        log_group_name: z.string().describe('Target log group name'),
        log_stream_names: LOG_STREAM_NAMES_INPUT,
        log_stream_name_prefix: z.string().optional().describe('Prefix of log stream names to search. Cannot be combined with log_stream_names'),
        filter_pattern: z.string().optional().describe('CloudWatch Logs filter pattern'),
        ...TIME_RANGE_SHAPE,
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

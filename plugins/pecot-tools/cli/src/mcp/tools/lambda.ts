// Lambda 系のツール定義。

import { z } from 'zod'

import {
  LAMBDA_GET_FUNCTION_CONFIGURATION,
  LAMBDA_LIST_EVENT_SOURCE_MAPPINGS,
  LAMBDA_LIST_FUNCTIONS,
} from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ToolOptions,
} from './_shared.js'

export function lambdaTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: LAMBDA_LIST_FUNCTIONS,
      title: 'List Lambda functions',
      description: 'Lists Lambda functions in the region. For many functions, split with max_items and starting_token',
      inputSchema: z.object({ ...MAX_ITEMS_PAGINATION_SHAPE, ...COMMON_INPUT_SHAPE }),
    }, options),
    allowlistedTool({
      entry: LAMBDA_GET_FUNCTION_CONFIGURATION,
      title: 'Get Lambda function configuration',
      description: 'Returns the configuration of one function (runtime, handler, environment variables, timeout, etc.)',
      inputSchema: z.object({
        function_name: z.string().describe('Function name, partial ARN, or full ARN'),
        qualifier: z.string().optional().describe('Version number or alias name. If omitted, $LATEST'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: LAMBDA_LIST_EVENT_SOURCE_MAPPINGS,
      title: 'List event source mappings',
      description: 'Lists the mappings between functions and event sources (SQS queues, DynamoDB streams, etc.). Filter by event_source_arn or function_name',
      inputSchema: z.object({
        event_source_arn: z.string().optional().describe('ARN of the event source (starts with arn:)'),
        function_name: z.string().optional().describe('Function name, partial ARN, or full ARN'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

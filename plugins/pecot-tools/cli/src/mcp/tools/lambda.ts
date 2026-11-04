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
      title: 'Lambda 関数の一覧',
      description: 'リージョン内の Lambda 関数を一覧する。件数が多い場合は max_items と starting_token で分割する',
      inputSchema: z.object({ ...MAX_ITEMS_PAGINATION_SHAPE, ...COMMON_INPUT_SHAPE }),
    }, options),
    allowlistedTool({
      entry: LAMBDA_GET_FUNCTION_CONFIGURATION,
      title: 'Lambda 関数の構成取得',
      description: '関数 1 件の構成（ランタイム・ハンドラ・環境変数・タイムアウト等）を返す',
      inputSchema: z.object({
        function_name: z.string().describe('関数名・部分 ARN・完全 ARN のいずれか'),
        qualifier: z.string().optional().describe('バージョン番号またはエイリアス名。未指定なら $LATEST'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: LAMBDA_LIST_EVENT_SOURCE_MAPPINGS,
      title: 'イベントソースマッピングの一覧',
      description: '関数とイベントソース（SQS キュー・DynamoDB ストリーム等）の対応を一覧する。event_source_arn と function_name のどちらでも絞れる',
      inputSchema: z.object({
        event_source_arn: z.string().optional().describe('イベントソースの ARN（arn: で始まる）'),
        function_name: z.string().optional().describe('関数名・部分 ARN・完全 ARN のいずれか'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

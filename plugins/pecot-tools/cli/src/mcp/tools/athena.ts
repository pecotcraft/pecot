// Athena 系のツール定義。start-query-execution は静的宣言でクエリを縛れないため、実行前拒否で参照専用以外を落とす。

import { z } from 'zod'

import {
  ATHENA_GET_QUERY_EXECUTION,
  ATHENA_GET_QUERY_RESULTS,
  ATHENA_START_QUERY_EXECUTION,
} from '../../domain/allowlist.js'
import { classifyAthenaQuery } from '../../domain/athena-query.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type PreExecutionRejection,
  type ToolOptions,
} from './_shared.js'

/**
参照専用でないクエリを not-allowed で落とす。文字列でなければ undefined を返し、必須入力の検証へ委ねる。
*/
function rejectNonReadOnlyQuery(
  arguments_: Readonly<Record<string, unknown>>,
): PreExecutionRejection | undefined {
  const query = arguments_['query_string']
  if (typeof query !== 'string') return undefined

  const classified = classifyAthenaQuery(query)
  return classified.allowed
    ? undefined
    : { category: 'not-allowed', message: classified.message }
}

/**
catalog の単独指定を invalid-input で落とす。契約は「database と併用」で、Database 無しを Athena API が受けるかは未確認。
*/
function rejectCatalogWithoutDatabase(
  arguments_: Readonly<Record<string, unknown>>,
): PreExecutionRejection | undefined {
  if ((typeof arguments_['catalog'] !== 'string') || (typeof arguments_['database'] === 'string')) return undefined

  return {
    category: 'invalid-input',
    message: 'Specify catalog together with database',
  }
}

/**
start-query-execution の実行前拒否。クエリ内容 → catalog の順に見る。
*/
function rejectStartQueryExecution(
  arguments_: Readonly<Record<string, unknown>>,
): PreExecutionRejection | undefined {
  return rejectNonReadOnlyQuery(arguments_) ?? rejectCatalogWithoutDatabase(arguments_)
}

export function athenaTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: ATHENA_START_QUERY_EXECUTION,
      title: 'Start query execution',
      description: 'Starts a read-only query (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN) and returns query_execution_id. Mutating queries and multiple statements are rejected before running. Wait for completion with aws_athena_get_query_execution, then fetch results with aws_athena_get_query_results',
      inputSchema: z.object({
        query_string: z.string().describe('Read-only query to run. Give a single statement that starts with SELECT / WITH / SHOW / DESCRIBE / EXPLAIN (no enclosing parentheses)'),
        work_group: z.string().optional().describe('Workgroup name'),
        database: z.string().optional().describe('Default database name'),
        catalog: z.string().optional().describe('Data catalog name. Specify together with database (not on its own)'),
        output_location: z.string().optional().describe('Output location for results (starts with s3://)'),
        ...COMMON_INPUT_SHAPE,
      }),
      reject: rejectStartQueryExecution,
    }, options),
    allowlistedTool({
      entry: ATHENA_GET_QUERY_EXECUTION,
      title: 'Get query execution status',
      description: 'Returns the query execution state (QUEUED / RUNNING / SUCCEEDED / FAILED / CANCELLED) and statistics',
      inputSchema: z.object({
        query_execution_id: z.string().describe('ID returned by aws_athena_start_query_execution'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: ATHENA_GET_QUERY_RESULTS,
      title: 'Get query results',
      description: 'Returns the result rows of a completed query. For many rows, split with max_items and starting_token',
      inputSchema: z.object({
        query_execution_id: z.string().describe('ID returned by aws_athena_start_query_execution'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

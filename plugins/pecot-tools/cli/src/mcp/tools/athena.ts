// Athena 系のツール定義。
//
// start-query-execution だけは許可リストの静的宣言でクエリ内容を縛れないため、
// 実行前拒否（reject）で参照専用クエリ以外を落とす。

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
参照専用でないクエリを not-allowed で落とす。

query_string が文字列でない場合は undefined を返し、必須入力の検証（invalid-input）へ委ねる。
ここで別種別を返すと「必須入力の欠落」が「許可されていない操作」に化ける。
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
catalog の単独指定を invalid-input で落とす。

契約書は catalog を「database と併用」と定めている。
組み立て自体は `--query-execution-context Catalog=…` を作れてしまう。
ただし Database を欠いた QueryExecutionContext を実 Athena API が受けるかは未確認なので、契約の範囲へ寄せる。
*/
function rejectCatalogWithoutDatabase(
  arguments_: Readonly<Record<string, unknown>>,
): PreExecutionRejection | undefined {
  if ((typeof arguments_['catalog'] !== 'string') || (typeof arguments_['database'] === 'string')) return undefined

  return {
    category: 'invalid-input',
    message: 'catalog は database と併せて指定してください',
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
      title: 'クエリの実行開始',
      description: '参照クエリ（SELECT / WITH / SHOW / DESCRIBE / EXPLAIN）の実行を開始し query_execution_id を返す。変更系と複数文は実行前に拒否する。結果は aws_athena_get_query_execution で完了を待ってから aws_athena_get_query_results で取る',
      inputSchema: z.object({
        query_string: z.string().describe('実行する参照クエリ。1 文だけを指定し、先頭は SELECT / WITH / SHOW / DESCRIBE / EXPLAIN のいずれかにする（括弧で囲まない）'),
        work_group: z.string().optional().describe('ワークグループ名'),
        database: z.string().optional().describe('既定のデータベース名'),
        catalog: z.string().optional().describe('データカタログ名。database と併せて指定する（単独指定はしない）'),
        output_location: z.string().optional().describe('結果の出力先（s3:// で始まる）'),
        ...COMMON_INPUT_SHAPE,
      }),
      reject: rejectStartQueryExecution,
    }, options),
    allowlistedTool({
      entry: ATHENA_GET_QUERY_EXECUTION,
      title: 'クエリ実行状態の取得',
      description: 'クエリ実行の状態（QUEUED / RUNNING / SUCCEEDED / FAILED / CANCELLED）と統計を返す',
      inputSchema: z.object({
        query_execution_id: z.string().describe('aws_athena_start_query_execution が返した ID'),
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
    allowlistedTool({
      entry: ATHENA_GET_QUERY_RESULTS,
      title: 'クエリ結果の取得',
      description: '完了したクエリの結果行を返す。件数が多い場合は max_items と starting_token で分割する',
      inputSchema: z.object({
        query_execution_id: z.string().describe('aws_athena_start_query_execution が返した ID'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
    }, options),
  ]
}

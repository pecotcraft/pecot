// 偽 awscli を PATH の先頭に置き、MCP 越しに全ツールの正常系・失敗系・引数の組み立てを通す統合テスト。
// PATH を stub するため it.concurrent は使わない。ensureAwscli の memo は毎ケース捨てる。

/* eslint-disable security/detect-non-literal-fs-filename -- 扱うのは mkdtemp の戻り値と fixture パスだけ */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { FailureKind } from '../../src/domain/allowlist.js'
import { ALLOWLIST } from '../../src/domain/allowlist.js'
import { resetAwscliProbe, OUTPUT_LIMIT_BYTES } from '../../src/infra/awscli.js'
import { closeMcp, connectMcp, outputSchemaIssues, type ConnectedMcp } from '../../src/mcp/tests/_client.js'
import { allTools } from '../../src/mcp/tools/index.js'
import { FAKE_AWS_FIXTURE_DIR, useFakeAws, type FakeAws } from '../_helpers/fake-aws.js'
import { isRecord } from '../_helpers/records.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { explains } from '../../tests/_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { compareStrings } from '../_helpers/compare-strings.js'

/**
偽 awscli を打ち切るまでの待ち時間。hang させる 1 件だけがここに掛かる。
*/
const SHORT_TIMEOUT_MS = 1000

/**
ツール 1 件を成功させるのに要る最小の引数。既定 fixture（<service>-<subcommand>）を読む。
*/
const MINIMAL_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  aws_sts_get_caller_identity: {},
  aws_lambda_list_functions: {},
  aws_lambda_get_function_configuration: { function_name: 'order-notifier' },
  aws_lambda_list_event_source_mappings: {},
  aws_logs_describe_log_groups: {},
  aws_logs_describe_log_streams: { log_group_name: '/aws/lambda/order-notifier' },
  aws_logs_get_log_events: {
    log_group_name: '/aws/lambda/order-notifier',
    log_stream_name: '2026/09/01/[$LATEST]0a1b',
  },
  aws_logs_filter_log_events: { log_group_name: '/aws/lambda/order-notifier' },
  aws_cloudwatch_get_metric_statistics: {
    namespace: 'AWS/SQS',
    metric_name: 'NumberOfMessagesSent',
    start_time: '2026-09-01T00:00:00Z',
    end_time: '2026-09-01T01:00:00Z',
    period: 300,
    statistics: ['Sum'],
  },
  aws_sqs_list_queues: {},
  aws_sqs_get_queue_attributes: {
    queue_url: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/order-events',
  },
  aws_athena_start_query_execution: { query_string: 'SELECT order_id FROM orders LIMIT 10' },
  aws_athena_get_query_execution: { query_execution_id: 'b1c2d3e4' },
  aws_athena_get_query_results: { query_execution_id: 'b1c2d3e4' },
  aws_s3_ls: {},
  aws_rds_describe_events: {},
  aws_rds_describe_db_clusters: {},
  aws_rds_describe_db_instances: {},
  aws_scheduler_list_schedules: {},
  aws_scheduler_get_schedule: { name: 'order-digest' },
  aws_ecr_describe_images: { repository_name: 'order-api' },
  aws_ec2_describe_instances: {},
}

/**
MINIMAL_ARGUMENTS と対になる、awscli へ渡るはずの引数配列。

service / subcommand だけを見ると、`function_name` と `qualifier` の写像逆転のような
取り違えを見逃す。実 awscli でも構文としては受理されるので、252 にならない。
契約の「対応 awscli 引数」列をここへ写し、呼び出し 1 回ぶんを丸ごと比べる。
*/
const EXPECTED_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  aws_sts_get_caller_identity: ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'],
  aws_lambda_list_functions: ['lambda', 'list-functions', '--output', 'json', '--no-cli-pager'],
  aws_lambda_get_function_configuration: [
    'lambda', 'get-function-configuration',
    '--function-name', 'order-notifier',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_lambda_list_event_source_mappings: [
    'lambda', 'list-event-source-mappings',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_logs_describe_log_groups: ['logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager'],
  aws_logs_describe_log_streams: [
    'logs', 'describe-log-streams',
    '--log-group-name', '/aws/lambda/order-notifier',
    '--no-descending',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_logs_get_log_events: [
    'logs', 'get-log-events',
    '--log-group-name', '/aws/lambda/order-notifier',
    '--log-stream-name', '2026/09/01/[$LATEST]0a1b',
    '--no-start-from-head',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_logs_filter_log_events: [
    'logs', 'filter-log-events',
    '--log-group-name', '/aws/lambda/order-notifier',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_cloudwatch_get_metric_statistics: [
    'cloudwatch', 'get-metric-statistics',
    '--namespace', 'AWS/SQS',
    '--metric-name', 'NumberOfMessagesSent',
    '--start-time', '2026-09-01T00:00:00Z',
    '--end-time', '2026-09-01T01:00:00Z',
    '--period', '300',
    '--statistics', 'Sum',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_sqs_list_queues: ['sqs', 'list-queues', '--output', 'json', '--no-cli-pager'],
  aws_sqs_get_queue_attributes: [
    'sqs', 'get-queue-attributes',
    '--queue-url', 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/order-events',
    '--attribute-names', 'All',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_athena_start_query_execution: [
    'athena', 'start-query-execution',
    '--query-string', 'SELECT order_id FROM orders LIMIT 10',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_athena_get_query_execution: [
    'athena', 'get-query-execution',
    '--query-execution-id', 'b1c2d3e4',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_athena_get_query_results: [
    'athena', 'get-query-results',
    '--query-execution-id', 'b1c2d3e4',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_s3_ls: ['s3', 'ls', '--no-cli-pager'],
  aws_rds_describe_events: ['rds', 'describe-events', '--output', 'json', '--no-cli-pager'],
  aws_rds_describe_db_clusters: ['rds', 'describe-db-clusters', '--output', 'json', '--no-cli-pager'],
  aws_rds_describe_db_instances: ['rds', 'describe-db-instances', '--output', 'json', '--no-cli-pager'],
  aws_scheduler_list_schedules: ['scheduler', 'list-schedules', '--output', 'json', '--no-cli-pager'],
  aws_scheduler_get_schedule: [
    'scheduler', 'get-schedule',
    '--name', 'order-digest',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_ecr_describe_images: [
    'ecr', 'describe-images',
    '--repository-name', 'order-api',
    '--output', 'json', '--no-cli-pager',
  ],
  aws_ec2_describe_instances: ['ec2', 'describe-instances', '--output', 'json', '--no-cli-pager'],
}

/**
ツールごとの、既定 fixture での正常系が確かめる項目の ID。JSON 出力を持つツールは data を fixture と比べるので ID を持つ。data の項目を見ない s3 ls / s3 cp は空。
*/
const HAPPY_PATH_IDS: Readonly<Record<string, readonly string[]>> = {
  aws_sts_get_caller_identity: ['PT-AWS-STS-GET-CALLER-IDENTITY-01'],
  aws_lambda_list_functions: ['PT-AWS-LAMBDA-LIST-FUNCTIONS-01'],
  aws_lambda_get_function_configuration: ['PT-AWS-LAMBDA-GET-FUNCTION-CONFIGURATION-01'],
  aws_lambda_list_event_source_mappings: ['PT-AWS-LAMBDA-LIST-EVENT-SOURCE-MAPPINGS-01'],
  aws_logs_describe_log_groups: ['PT-AWS-LOGS-DESCRIBE-LOG-GROUPS-01'],
  aws_logs_describe_log_streams: ['PT-AWS-LOGS-DESCRIBE-LOG-STREAMS-01'],
  aws_logs_get_log_events: ['PT-AWS-LOGS-GET-LOG-EVENTS-01'],
  aws_logs_filter_log_events: ['PT-AWS-LOGS-FILTER-LOG-EVENTS-01'],
  aws_cloudwatch_get_metric_statistics: ['PT-AWS-CLOUDWATCH-GET-METRIC-STATISTICS-01'],
  aws_sqs_list_queues: ['PT-AWS-SQS-LIST-QUEUES-01'],
  aws_sqs_get_queue_attributes: ['PT-AWS-SQS-GET-QUEUE-ATTRIBUTES-01'],
  aws_athena_start_query_execution: ['PT-AWS-ATHENA-START-QUERY-EXECUTION-01'],
  aws_athena_get_query_execution: ['PT-AWS-ATHENA-GET-QUERY-EXECUTION-01'],
  aws_athena_get_query_results: ['PT-AWS-ATHENA-GET-QUERY-RESULTS-01'],
  aws_s3_ls: [],
  aws_rds_describe_events: ['PT-AWS-RDS-DESCRIBE-EVENTS-01'],
  aws_rds_describe_db_clusters: ['PT-AWS-RDS-DESCRIBE-DB-CLUSTERS-01'],
  aws_rds_describe_db_instances: ['PT-AWS-RDS-DESCRIBE-DB-INSTANCES-01'],
  aws_scheduler_list_schedules: ['PT-AWS-SCHEDULER-LIST-SCHEDULES-01'],
  aws_scheduler_get_schedule: ['PT-AWS-SCHEDULER-GET-SCHEDULE-01'],
  aws_ecr_describe_images: ['PT-AWS-ECR-DESCRIBE-IMAGES-01'],
  aws_ec2_describe_instances: ['PT-AWS-EC2-DESCRIBE-INSTANCES-01'],
}

/**
ツール名とその許可リストエントリの service / subcommand / JSON 出力の有無。
*/
const TOOL_COMMANDS: readonly {
  readonly name: string
  readonly service: string
  readonly subcommand: string
  readonly jsonOutput: boolean
}[] = ALLOWLIST.map(entry => ({
  name: entry.toolName,
  service: entry.service,
  subcommand: entry.subcommand,
  jsonOutput: entry.jsonOutput,
}))

/**
NextToken を nextToken へ転記するツール（許可リストで pagination が max-items のもの）と項目 ID。
*/
const PAGINATED_ROWS: readonly { readonly name: string, readonly id: string, readonly fixture?: string }[] = [
  { name: 'aws_athena_get_query_results', id: 'PT-AWS-ATHENA-GET-QUERY-RESULTS-02' },
  { name: 'aws_ec2_describe_instances', id: 'PT-AWS-EC2-DESCRIBE-INSTANCES-03' },
  { name: 'aws_ecr_describe_images', id: 'PT-AWS-ECR-DESCRIBE-IMAGES-04' },
  { name: 'aws_lambda_list_event_source_mappings', id: 'PT-AWS-LAMBDA-LIST-EVENT-SOURCE-MAPPINGS-02' },
  { name: 'aws_lambda_list_functions', id: 'PT-AWS-LAMBDA-LIST-FUNCTIONS-02' },
  { name: 'aws_logs_describe_log_groups', id: 'PT-AWS-LOGS-DESCRIBE-LOG-GROUPS-02' },
  { name: 'aws_logs_describe_log_streams', id: 'PT-AWS-LOGS-DESCRIBE-LOG-STREAMS-03' },
  { name: 'aws_logs_filter_log_events', id: 'PT-AWS-LOGS-FILTER-LOG-EVENTS-03' },
  { name: 'aws_rds_describe_db_clusters', id: 'PT-AWS-RDS-DESCRIBE-DB-CLUSTERS-02' },
  { name: 'aws_rds_describe_db_instances', id: 'PT-AWS-RDS-DESCRIBE-DB-INSTANCES-02' },
  { name: 'aws_rds_describe_events', id: 'PT-AWS-RDS-DESCRIBE-EVENTS-04' },
  { name: 'aws_scheduler_list_schedules', id: 'PT-AWS-SCHEDULER-LIST-SCHEDULES-02', fixture: 'paginated-schedules' },
  { name: 'aws_sqs_list_queues', id: 'PT-AWS-SQS-LIST-QUEUES-02' },
]

const fakeAws = useFakeAws()
const mcp: { connected: ConnectedMcp | undefined } = { connected: undefined }
/**
応答上限を超える出力を返す fixture の置き場。
*/
const largeOutputDirectory = useTemporaryDirectory('pecot-tools-large-output-', { hook: 'all' })

/**
空の出力を返して exit 0 で終わる fixture の置き場。
*/
const emptyOutputDirectory = useTemporaryDirectory('pecot-tools-empty-output-', { hook: 'all' })

beforeAll(() => {
  writeFileSync(
    largeOutputDirectory('large-output.stdout'),
    `{"Functions":["${'x'.repeat(OUTPUT_LIMIT_BYTES)}"]}`,
  )
  writeFileSync(emptyOutputDirectory('empty-output.stdout'), '')
})

afterAll(() => {
  rmSync(largeOutputDirectory(), { recursive: true, force: true })
  rmSync(emptyOutputDirectory(), { recursive: true, force: true })
})

/**
structuredContent が outputSchema に合わない理由。SDK は失敗の結果を検証しないので、失敗もここで見る。
*/
async function outputIssuesOf(name: string, structured: Readonly<Record<string, unknown>>): Promise<readonly string[]> {
  const tool = allTools().find(item => item.name === name)
  if (tool === undefined) throw new Error(`${name} が公開されていません`)
  return outputSchemaIssues(tool, structured)
}

beforeEach(async () => {
  resetAwscliProbe()
  mcp.connected = await connectMcp(allTools({ timeoutMs: SHORT_TIMEOUT_MS }))
})

afterEach(async () => {
  if (mcp.connected !== undefined) await closeMcp(mcp.connected)
  mcp.connected = undefined
})

/**
偽 awscli の差し込み条件を張り替える。MCP の接続は保ったまま次の呼び出しへ進む。
*/
function reinstall(options: Parameters<typeof fakeAws.reinstall>[0] = {}): void {
  resetAwscliProbe()
  fakeAws.reinstall(options)
}

function client(): ConnectedMcp['client'] {
  if (mcp.connected === undefined) throw new Error('サーバへ接続できていません')
  return mcp.connected.client
}

/**
`--version` の確認呼び出しを除いた awscli 呼び出し。
*/
function commandCalls(instance: Readonly<FakeAws>): readonly (readonly string[])[] {
  return instance.callLog().filter(call => call[0] !== '--version')
}

/**
tools/call の structuredContent を Record として取り出す。
*/
async function call(
  name: string,
  arguments_: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly isError: unknown, readonly structured: Record<string, unknown> }> {
  const result = await client().callTool({ name, arguments: { ...arguments_ } })
  const structured = result.structuredContent
  if (!isRecord(structured)) throw new Error(`${name} の structuredContent がありません`)
  return { isError: result.isError, structured }
}

/**
既定 fixture（<service>-<subcommand>.stdout）の JSON。JSON 出力を持つツールだけが読む。
*/
function fixtureJson(command: Readonly<{ service: string, subcommand: string }>): Record<string, unknown> {
  const file = path.join(FAKE_AWS_FIXTURE_DIR, `${command.service}-${command.subcommand}.stdout`)
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`${file} が JSON オブジェクトではありません`)
  return parsed
}

/**
structuredContent から、pecot-tools が足す nextToken（NextToken の転記）と file（書き出し先）を除く。fixture には無い。
*/
function withoutAddedItems(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'nextToken' && key !== 'file'))
}

/**
ツール名に対応する期待 argv。表に無ければテーブルの取りこぼしとして落とす。
*/
function expectedArgumentsOf(name: string): readonly string[] {
  // eslint-disable-next-line security/detect-object-injection -- name は ALLOWLIST 由来の静的なツール名
  const expected = EXPECTED_ARGUMENTS[name]
  if (expected === undefined) throw new Error(`期待 argv の表に ${name} がありません`)
  return expected
}

/**
ツール名に対応する正常系の項目 ID。表に無ければ取りこぼしとして落とす。
*/
function happyPathIdsOf(name: string): readonly string[] {
  // eslint-disable-next-line security/detect-object-injection -- name は ALLOWLIST 由来の静的なツール名
  const ids = HAPPY_PATH_IDS[name]
  if (ids === undefined) throw new Error(`正常系の ID の表に ${name} がありません`)
  return ids
}

/**
引数を省いた最小呼び出しで tools/call する。
*/
async function callMinimal(name: string): Promise<Record<string, unknown>> {
  // eslint-disable-next-line security/detect-object-injection -- name は ALLOWLIST 由来の静的なツール名
  const minimal = MINIMAL_ARGUMENTS[name] ?? {}
  const result = await call(name, minimal)
  return result.structured
}

/**
表のキーを許可リストと比べる。ツール名の並びを揃えて返す。
*/
function sortedNames(names: readonly string[]): readonly string[] {
  return names.toSorted(compareStrings)
}

const ALLOWLIST_NAMES = sortedNames(ALLOWLIST.map(entry => entry.toolName))

describe('全 24 ツールの正常系', () => {
  it.for(TOOL_COMMANDS)('$name が既定 fixture で成功し、引数と structuredContent が契約どおりになる', async (command, context) => {
    await explains(`偽の awscli を使い、すべてのツールの正常系を MCP 経由で確認する統合のテストです。最小の引数で \`${command.name}\` を呼び出した場合に、エラーにならず、awscli に渡った引数と応答の内容が契約どおりであることを確認します。`)
    for (const id of happyPathIdsOf(command.name)) await verifies(context, id)
    const instance = fakeAws.install()

    const result = await call(command.name, MINIMAL_ARGUMENTS[command.name] ?? {})
    const structured = result.structured

    expect(result.isError, `${command.name}: ${JSON.stringify(structured)}`).toBeUndefined()
    expect(structured['kind']).toBeUndefined()
    for (const key of ['ok', 'exitCode', 'data', 'artifacts', 'message']) expect(structured).not.toHaveProperty(key)
    expect(commandCalls(instance), `${command.name} の引数`).toEqual([expectedArgumentsOf(command.name)])
    expect(await outputIssuesOf(command.name, structured), `${command.name} の outputSchema`).toEqual([])

    if (!command.jsonOutput) return
    expect(withoutAddedItems(structured), `${command.name} の structuredContent`).toEqual(fixtureJson(command))
  })

  it('最小引数の表が許可リストと 1:1 で対応する', async () => {
    await explains('ツールを呼び出す最小の引数の表のテストです。表のキーが許可リスト `ALLOWLIST` のツール名と過不足なく一致することを確認します。')
    expect(sortedNames(Object.keys(MINIMAL_ARGUMENTS))).toEqual(ALLOWLIST_NAMES)
  })

  it('正常系の ID の表が許可リストと 1:1 で対応する', async () => {
    await explains('正常系の項目 ID の表のテストです。表のキーが許可リスト `ALLOWLIST` のツール名と過不足なく一致することを確認します。')
    expect(sortedNames(Object.keys(HAPPY_PATH_IDS))).toEqual(ALLOWLIST_NAMES)
  })

  it('期待 argv の表が許可リストと 1:1 で対応する', async () => {
    await explains('期待する awscli の引数の表のテストです。表のキーが許可リスト `ALLOWLIST` のツール名と過不足なく一致することを確認します。')
    expect(sortedNames(Object.keys(EXPECTED_ARGUMENTS))).toEqual(ALLOWLIST_NAMES)
  })

  it('項目 ID がツール名から作る接頭辞で始まる', async () => {
    await explains('項目 ID の表のテストです。正常系とページングの表に含まれるすべての項目 ID が、ツール名を大文字にして `_` を `-` に置き換えた接頭辞で始まることを確認します。')
    const rows = [
      ...Object.entries(HAPPY_PATH_IDS).flatMap(([name, ids]) => ids.map(id => ({ name, id }))),
      ...PAGINATED_ROWS,
    ]
    for (const row of rows) {
      const prefix = `PT-${row.name.toUpperCase().replaceAll('_', '-')}-`
      expect(row.id.startsWith(prefix), `${row.id} は ${prefix} で始まる`).toBe(true)
    }
  })
})

describe('引数の組み立て', () => {
  it('aws_logs_describe_log_streams にすべての引数を渡すと、契約で対応する awscli の引数を決まった順に並べて実行する', async () => {
    await explains('`aws_logs_describe_log_streams` の引数の組み立てのテストです。ロググループ名やプレフィックス、`profile` と `region` などをすべて指定した場合に、awscli へ契約どおりの引数が決まった順に渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_logs_describe_log_streams', {
      log_group_name: '/aws/lambda/order-notifier',
      log_stream_name_prefix: '2026/09',
      order_by: 'LastEventTime',
      descending: true,
      max_items: 5,
      starting_token: 'token-1',
      profile: 'dev',
      region: 'ap-northeast-1',
    })

    expect(commandCalls(instance)).toEqual([[
      'logs', 'describe-log-streams',
      '--log-group-name', '/aws/lambda/order-notifier',
      '--log-stream-name-prefix', '2026/09',
      '--order-by', 'LastEventTime',
      '--descending',
      '--max-items', '5',
      '--starting-token', 'token-1',
      '--output', 'json', '--no-cli-pager',
      '--profile', 'dev',
      '--region', 'ap-northeast-1',
    ]])
  })

  it('descending を指定しない場合は、--no-descending を付けて実行する', async (context) => {
    await verifies(context, 'PT-AWS-LOGS-DESCRIBE-LOG-STREAMS-02')
    await explains('`aws_logs_describe_log_streams` の引数の組み立てのテストです。`descending` を指定しない場合に、awscli へ `--no-descending` が渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_logs_describe_log_streams', { log_group_name: 'g' })

    expect(commandCalls(instance)).toEqual([[
      'logs', 'describe-log-streams',
      '--log-group-name', 'g',
      '--no-descending',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('start_from_head を指定しない場合は、--no-start-from-head を付けて実行する', async (context) => {
    await verifies(context, 'PT-AWS-LOGS-GET-LOG-EVENTS-02')
    await explains('`aws_logs_get_log_events` の引数の組み立てのテストです。真偽値の `start_from_head` を指定しない場合に、awscli へ `--no-start-from-head` が渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_logs_get_log_events', {
      log_group_name: 'g',
      log_stream_name: 's',
      limit: 10,
    })

    expect(commandCalls(instance)).toEqual([[
      'logs', 'get-log-events',
      '--log-group-name', 'g',
      '--log-stream-name', 's',
      '--limit', '10',
      '--no-start-from-head',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('function_name と qualifier を渡すと、--function-name と --qualifier を付けて実行する', async (context) => {
    await verifies(context, 'PT-AWS-LAMBDA-GET-FUNCTION-CONFIGURATION-02')
    await explains('`aws_lambda_get_function_configuration` の引数の組み立てのテストです。`function_name` と `qualifier` を指定した場合に、awscli へ `--function-name` と `--qualifier` が渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_lambda_get_function_configuration', {
      function_name: 'order-notifier',
      qualifier: 'live',
    })

    expect(commandCalls(instance)).toEqual([[
      'lambda', 'get-function-configuration',
      '--function-name', 'order-notifier',
      '--qualifier', 'live',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('aws_logs_filter_log_events に文字列の一覧を渡すと、1 要素ごとに 1 つの引数として並べて実行する', async () => {
    await explains('`aws_logs_filter_log_events` の引数の組み立てのテストです。`log_stream_names` に 2 つの値を指定した場合に、awscli の引数として 1 つの値ごとに別の要素で渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_logs_filter_log_events', {
      log_group_name: 'g',
      log_stream_names: ['a', 'b'],
      filter_pattern: 'ERROR',
      start_time: 1_756_684_800_000,
      end_time: 1_756_688_400_000,
    })

    expect(commandCalls(instance)).toEqual([[
      'logs', 'filter-log-events',
      '--log-group-name', 'g',
      '--log-stream-names', 'a', 'b',
      '--filter-pattern', 'ERROR',
      '--start-time', '1756684800000',
      '--end-time', '1756688400000',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('attribute_names を指定しない場合は、既定値の All を付けて実行する', async (context) => {
    await verifies(context, 'PT-AWS-SQS-GET-QUEUE-ATTRIBUTES-02')
    await explains('`aws_sqs_get_queue_attributes` の引数の組み立てのテストです。`attribute_names` を指定しない場合に、awscli へ既定値の `All` が `--attribute-names` として渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_sqs_get_queue_attributes', {
      queue_url: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/order-events',
    })

    expect(commandCalls(instance)).toEqual([[
      'sqs', 'get-queue-attributes',
      '--queue-url', 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/order-events',
      '--attribute-names', 'All',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('Athena のクエリ開始で database・catalog・output_location を指定すると、shorthand 形式の 2 つのオプションにまとめて実行する', async () => {
    await explains('`aws_athena_start_query_execution` の引数の組み立てのテストです。`database` などを指定した場合は、`--query-execution-context` と `--result-configuration` にまとめて渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_athena_start_query_execution', {
      query_string: 'SELECT 1',
      work_group: 'primary',
      database: 'analytics',
      catalog: 'awsdatacatalog',
      output_location: 's3://example-athena-results/',
    })

    expect(commandCalls(instance)).toEqual([[
      'athena', 'start-query-execution',
      '--query-string', 'SELECT 1',
      '--work-group', 'primary',
      '--query-execution-context', 'Database=analytics,Catalog=awsdatacatalog',
      '--result-configuration', 'OutputLocation=s3://example-athena-results/',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('Athena のクエリ開始で database などを指定しない場合は、shorthand 形式のオプションを付けずに実行する', async () => {
    await explains('`aws_athena_start_query_execution` の引数の組み立てのテストです。`query_string` だけを指定した場合は、shorthand 形式のオプションが awscli の引数に含まれないことを確認します。')
    const instance = fakeAws.install()

    await call('aws_athena_start_query_execution', { query_string: 'SELECT 1' })

    expect(commandCalls(instance)).toEqual([[
      'athena', 'start-query-execution',
      '--query-string', 'SELECT 1',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('dimensions のような配列の入力は、配列全体を JSON の 1 つの引数にして実行する', async () => {
    await explains('`aws_cloudwatch_get_metric_statistics` の引数の組み立てのテストです。`dimensions` に配列を指定した場合に、awscli へ配列全体が JSON 文字列の 1 つの引数として渡され、キー名が `Name` と `Value` に変換されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_cloudwatch_get_metric_statistics', {
      namespace: 'AWS/SQS',
      metric_name: 'NumberOfMessagesSent',
      dimensions: [{ name: 'QueueName', value: 'order-events' }],
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-01T01:00:00Z',
      period: 300,
      statistics: ['Sum', 'Average'],
      unit: 'Count',
    })

    expect(commandCalls(instance)).toEqual([[
      'cloudwatch', 'get-metric-statistics',
      '--namespace', 'AWS/SQS',
      '--metric-name', 'NumberOfMessagesSent',
      '--dimensions', '[{"Name":"QueueName","Value":"order-events"}]',
      '--start-time', '2026-09-01T00:00:00Z',
      '--end-time', '2026-09-01T01:00:00Z',
      '--period', '300',
      '--statistics', 'Sum', 'Average',
      '--unit', 'Count',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('filters のような配列の入力に配列の値が含まれる場合は、JSON の配列として載せて実行する', async () => {
    await explains('`aws_ec2_describe_instances` の引数の組み立てのテストです。`filters` の各項目が複数の値の配列を持つ場合に、awscli へ `Name` と `Values` を持つ JSON の配列として渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_ec2_describe_instances', {
      instance_ids: ['i-0a1b2c3d4e5f60718'],
      filters: [
        { name: 'instance-state-name', values: ['running', 'stopped'] },
        { name: 'tag:Name', values: ['order-api-01'] },
      ],
      max_items: 5,
    })

    expect(commandCalls(instance)).toEqual([[
      'ec2', 'describe-instances',
      '--instance-ids', 'i-0a1b2c3d4e5f60718',
      '--filters',
      '[{"Name":"instance-state-name","Values":["running","stopped"]},{"Name":"tag:Name","Values":["order-api-01"]}]',
      '--max-items', '5',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('ECR のイメージ取得で tag_status を指定すると、shorthand 形式の --filter にまとめて実行する', async (context) => {
    await verifies(context, 'PT-AWS-ECR-DESCRIBE-IMAGES-02')
    await explains('`aws_ecr_describe_images` の引数の組み立てのテストです。`tag_status` に `TAGGED` を指定した場合は、awscli へ `--filter tagStatus=TAGGED` が渡されることを確認します。')
    const instance = fakeAws.install()

    await call('aws_ecr_describe_images', {
      repository_name: 'order-api',
      registry_id: '123456789012',
      image_ids: [{ image_tag: '2026.09.01' }, { image_digest: 'sha256:0a1b' }],
      tag_status: 'TAGGED',
    })

    expect(commandCalls(instance)).toEqual([[
      'ecr', 'describe-images',
      '--repository-name', 'order-api',
      '--registry-id', '123456789012',
      '--image-ids', '[{"imageTag":"2026.09.01"},{"imageDigest":"sha256:0a1b"}]',
      '--filter', 'tagStatus=TAGGED',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('S3 の一覧では、位置引数を先に置き、--output json を付けずに実行する', async () => {
    await explains('`aws_s3_ls` の引数の組み立てのテストです。`s3_uri` を指定した場合に、awscli へ `s3 ls` の直後に S3 の URI を置いた引数が渡され、`--output json` が含まれないことを確認します。')
    const instance = fakeAws.install()

    await call('aws_s3_ls', { s3_uri: 's3://example-bucket/logs/' })

    expect(commandCalls(instance)).toEqual([
      ['s3', 'ls', 's3://example-bucket/logs/', '--no-cli-pager'],
    ])
  })
})

describe('応答の中身', () => {
  it('JSON を出力するツールの結果は、structuredContent の最上位にそのまま含める', async () => {
    await explains('`aws_athena_get_query_execution` の応答のテストです。awscli が JSON を出力した場合は、`structuredContent` の最上位に `QueryExecution` が含まれ、その内容が出力と一致することを確認します。')
    fakeAws.install()

    const structured = await callMinimal('aws_athena_get_query_execution')
    const execution = structured['QueryExecution']

    expect(isRecord(execution) ? execution['QueryExecutionId'] : undefined)
      .toBe('b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e')
  })

  it('aws_s3_ls は JSON を出力しないため、出力を 1 行ごとの配列にして lines に載せる', async (context) => {
    await verifies(context, 'PT-AWS-S3-LS-02')
    await explains('`aws_s3_ls` の応答のテストです。`s3_uri` を指定せずに実行した場合は、awscli の出力が 1 行ごとの要素を持つ `lines` として返ることを確認します。')
    const instance = fakeAws.install()
    const structured = await callMinimal('aws_s3_ls')

    expect(commandCalls(instance)).toEqual([['s3', 'ls', '--no-cli-pager']])
    expect(structured).toEqual({
      lines: ['2026-09-01 10:00:00       1024 report.json', '                           PRE logs/'],
    })
  })

  it('s3_uri を渡すと、出力を 1 行 1 要素にして lines に載せる', async (context) => {
    await verifies(context, 'PT-AWS-S3-LS-01')
    await explains('`aws_s3_ls` の応答のテストです。`s3_uri` を指定して実行した場合に、awscli の出力が 1 行を 1 要素とする `lines` として返り、`s3_uri` が awscli の引数に含まれることを確認します。')
    const instance = fakeAws.install()

    const result = await call('aws_s3_ls', { s3_uri: 's3://example-bucket/logs/' })

    expect(commandCalls(instance)).toEqual([['s3', 'ls', 's3://example-bucket/logs/', '--no-cli-pager']])
    expect(result.structured).toEqual({
      lines: ['2026-09-01 10:00:00       1024 report.json', '                           PRE logs/'],
    })
  })

  it.for(PAGINATED_ROWS)('$name の NextToken を nextToken へ転記する', async (row, context) => {
    await verifies(context, row.id)
    await explains(`ページングを持つツールの応答のテストです。awscli の出力が \`NextToken\` を含む場合は、\`${row.name}\` の \`nextToken\` が同じ値になり、\`outputSchema\` に適合することを確認します。`)
    fakeAws.install({ fixture: row.fixture ?? 'paginated' })

    const structured = await callMinimal(row.name)

    expect(structured['nextToken']).toBe('eyJuZXh0IjogMX0=')
    expect(structured).not.toHaveProperty('warnings')
    expect(await outputIssuesOf(row.name, structured)).toEqual([])
  })

  it('NextToken の表が max-items のツールと 1:1 で対応する', async () => {
    await explains('ページングのテストが使う表のテストです。表のツール名が、許可リストでページング方式を `max-items` とするツールの名前と過不足なく一致することを確認します。')
    expect(PAGINATED_ROWS.map(row => row.name).toSorted(compareStrings))
      .toEqual(
        ALLOWLIST.filter(entry => entry.pagination === 'max-items')
          .map(entry => entry.toolName)
          .toSorted(compareStrings),
      )
  })

  it('ページングを持たないツールは、出力に NextToken があっても nextToken を作らない', async () => {
    await explains('`aws_athena_get_query_execution` の応答のテストです。ページングを持たないツールで `NextToken` を含む出力を返した場合に、`structuredContent` に `nextToken` が含まれないことを確認します。')
    fakeAws.install({ fixture: 'paginated' })

    const structured = await callMinimal('aws_athena_get_query_execution')

    expect(structured).not.toHaveProperty('nextToken')
  })

  it('JSON に宣言されていない最上位のキーがある場合は、そのキーを除き、warnings にキー名を表示する', async (context) => {
    await verifies(context, 'PT-COMMON-16')
    await explains('`aws_sts_get_caller_identity` の応答のテストです。awscli の出力に `FutureField` のように宣言されていない最上位のキーが含まれる場合に、そのキーが応答から除かれ、`warnings` にキー名が含まれることを確認します。')
    fakeAws.install({ fixture: 'undeclared-key' })

    const result = await call('aws_sts_get_caller_identity')

    expect(result.isError).toBeUndefined()
    expect(result.structured).toEqual({
      UserId: 'AIDAEXAMPLEUSERID',
      Account: '123456789012',
      Arn: 'arn:aws:iam::123456789012:user/dev',
      warnings: ['Dropped undeclared top-level keys: FutureField'],
    })
    expect(await outputIssuesOf('aws_sts_get_caller_identity', result.structured)).toEqual([])
  })

  it('JSON を出力するツールの出力が空の場合は、空の lines を返し、outputSchema に適合する', async () => {
    await explains('`aws_lambda_list_functions` の応答のテストです。awscli が何も出力せず正常終了した場合は、`lines` が空の配列で返り、`outputSchema` に適合することを確認します。')
    fakeAws.install({ fixture: 'empty-output', fixtureDir: emptyOutputDirectory() })

    const result = await call('aws_lambda_list_functions')

    expect(result.isError).toBeUndefined()
    expect(result.structured).toEqual({ lines: [] })
    expect(await outputIssuesOf('aws_lambda_list_functions', result.structured)).toEqual([])
  })

  it('ファイルへの書き出しを伴わないツールの結果には、file を含めない', async () => {
    await explains('`aws_sts_get_caller_identity` の応答のテストです。ファイルへ書き出さないツールを実行した場合に、`structuredContent` に `file` が含まれないことを確認します。')
    fakeAws.install()

    const structured = await callMinimal('aws_sts_get_caller_identity')

    expect(structured).not.toHaveProperty('file')
  })
})

describe('失敗種別', () => {
  const FAILURES: readonly {
    readonly fixture: string
    readonly kind: FailureKind
  }[] = [
    { fixture: 'no-credentials', kind: 'auth-missing' },
    { fixture: 'profile-not-found', kind: 'auth-missing' },
    { fixture: 'sso-token-expired', kind: 'auth-expired' },
    { fixture: 'invalid-token', kind: 'auth-expired' },
    { fixture: 'access-denied', kind: 'permission-denied' },
    { fixture: 'resource-not-found', kind: 'resource-not-found' },
    { fixture: 'invalid-input', kind: 'invalid-input' },
  ]

  it.for(FAILURES)('fixture $fixture の失敗は、失敗の種類 $kind と判定する', async (failure, context) => {
    await verifies(context, 'PT-COMMON-09')
    await explains(`失敗の種類の判定のテストです。偽の awscli が \`${failure.fixture}\` の失敗を返した場合は、\`${failure.kind}\` と判定してエラーを返し、契約どおりの項目を含むことを確認します。`)
    fakeAws.install({ fixture: failure.fixture })

    const result = await call('aws_lambda_get_function_configuration', { function_name: 'x' })

    expect(result.isError).toBe(true)
    expect(result.structured['kind']).toBe(failure.kind)
    expect(await outputIssuesOf('aws_lambda_get_function_configuration', result.structured)).toEqual([])
    // 失敗の形は全ツールで同じなので、anyOf を持つツールの kind と detail の枝にも通す。
    expect(await outputIssuesOf('aws_scheduler_list_schedules', result.structured)).toEqual([])
    expect(result.structured['detail']).toContain(failure.kind)
    expect(result.structured).not.toHaveProperty('stderr')
    expect(result.structured).not.toHaveProperty('reason')
    const log = result.structured['log']
    expect(typeof log === 'string' && log.length > 0, `log: ${JSON.stringify(log)}`).toBe(true)
  })

  it('高レベルの s3 コマンドが終了コード 1 で失敗した場合も、標準エラー出力から失敗の種類を判定する', async () => {
    await explains('失敗の種類の判定のテストです。`aws_s3_ls` が終了コード `1` で資格情報の不足を示すメッセージを出力した場合に、`auth-missing` と判定されることを確認します。')
    fakeAws.install({ fixture: 's3-cp-no-credentials' })

    const result = await call('aws_s3_ls', { s3_uri: 's3://example-bucket/' })

    expect(result.structured).toMatchObject({ kind: 'auth-missing' })
  })

  it('awscli が導入されていない場合は、失敗の種類を awscli-missing と判定する', async (context) => {
    await verifies(context, 'PT-COMMON-07')
    await explains('失敗の種類の判定のテストです。PATH に awscli が存在しない状態でツールを呼び出した場合に、失敗の種類が `awscli-missing` になることを確認します。')
    fakeAws.withoutAws()

    const result = await call('aws_sts_get_caller_identity', {})

    expect(result.structured).toMatchObject({ kind: 'awscli-missing' })
  })
})

describe('SC-008 失敗の直後も同じ接続が次の呼び出しへ応答する', () => {
  it('未導入、認証切れ、大量出力の失敗が続いた後でも、同じ接続が成功を返す', async (context) => {
    await verifies(context, 'PT-COMMON-13')
    await explains('失敗の後の接続のテストです。awscli が存在しない場合、認証が切れた場合、出力が上限を超えた場合の順に失敗させても、同じ接続で次の呼び出しが成功し、エラーにならないことを確認します。')
    fakeAws.withoutAws()
    const missing = await call('aws_sts_get_caller_identity', {})
    expect(missing.structured['kind']).toBe('awscli-missing')

    reinstall({ fixture: 'sso-token-expired' })
    const expired = await call('aws_sts_get_caller_identity', {})
    expect(expired.structured['kind']).toBe('auth-expired')

    reinstall({ fixture: 'large-output', fixtureDir: largeOutputDirectory() })
    const truncated = await call('aws_lambda_list_functions', {})
    expect(truncated.structured).toMatchObject({ truncated: true })

    reinstall()
    const recovered = await call('aws_sts_get_caller_identity', {})
    expect(recovered.isError).toBeUndefined()
  })

  it('時間切れの失敗の後でも、同じ接続が成功を返す', async (context) => {
    await verifies(context, 'PT-COMMON-13')
    await explains('失敗の後の接続のテストです。応答しない awscli で時間切れ（`timeout`）になった後、偽の awscli を差し替えて再度呼び出した場合は、同じ接続で成功することを確認します。')
    await verifies(context, 'PT-COMMON-08')
    // hang する偽 awscli を使う it は 1 本に限る（SIGTERM 待ちの分だけ実行時間が伸びる）。
    fakeAws.install({ hang: true })
    const timedOut = await call('aws_sts_get_caller_identity', {})

    expect(timedOut.structured).toMatchObject({ kind: 'timeout' })

    reinstall()
    const recovered = await call('aws_sts_get_caller_identity', {})
    expect(recovered.isError).toBeUndefined()
  }, 30_000)
})

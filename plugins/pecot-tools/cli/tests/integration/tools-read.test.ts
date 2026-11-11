// 偽 awscli を PATH の先頭に置き、MCP 越しに 24 ツールの正常系・失敗系を通す統合テスト。
//
// 見るのは次の 5 点。
// (a) 24 件が既定 fixture で成功すること。
// (b) 組み立てられた引数配列が契約の「対応 awscli 引数」と一致すること。
// (c) 応答の data / artifacts が fixture と一致すること。
// (d) 失敗 fixture ごとの category。
// (e) SC-008（失敗の直後も同じ接続が次の呼び出しに応える）。
//
// PATH を stub するため it.concurrent は使わない。ensureAwscli の memo は毎ケース捨てる。

/* eslint-disable security/detect-non-literal-fs-filename -- 扱うのは mkdtemp の戻り値と fixture パスだけ */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { FailureCategory } from '../../src/domain/allowlist.js'
import { ALLOWLIST } from '../../src/domain/allowlist.js'
import { resetAwscliProbe, OUTPUT_LIMIT_BYTES } from '../../src/infra/awscli.js'
import { closeMcp, connectMcp, type ConnectedMcp } from '../../src/mcp/tests/_client.js'
import { allTools } from '../../src/mcp/tools/index.js'
import { FAKE_AWS_FIXTURE_DIR, useFakeAws, type FakeAws } from '../_helpers/fake-aws.js'
import { isRecord } from '../_helpers/records.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
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
  aws_s3_cp: { s3_uri: 's3://example-bucket/report.json', local_path: '/var/data/report.json' },
  aws_s3api_get_object: {
    bucket: 'example-bucket',
    key: 'report.json',
    outfile: '/var/data/report.json',
  },
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
  aws_s3_cp: [
    's3', 'cp',
    's3://example-bucket/report.json', '/var/data/report.json',
    '--no-cli-pager',
  ],
  aws_s3api_get_object: [
    's3api', 'get-object', '/var/data/report.json',
    '--bucket', 'example-bucket',
    '--key', 'report.json',
    '--output', 'json', '--no-cli-pager',
  ],
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
ツールごとの、既定 fixture での正常系が確かめる項目の ID。JSON を出さないツールは data を見ないので空。
*/
const HAPPY_PATH_IDS: Readonly<Record<string, readonly string[]>> = {
  aws_sts_get_caller_identity: ['PT-AWS-STS-GET-CALLER-IDENTITY-01'],
  aws_lambda_list_functions: ['PT-AWS-LAMBDA-LIST-FUNCTIONS-01'],
  aws_lambda_get_function_configuration: ['PT-AWS-LAMBDA-GET-FUNCTION-CONFIGURATION-01'],
  aws_lambda_list_event_source_mappings: ['PT-AWS-LAMBDA-LIST-EVENT-SOURCE-MAPPINGS-01'],
  aws_logs_describe_log_groups: ['PT-AWS-LOGS-DESCRIBE-LOG-GROUPS-01'],
  aws_logs_describe_log_streams: ['PT-AWS-LOGS-DESCRIBE-LOG-STREAMS-01', 'PT-AWS-LOGS-DESCRIBE-LOG-STREAMS-02'],
  aws_logs_get_log_events: ['PT-AWS-LOGS-GET-LOG-EVENTS-01'],
  aws_logs_filter_log_events: ['PT-AWS-LOGS-FILTER-LOG-EVENTS-01'],
  aws_cloudwatch_get_metric_statistics: ['PT-AWS-CLOUDWATCH-GET-METRIC-STATISTICS-01'],
  aws_sqs_list_queues: ['PT-AWS-SQS-LIST-QUEUES-01'],
  aws_sqs_get_queue_attributes: ['PT-AWS-SQS-GET-QUEUE-ATTRIBUTES-01'],
  aws_athena_start_query_execution: ['PT-AWS-ATHENA-START-QUERY-EXECUTION-01'],
  aws_athena_get_query_execution: ['PT-AWS-ATHENA-GET-QUERY-EXECUTION-01'],
  aws_athena_get_query_results: ['PT-AWS-ATHENA-GET-QUERY-RESULTS-01'],
  aws_s3_ls: [],
  aws_s3_cp: [],
  aws_s3api_get_object: [],
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
NextToken を data.nextToken へ転記するツール（許可リストで pagination が max-items のもの）と項目 ID。
*/
const PAGINATED_ROWS: readonly { readonly name: string, readonly id: string }[] = [
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
  { name: 'aws_scheduler_list_schedules', id: 'PT-AWS-SCHEDULER-LIST-SCHEDULES-02' },
  { name: 'aws_sqs_list_queues', id: 'PT-AWS-SQS-LIST-QUEUES-02' },
]

const fakeAws = useFakeAws()
const mcp: { connected: ConnectedMcp | undefined } = { connected: undefined }
/**
応答上限を超える出力を返す fixture の置き場。
*/
const largeOutputDirectory = useTemporaryDirectory('pecot-tools-large-output-', { hook: 'all' })

beforeAll(() => {
  writeFileSync(
    largeOutputDirectory('large-output.stdout'),
    `{"Functions":["${'x'.repeat(OUTPUT_LIMIT_BYTES)}"]}`,
  )
})

afterAll(() => {
  rmSync(largeOutputDirectory(), { recursive: true, force: true })
})

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
data から nextToken を除く。successData が NextToken から転記する 1 キーで、fixture には無い。
*/
function withoutNextToken(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'nextToken'))
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

describe('全 24 ツールの正常系', () => {
  it.for(TOOL_COMMANDS)('$name が既定 fixture で成功し、引数と data が契約どおりになる', async (command, context) => {
    for (const id of happyPathIdsOf(command.name)) await verifies(context, id)
    const instance = fakeAws.install()

    const structured = await callMinimal(command.name)

    expect(structured['ok'], `${command.name}: ${JSON.stringify(structured)}`).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(structured['category']).toBeUndefined()
    expect(commandCalls(instance), `${command.name} の引数`).toEqual([expectedArgumentsOf(command.name)])

    if (!command.jsonOutput) return
    const data = structured['data']
    if (!isRecord(data)) throw new Error(`${command.name} の data が Record ではありません`)
    expect(withoutNextToken(data), `${command.name} の data`).toEqual(fixtureJson(command))
  })

  it('最小引数の表が許可リストと 1:1 で対応する', () => {
    expect(Object.keys(MINIMAL_ARGUMENTS).toSorted(compareStrings))
      .toEqual(ALLOWLIST.map(entry => entry.toolName).toSorted(compareStrings))
  })

  it('正常系の ID の表が許可リストと 1:1 で対応する', () => {
    expect(Object.keys(HAPPY_PATH_IDS).toSorted(compareStrings))
      .toEqual(ALLOWLIST.map(entry => entry.toolName).toSorted(compareStrings))
  })

  it('期待 argv の表が許可リストと 1:1 で対応する', () => {
    expect(Object.keys(EXPECTED_ARGUMENTS).toSorted(compareStrings))
      .toEqual(ALLOWLIST.map(entry => entry.toolName).toSorted(compareStrings))
  })
})

describe('引数の組み立て', () => {
  it('aws_logs_describe_log_streams が契約の対応 awscli 引数を並べる', async () => {
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

  it('boolean の既定値は --no-<flag> として現れる', async (context) => {
    await verifies(context, 'PT-AWS-LOGS-GET-LOG-EVENTS-02')
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

  it('string-list は 1 要素 1 トークンで並ぶ', async () => {
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

  it('attribute_names は未指定なら既定の All が載る', async (context) => {
    await verifies(context, 'PT-AWS-SQS-GET-QUEUE-ATTRIBUTES-02')
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

  it('athena の database / catalog / output_location は shorthand へ合成される', async () => {
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

  it('athena の shorthand は材料が無ければフラグごと省かれる', async () => {
    const instance = fakeAws.install()

    await call('aws_athena_start_query_execution', { query_string: 'SELECT 1' })

    expect(commandCalls(instance)).toEqual([[
      'athena', 'start-query-execution',
      '--query-string', 'SELECT 1',
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('shorthand-list は配列全体を JSON の 1 トークンにする', async () => {
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

  it('shorthand-list の list 項目は JSON の配列として載る', async () => {
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

  it('ecr の tag_status は shorthand の --filter へ合成される', async (context) => {
    await verifies(context, 'PT-AWS-ECR-DESCRIBE-IMAGES-02')
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

  it('s3 系は位置引数を先に置き --output json を付けない', async () => {
    const instance = fakeAws.install()

    await call('aws_s3_cp', {
      s3_uri: 's3://example-bucket/report.json',
      local_path: '/var/data/report.json',
    })
    await call('aws_s3_ls', { s3_uri: 's3://example-bucket/logs/' })

    expect(commandCalls(instance)).toEqual([
      ['s3', 'cp', 's3://example-bucket/report.json', '/var/data/report.json', '--no-cli-pager'],
      ['s3', 'ls', 's3://example-bucket/logs/', '--no-cli-pager'],
    ])
  })

  it('aws_s3api_get_object は outfile を位置引数、その他をフラグにする', async () => {
    const instance = fakeAws.install()

    await call('aws_s3api_get_object', {
      bucket: 'example-bucket',
      key: 'report.json',
      outfile: '/var/data/report.json',
      version_id: '3sL4kqtJ',
      range: 'bytes=0-1023',
    })

    expect(commandCalls(instance)).toEqual([[
      's3api', 'get-object', '/var/data/report.json',
      '--bucket', 'example-bucket',
      '--key', 'report.json',
      '--version-id', '3sL4kqtJ',
      '--range', 'bytes=0-1023',
      '--output', 'json',
      '--no-cli-pager',
    ]])
  })
})

describe('応答の中身', () => {
  it('JSON 出力はそのまま data に載る', async () => {
    fakeAws.install()

    const structured = await callMinimal('aws_athena_get_query_execution')
    const data = structured['data']
    const execution = isRecord(data) ? data['QueryExecution'] : undefined

    expect(isRecord(execution) ? execution['QueryExecutionId'] : undefined)
      .toBe('b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e')
  })

  it('aws_s3_ls は JSON 出力を持たないので data.lines になる', async (context) => {
    await verifies(context, 'PT-AWS-S3-LS-02')
    fakeAws.install()

    const structured = await callMinimal('aws_s3_ls')

    expect(structured['data']).toEqual({
      lines: ['2026-09-01 10:00:00       1024 report.json', '                           PRE logs/'],
    })
  })

  it('s3_uri を渡すと、出力を 1 行 1 要素にして data.lines に載せる', async (context) => {
    await verifies(context, 'PT-AWS-S3-LS-01')
    fakeAws.install()

    const result = await call('aws_s3_ls', { s3_uri: 's3://example-bucket/logs/' })

    expect(result.structured['data']).toEqual({
      lines: ['2026-09-01 10:00:00       1024 report.json', '                           PRE logs/'],
    })
  })

  it.for(PAGINATED_ROWS)('$name の NextToken を data.nextToken へ転記する', async (row, context) => {
    await verifies(context, row.id)
    fakeAws.install({ fixture: 'paginated' })

    const structured = await callMinimal(row.name)
    const data = structured['data']

    expect(isRecord(data) ? data['nextToken'] : undefined).toBe('eyJuZXh0IjogMX0=')
  })

  it('NextToken の表が max-items のツールと 1:1 で対応する', () => {
    expect(PAGINATED_ROWS.map(row => row.name).toSorted(compareStrings))
      .toEqual(
        ALLOWLIST.filter(entry => entry.pagination === 'max-items')
          .map(entry => entry.toolName)
          .toSorted(compareStrings),
      )
  })

  it('ページングを持たないツールは nextToken を作らない', async () => {
    fakeAws.install({ fixture: 'paginated' })

    const structured = await callMinimal('aws_athena_get_query_execution')

    expect(isRecord(structured['data']) && 'nextToken' in structured['data']).toBe(false)
  })

  it('書き出し先を artifacts に載せる', async (context) => {
    await verifies(context, 'PT-AWS-S3-CP-01')
    await verifies(context, 'PT-AWS-S3API-GET-OBJECT-01')
    fakeAws.install()

    const copied = await callMinimal('aws_s3_cp')
    const fetched = await callMinimal('aws_s3api_get_object')

    expect(copied['artifacts']).toEqual(['/var/data/report.json'])
    expect(fetched['artifacts']).toEqual(['/var/data/report.json'])
  })

  it('書き出しを伴わないツールの artifacts は空', async () => {
    fakeAws.install()

    const structured = await callMinimal('aws_sts_get_caller_identity')

    expect(structured['artifacts']).toEqual([])
  })
})

describe('失敗種別', () => {
  const FAILURES: readonly {
    readonly fixture: string
    readonly category: FailureCategory
    readonly exitCode: number
  }[] = [
    { fixture: 'no-credentials', category: 'auth-missing', exitCode: 253 },
    { fixture: 'profile-not-found', category: 'auth-missing', exitCode: 255 },
    { fixture: 'sso-token-expired', category: 'auth-expired', exitCode: 255 },
    { fixture: 'invalid-token', category: 'auth-expired', exitCode: 254 },
    { fixture: 'access-denied', category: 'permission-denied', exitCode: 254 },
    { fixture: 'resource-not-found', category: 'resource-not-found', exitCode: 254 },
    { fixture: 'invalid-input', category: 'invalid-input', exitCode: 252 },
  ]

  it.for(FAILURES)('fixture $fixture を $category にする', async (failure, context) => {
    await verifies(context, 'PT-COMMON-09')
    fakeAws.install({ fixture: failure.fixture })

    const result = await call('aws_lambda_get_function_configuration', { function_name: 'x' })

    expect(result.isError).toBe(true)
    expect(result.structured).toMatchObject({
      ok: false,
      exitCode: failure.exitCode,
      category: failure.category,
    })
    expect(result.structured['message']).toContain(failure.category)
  })

  it('高レベル s3 コマンドの exit 1 も stderr から種別を決める', async () => {
    fakeAws.install({ fixture: 's3-cp-no-credentials' })

    const result = await call('aws_s3_cp', {
      s3_uri: 's3://example-bucket/report.json',
      local_path: '/var/data/report.json',
    })

    expect(result.structured).toMatchObject({ ok: false, exitCode: 1, category: 'auth-missing' })
  })

  it('awscli 未導入は awscli-missing にする', async (context) => {
    await verifies(context, 'PT-COMMON-07')
    fakeAws.withoutAws()

    const result = await call('aws_sts_get_caller_identity', {})

    expect(result.structured).toMatchObject({ ok: false, exitCode: 127, category: 'awscli-missing' })
  })
})

describe('SC-008 失敗の直後も同じ接続が次の呼び出しへ応答する', () => {
  it('未導入 → 認証切れ → 大量出力 の後にも成功を返す', async (context) => {
    await verifies(context, 'PT-COMMON-13')
    fakeAws.withoutAws()
    const missing = await call('aws_sts_get_caller_identity', {})
    expect(missing.structured['category']).toBe('awscli-missing')

    reinstall({ fixture: 'sso-token-expired' })
    const expired = await call('aws_sts_get_caller_identity', {})
    expect(expired.structured['category']).toBe('auth-expired')

    reinstall({ fixture: 'large-output', fixtureDir: largeOutputDirectory() })
    const truncated = await call('aws_lambda_list_functions', {})
    expect(truncated.structured['data']).toMatchObject({ truncated: true })

    reinstall()
    const recovered = await call('aws_sts_get_caller_identity', {})
    expect(recovered.structured['ok']).toBe(true)
  })

  it('時間切れの後にも成功を返す', async (context) => {
    await verifies(context, 'PT-COMMON-13')
    await verifies(context, 'PT-COMMON-08')
    // hang する偽 awscli を使う it は 1 本に限る（SIGTERM 待ちの分だけ実行時間が伸びる）。
    fakeAws.install({ hang: true })
    const timedOut = await call('aws_sts_get_caller_identity', {})

    expect(timedOut.structured).toMatchObject({ exitCode: 124, category: 'timeout' })

    reinstall()
    const recovered = await call('aws_sts_get_caller_identity', {})
    expect(recovered.structured['ok']).toBe(true)
  }, 30_000)
})

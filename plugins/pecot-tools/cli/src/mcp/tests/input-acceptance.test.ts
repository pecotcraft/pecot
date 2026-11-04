// 全 26 ツールの入力の受理・拒否を、SDK の検証層を通して固定する特性テスト。
//
// 本番の createMcpServer に、実ツール定義の handler だけを spy へ差し替えて渡す。awscli を
// 起こさずに inputSchema の検証・未知キーの除去・既定値の適用を全ツールで観測できる。
// SDK の版を替えても同じ表が通ることで、入力の受理・拒否が変わっていないことを示す。
//
// 拒否は 2 種類に分けて見る。スキーマ拒否は spy に届かず、未知ツールも spy に届かない。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { toCallToolResult } from '../result.js'
import { allTools } from '../tools/index.js'
import {
  classifyCall,
  closeMcp,
  connectMcp,
  connectSpied,
  negotiatedVersionOf,
  PROTOCOL_ERAS,
  SPY_RESULT,
  type ProtocolEra,
  type SpiedMcp,
} from './_client.js'

type Arguments = Readonly<Record<string, unknown>>

interface ToolCase {
  readonly name: string
  /**
  必須だけを満たす最小の入力。
  */
  readonly minimal: Arguments
  /**
  最小の入力に対して spy が受け取るはずの値 (既定値が入る)。省略時は minimal と同じ。
  */
  readonly minimalReceived?: Arguments
  /**
  全パラメータを非既定値で指定した入力。spy にそのまま届く。
  */
  readonly full: Arguments
  /**
  欠落させると拒否される必須パラメータ。
  */
  readonly required: readonly string[]
  /**
  最小の入力へ重ねると拒否される上書き (型不一致・enum 外・範囲外)。
  */
  readonly invalid: Readonly<Record<string, Arguments>>
}

const COMMON_FULL: Arguments = { profile: 'dev-profile', region: 'ap-northeast-1' }
const PAGING_FULL: Arguments = { max_items: 10, starting_token: 'token-1' }
const ISO_START = '2026-09-01T00:00:00Z'
const ISO_END = '2026-09-02T00:00:00Z'

const TOOL_CASES: readonly ToolCase[] = [
  {
    name: 'aws_sso_login',
    minimal: {},
    full: { profile: 'dev-profile' },
    required: [],
    invalid: { 'profile が数値': { profile: 1 } },
  },
  {
    name: 'aws_sso_login_status',
    minimal: {},
    full: { profile: 'dev-profile' },
    required: [],
    invalid: { 'profile が数値': { profile: 1 } },
  },
  {
    name: 'aws_sts_get_caller_identity',
    minimal: {},
    full: { ...COMMON_FULL },
    required: [],
    invalid: { 'region が数値': { region: 1 } },
  },
  {
    name: 'aws_lambda_list_functions',
    minimal: {},
    full: { ...PAGING_FULL, ...COMMON_FULL },
    required: [],
    invalid: {
      'max_items が文字列': { max_items: '10' },
      'max_items が 0': { max_items: 0 },
      'max_items が小数': { max_items: 1.5 },
    },
  },
  {
    name: 'aws_lambda_get_function_configuration',
    minimal: { function_name: 'fn' },
    full: { function_name: 'fn', qualifier: '3', ...COMMON_FULL },
    required: ['function_name'],
    invalid: { 'function_name が数値': { function_name: 1 } },
  },
  {
    name: 'aws_lambda_list_event_source_mappings',
    minimal: {},
    full: {
      event_source_arn: 'arn:aws:sqs:ap-northeast-1:123456789012:q',
      function_name: 'fn',
      ...PAGING_FULL,
      ...COMMON_FULL,
    },
    required: [],
    invalid: { 'event_source_arn が数値': { event_source_arn: 1 } },
  },
  {
    name: 'aws_logs_describe_log_groups',
    minimal: {},
    full: { log_group_name_prefix: '/aws/lambda/', ...PAGING_FULL, ...COMMON_FULL },
    required: [],
    invalid: { 'log_group_name_prefix が数値': { log_group_name_prefix: 1 } },
  },
  {
    name: 'aws_logs_describe_log_streams',
    minimal: { log_group_name: 'g' },
    minimalReceived: { log_group_name: 'g', descending: false },
    full: {
      log_group_name: 'g',
      log_stream_name_prefix: 's',
      order_by: 'LastEventTime',
      descending: true,
      ...PAGING_FULL,
      ...COMMON_FULL,
    },
    required: ['log_group_name'],
    invalid: {
      'order_by が enum 外': { order_by: 'Name' },
      'descending が文字列': { descending: 'yes' },
    },
  },
  {
    name: 'aws_logs_get_log_events',
    minimal: { log_group_name: 'g', log_stream_name: 's' },
    minimalReceived: { log_group_name: 'g', log_stream_name: 's', start_from_head: false },
    full: {
      log_group_name: 'g',
      log_stream_name: 's',
      start_time: 1000,
      end_time: 2000,
      limit: 100,
      next_token: 'n',
      start_from_head: true,
      ...COMMON_FULL,
    },
    required: ['log_group_name', 'log_stream_name'],
    invalid: {
      'limit が小数': { limit: 1.5 },
      'limit が 0': { limit: 0 },
      'limit が上限超過': { limit: 10_001 },
      'start_time が文字列': { start_time: '1000' },
    },
  },
  {
    name: 'aws_logs_filter_log_events',
    minimal: { log_group_name: 'g' },
    full: {
      log_group_name: 'g',
      log_stream_names: ['a', 'b'],
      log_stream_name_prefix: 'p',
      filter_pattern: 'ERROR',
      start_time: 1000,
      end_time: 2000,
      ...PAGING_FULL,
      ...COMMON_FULL,
    },
    required: ['log_group_name'],
    invalid: {
      'log_stream_names が文字列': { log_stream_names: 'a' },
      'log_stream_names の要素が数値': { log_stream_names: [1] },
    },
  },
  {
    name: 'aws_cloudwatch_get_metric_statistics',
    minimal: {
      namespace: 'AWS/SQS',
      metric_name: 'NumberOfMessagesSent',
      start_time: ISO_START,
      end_time: ISO_END,
      period: 60,
      statistics: ['Average'],
    },
    full: {
      namespace: 'AWS/SQS',
      metric_name: 'NumberOfMessagesSent',
      dimensions: [{ name: 'QueueName', value: 'q' }],
      start_time: ISO_START,
      end_time: ISO_END,
      period: 300,
      statistics: ['SampleCount', 'Average', 'Sum', 'Minimum', 'Maximum'],
      unit: 'Seconds',
      ...COMMON_FULL,
    },
    required: ['namespace', 'metric_name', 'start_time', 'end_time', 'period', 'statistics'],
    invalid: {
      'period が文字列': { period: '60' },
      'period が 0': { period: 0 },
      'statistics が空': { statistics: [] },
      'statistics が 6 件': { statistics: ['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount', 'Sum'] },
      'statistics が enum 外': { statistics: ['p99'] },
      'unit が enum 外': { unit: 'Furlongs' },
      'dimensions が 31 件': {
        dimensions: Array.from({ length: 31 }, (_unused, index) => ({ name: `n${String(index)}`, value: 'v' })),
      },
      'dimensions の要素に name が無い': { dimensions: [{ value: 'v' }] },
    },
  },
  {
    name: 'aws_sqs_list_queues',
    minimal: {},
    full: { queue_name_prefix: 'q-', ...PAGING_FULL, ...COMMON_FULL },
    required: [],
    invalid: { 'queue_name_prefix が数値': { queue_name_prefix: 1 } },
  },
  {
    name: 'aws_sqs_get_queue_attributes',
    minimal: { queue_url: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/q' },
    minimalReceived: {
      queue_url: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/q',
      attribute_names: ['All'],
    },
    full: {
      queue_url: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/q',
      attribute_names: ['ApproximateNumberOfMessages', 'VisibilityTimeout'],
      ...COMMON_FULL,
    },
    required: ['queue_url'],
    invalid: { 'attribute_names が文字列': { attribute_names: 'All' } },
  },
  {
    name: 'aws_athena_start_query_execution',
    minimal: { query_string: 'SELECT 1' },
    full: {
      query_string: 'SELECT 1',
      work_group: 'primary',
      database: 'db',
      catalog: 'AwsDataCatalog',
      output_location: 's3://bucket/prefix/',
      ...COMMON_FULL,
    },
    required: ['query_string'],
    invalid: { 'query_string が数値': { query_string: 1 } },
  },
  {
    name: 'aws_athena_get_query_execution',
    minimal: { query_execution_id: 'id-1' },
    full: { query_execution_id: 'id-1', ...COMMON_FULL },
    required: ['query_execution_id'],
    invalid: { 'query_execution_id が数値': { query_execution_id: 1 } },
  },
  {
    name: 'aws_athena_get_query_results',
    minimal: { query_execution_id: 'id-1' },
    full: { query_execution_id: 'id-1', ...PAGING_FULL, ...COMMON_FULL },
    required: ['query_execution_id'],
    invalid: { 'max_items が文字列': { max_items: '10' } },
  },
  {
    name: 'aws_s3_ls',
    minimal: {},
    full: { s3_uri: 's3://bucket/prefix/', ...COMMON_FULL },
    required: [],
    invalid: { 's3_uri が数値': { s3_uri: 1 } },
  },
  {
    name: 'aws_s3_cp',
    minimal: { s3_uri: 's3://bucket/key', local_path: '/work/out.txt' },
    minimalReceived: { s3_uri: 's3://bucket/key', local_path: '/work/out.txt', overwrite: false },
    full: { s3_uri: 's3://bucket/key', local_path: '/work/out.txt', overwrite: true, ...COMMON_FULL },
    required: ['s3_uri', 'local_path'],
    invalid: { 'overwrite が文字列': { overwrite: 'true' } },
  },
  {
    name: 'aws_s3api_get_object',
    minimal: { bucket: 'b', key: 'k', outfile: '/work/out.bin' },
    minimalReceived: { bucket: 'b', key: 'k', outfile: '/work/out.bin', overwrite: false },
    full: {
      bucket: 'b',
      key: 'k',
      outfile: '/work/out.bin',
      version_id: 'v1',
      range: 'bytes=0-1023',
      overwrite: true,
      ...COMMON_FULL,
    },
    required: ['bucket', 'key', 'outfile'],
    invalid: { 'overwrite が数値': { overwrite: 1 } },
  },
  {
    name: 'aws_rds_describe_events',
    minimal: {},
    full: {
      source_identifier: 'db-1',
      source_type: 'db-instance',
      start_time: ISO_START,
      end_time: ISO_END,
      duration: 60,
      event_categories: ['availability', 'failover'],
      ...PAGING_FULL,
      ...COMMON_FULL,
    },
    required: [],
    invalid: {
      'source_type が enum 外': { source_type: 'db-nothing' },
      'duration が 0': { duration: 0 },
      'event_categories が空': { event_categories: [] },
    },
  },
  {
    name: 'aws_rds_describe_db_clusters',
    minimal: {},
    full: { db_cluster_identifier: 'cluster-1', ...PAGING_FULL, ...COMMON_FULL },
    required: [],
    invalid: { 'db_cluster_identifier が数値': { db_cluster_identifier: 1 } },
  },
  {
    name: 'aws_rds_describe_db_instances',
    minimal: {},
    full: { db_instance_identifier: 'db-1', ...PAGING_FULL, ...COMMON_FULL },
    required: [],
    invalid: { 'db_instance_identifier が数値': { db_instance_identifier: 1 } },
  },
  {
    name: 'aws_scheduler_list_schedules',
    minimal: {},
    full: { group_name: 'default', name_prefix: 'nightly-', state: 'ENABLED', ...PAGING_FULL, ...COMMON_FULL },
    required: [],
    invalid: { 'state が enum 外': { state: 'enabled' } },
  },
  {
    name: 'aws_scheduler_get_schedule',
    minimal: { name: 'nightly' },
    full: { name: 'nightly', group_name: 'default', ...COMMON_FULL },
    required: ['name'],
    invalid: { 'name が数値': { name: 1 } },
  },
  {
    name: 'aws_ecr_describe_images',
    minimal: { repository_name: 'repo' },
    full: {
      repository_name: 'repo',
      registry_id: '123456789012',
      image_ids: [{ image_tag: 'latest', image_digest: 'sha256:abc' }],
      tag_status: 'TAGGED',
      ...PAGING_FULL,
      ...COMMON_FULL,
    },
    required: ['repository_name'],
    invalid: {
      'tag_status が enum 外': { tag_status: 'MAYBE' },
      'image_ids が 101 件': { image_ids: Array.from({ length: 101 }, () => ({ image_tag: 't' })) },
    },
  },
  {
    name: 'aws_ec2_describe_instances',
    minimal: {},
    full: {
      instance_ids: ['i-0123456789abcdef0'],
      filters: [{ name: 'instance-state-name', values: ['running'] }],
      ...PAGING_FULL,
      ...COMMON_FULL,
    },
    required: [],
    invalid: {
      'instance_ids が空': { instance_ids: [] },
      'filters の values が空': { filters: [{ name: 'tag:Name', values: [] }] },
    },
  },
]

/**
SSO の 2 件は region を持たない (profile のみ)。
*/
const SSO_NAMES: ReadonlySet<string> = new Set(['aws_sso_login', 'aws_sso_login_status'])

/**
要素が strictObject のパラメータ。宣言外のキーを持つ要素は拒否される。
*/
const STRICT_ELEMENT_CASES: readonly { readonly tool: string, readonly args: Arguments }[] = [
  {
    tool: 'aws_ec2_describe_instances',
    args: { filters: [{ name: 'tag:Name', values: ['web'], extra: 1 }] },
  },
  {
    tool: 'aws_cloudwatch_get_metric_statistics',
    args: {
      namespace: 'AWS/SQS',
      metric_name: 'm',
      start_time: ISO_START,
      end_time: ISO_END,
      period: 60,
      statistics: ['Sum'],
      dimensions: [{ name: 'QueueName', value: 'q', extra: 1 }],
    },
  },
  {
    tool: 'aws_ecr_describe_images',
    args: { repository_name: 'repo', image_ids: [{ image_tag: 'latest', extra: 1 }] },
  },
]

function toolCaseNames(): string[] {
  return TOOL_CASES.map(item => item.name)
}

describe.each(PROTOCOL_ERAS)('input-acceptance (全ツールの入力の受理・拒否) [%s]', (era: ProtocolEra) => {
  let mcp: SpiedMcp

  beforeAll(async () => {
    mcp = await connectSpied(era)
  })

  afterAll(async () => {
    await closeMcp(mcp)
  })

  it('期待したプロトコル版で接続している', () => {
    expect(mcp.client.getNegotiatedProtocolVersion()).toBe(negotiatedVersionOf(era))
  })

  it('表が公開ツール全件と過不足なく一致する', () => {
    expect(toolCaseNames()).toEqual(allTools().map(tool => tool.name))
    expect(TOOL_CASES).toHaveLength(26)
  })

  describe.each(TOOL_CASES)('$name', (toolCase) => {
    it('必須だけの最小入力を受理し、既定値を補って handler へ渡す', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, toolCase.name, toolCase.minimal)

      expect(outcome).toBe('accepted')
      expect(mcp.calls.slice(before)).toEqual([
        { name: toolCase.name, arguments: toolCase.minimalReceived ?? toolCase.minimal },
      ])
    })

    it('全パラメータを指定した入力を受理し、そのまま handler へ渡す', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, toolCase.name, toolCase.full)

      expect(outcome).toBe('accepted')
      expect(mcp.calls.slice(before)).toEqual([{ name: toolCase.name, arguments: toolCase.full }])
    })

    it('最上位の追加プロパティは受理したうえで落とし、handler へ渡さない', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, toolCase.name, { ...toolCase.minimal, unexpected_key: 'x' })

      expect(outcome).toBe('accepted')
      expect(mcp.calls.slice(before)).toEqual([
        { name: toolCase.name, arguments: toolCase.minimalReceived ?? toolCase.minimal },
      ])
    })

    it.each(toolCase.required)('必須 %s が欠けた入力を拒否する', async (missing) => {
      const before = mcp.calls.length
      const rest = Object.fromEntries(Object.entries(toolCase.minimal).filter(([key]) => key !== missing))
      const outcome = await classifyCall(mcp.client, toolCase.name, rest)

      expect(outcome).toBe('schema-rejected')
      expect(mcp.calls).toHaveLength(before)
    })

    it.each(Object.entries(toolCase.invalid))('%s を拒否する', async (_label, override) => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, toolCase.name, { ...toolCase.minimal, ...override })

      expect(outcome).toBe('schema-rejected')
      expect(mcp.calls).toHaveLength(before)
    })

    it('profile の書式違反を拒否する', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, toolCase.name, { ...toolCase.minimal, profile: 'bad profile!' })

      expect(outcome).toBe('schema-rejected')
      expect(mcp.calls).toHaveLength(before)
    })
  })

  describe.each(TOOL_CASES.filter(item => !SSO_NAMES.has(item.name)))('$name の region', (toolCase) => {
    it('書式違反を拒否する', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, toolCase.name, { ...toolCase.minimal, region: 'Tokyo' })

      expect(outcome).toBe('schema-rejected')
      expect(mcp.calls).toHaveLength(before)
    })
  })

  describe.each(TOOL_CASES.filter(item => SSO_NAMES.has(item.name)))('$name の region', (toolCase) => {
    it('宣言されておらず、渡しても落とされる', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, toolCase.name, { ...toolCase.minimal, region: 'Tokyo' })

      expect(outcome).toBe('accepted')
      expect(mcp.calls.slice(before)).toEqual([
        { name: toolCase.name, arguments: toolCase.minimalReceived ?? toolCase.minimal },
      ])
    })
  })

  describe('strictObject 要素の宣言外キー', () => {
    it.each(STRICT_ELEMENT_CASES)('$tool は要素の宣言外キーを拒否する', async ({ tool, args }) => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, tool, args)

      expect(outcome).toBe('schema-rejected')
      expect(mcp.calls).toHaveLength(before)
    })
  })

  describe('未知ツール', () => {
    it('スキーマ拒否とは別の形で拒否し、handler へ届かない', async () => {
      const before = mcp.calls.length
      const outcome = await classifyCall(mcp.client, 'aws_nothing_here', {})

      expect(outcome).toBe('unknown-tool')
      expect(mcp.calls).toHaveLength(before)
    })
  })

  describe('結果の outputSchema 検証', () => {
    it('成功結果が検証を通ってクライアントへ届く', async () => {
      const called = await mcp.client.callTool({ name: 'aws_sts_get_caller_identity', arguments: {} })

      expect(called.isError).toBeUndefined()
      expect(called.structuredContent).toEqual(toCallToolResult(SPY_RESULT).structuredContent)
    })

    it('失敗結果 (isError + structuredContent) も検証を通ってクライアントへ届く', async () => {
      const failure = toCallToolResult({
        ok: false,
        exitCode: 254,
        category: 'permission-denied',
        data: {},
        artifacts: [],
        message: '権限が不足しています',
        stderr: 'AccessDenied',
      })
      const sts = allTools().find(tool => tool.name === 'aws_sts_get_caller_identity')
      if (sts === undefined) throw new Error('aws_sts_get_caller_identity が公開されていません')
      const failing = await connectMcp([{ ...sts, handler: () => Promise.resolve(failure) }], { era })
      try {
        const called = await failing.client.callTool({ name: sts.name, arguments: {} })

        expect(called.isError).toBe(true)
        expect(called.structuredContent).toEqual(failure.structuredContent)
      }
      finally {
        await closeMcp(failing)
      }
    })

    it('スキーマに違反する structuredContent は拒否される', async () => {
      const sts = allTools().find(tool => tool.name === 'aws_sts_get_caller_identity')
      if (sts === undefined) throw new Error('aws_sts_get_caller_identity が公開されていません')
      const violating = await connectMcp([{
        ...sts,
        handler: () => Promise.resolve({ content: [], structuredContent: { spy: true } }),
      }], { era })
      try {
        const called = await violating.client.callTool({ name: sts.name, arguments: {} })

        expect(called.isError).toBe(true)
        expect(JSON.stringify(called.content)).toContain('Output validation error')
      }
      finally {
        await closeMcp(violating)
      }
    })
  })
})

// tools/list に載る 26 ツールの契約テスト。
//
// 期待値テーブル (TOOL_CONTRACTS) は、契約の原本からの転記。
//   原本: aist-roadmap の specs/012-awscli-mcp-server/contracts/mcp-tools.md
// 原本は別リポジトリにある。
// 本リポジトリの CI からは参照できない。
// 契約が動いたときは、原本を直したうえで本テーブルも同時に直すこと。
//
// ツール名の `aws_` 接頭辞は、原本と一致している。
// destructiveHint を fetch 2 件だけ true にする規約も一致している。
// region の書式 (`^[a-z]{2,4}(-[a-z]+)+-\d$`) とサーバ名 `pecot-tools` も一致している。
//
// 原本側に未反映で残っている差分は 2 点ある。
//   - region の省略: 原本の共通規約は「全ツールが profile / region を持つ」。
//     SSO の 2 件は、§SSO 認証 のパラメータ表が profile だけを挙げている。実装も profile だけを公開する
//   - 応答 data: 原本の sso_login は { verificationUrl, userCode, state, profile }。
//     実装はコードを自動入力する URL (verificationUrlComplete) も載せる (inputSchema には影響しない)
// annotations の残りは契約の共通規約どおり。
// readOnlyHint は表の「読取専用」列に従う。
// openWorldHint は全ツール true (AWS API に到達する)。
// 実装は許可リストの kind から導出する。ここは導出結果でなく、期待値を直に書く。
//
// SSO の 2 件は許可リスト (ALLOWLIST) には入らない。
// 許可リストは「awscli を 1 回起こして出力を返す」コマンド表。
// tests/integration/real-awscli.test.ts が全件を実 awscli へ通すため、入れると実行のたびに本物のデバイス認証が発行される。

import { describe, expect, it, beforeAll, afterAll } from 'vitest'

import type { Tool } from '@modelcontextprotocol/client'
import { isRecord } from '../../../tests/_helpers/records.js'
import { SSO_TOOL_NAMES } from '../../../tests/_helpers/sso-tool-names.js'
import { ALLOWLIST, CLOUDWATCH_UNIT_VALUES, RDS_SOURCE_TYPE_VALUES } from '../../domain/allowlist.js'
import { allTools } from '../tools/index.js'
import { TOOL_OUTPUT_SCHEMA } from '../tools/_shared.js'
import { closeMcp, connectMcp, type ConnectedMcp } from './_client.js'
import { compareStrings } from '../../../tests/_helpers/compare-strings.js'

/**
JSON Schema の型 (契約表の「型」列)。integer は z.number().int() が落ちる先。
*/
type ParameterType = 'string' | 'boolean' | 'integer' | 'array'

/**
オブジェクトの配列を取るパラメータの要素 1 件の契約。宣言外のキーは受け付けない。
*/
interface ItemContract {
  readonly properties: Readonly<Record<string, ParameterType>>
  readonly required: readonly string[]
}

interface ToolContract {
  readonly name: string
  /**
  inputSchema のプロパティ全集合と型。共通の profile / region も含む。
  */
  readonly parameters: Readonly<Record<string, ParameterType>>
  readonly required: readonly string[]
  /**
  既定値を持つパラメータ。ここに無いパラメータは default を持ってはならない。
  */
  readonly defaults: Readonly<Record<string, unknown>>
  /**
  列挙値を持つパラメータ。
  */
  readonly enums: Readonly<Record<string, readonly string[]>>
  /**
  配列パラメータのうち、要素そのものが列挙値を持つもの（items.enum）。
  */
  readonly itemEnums?: Readonly<Record<string, readonly string[]>>
  /**
  配列パラメータのうち、要素がオブジェクトのもの（items.properties / items.required）。
  */
  readonly itemProperties?: Readonly<Record<string, ItemContract>>
  /**
  annotations.readOnlyHint に要求する値 (契約表の「読取専用」列)。
  */
  readonly readOnly: boolean
  /**
  annotations.destructiveHint に要求する値 (ローカルの既存ファイルを壊し得るツールだけ true)。
  */
  readonly destructive: boolean
}

/**
全ツール共通の任意入力 (契約の共通規約)。
*/
const COMMON_PARAMETERS: Readonly<Record<string, ParameterType>> = {
  profile: 'string',
  region: 'string',
}

/**
ページング列が max-items のツールが共通で持つ入力。
*/
const MAX_ITEMS_PARAMETERS: Readonly<Record<string, ParameterType>> = {
  max_items: 'integer',
  starting_token: 'string',
}

/**
profile / region の inputSchema 上の書式。

profile は契約書の `^[A-Za-z0-9_.-]+$` と同値 (`\w` = `[A-Za-z0-9_]`、`(?:…)` は捕捉しないだけのグループ)。
region は契約書の `^[a-z]{2,4}(-[a-z]+)+-\d$` と同値。
先頭を 2〜4 文字にすることで、European Sovereign Cloud の `eusc-de-east-1` を通す。
*/
const PROFILE_SCHEMA_PATTERN = String.raw`^[\w.-]+$`
const REGION_SCHEMA_PATTERN = String.raw`^[a-z]{2,4}(?:-[a-z]+)+-\d$`

const TOOL_CONTRACTS: readonly ToolContract[] = [
  {
    // region を持たない 2 件 (契約書 §SSO 認証 のパラメータ表が profile だけを挙げている)。
    name: 'aws_sso_login',
    parameters: { profile: 'string' },
    required: [],
    defaults: {},
    enums: {},
    readOnly: false,
    destructive: false,
  },
  {
    name: 'aws_sso_login_status',
    parameters: { profile: 'string' },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_sts_get_caller_identity',
    parameters: { ...COMMON_PARAMETERS },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_lambda_list_functions',
    parameters: { ...MAX_ITEMS_PARAMETERS, ...COMMON_PARAMETERS },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_lambda_get_function_configuration',
    parameters: { function_name: 'string', qualifier: 'string', ...COMMON_PARAMETERS },
    required: ['function_name'],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_lambda_list_event_source_mappings',
    parameters: {
      event_source_arn: 'string',
      function_name: 'string',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_logs_describe_log_groups',
    parameters: {
      log_group_name_prefix: 'string',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_logs_describe_log_streams',
    parameters: {
      log_group_name: 'string',
      log_stream_name_prefix: 'string',
      order_by: 'string',
      descending: 'boolean',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: ['log_group_name'],
    defaults: { descending: false },
    enums: { order_by: ['LogStreamName', 'LastEventTime'] },
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_logs_get_log_events',
    parameters: {
      log_group_name: 'string',
      log_stream_name: 'string',
      start_time: 'integer',
      end_time: 'integer',
      limit: 'integer',
      next_token: 'string',
      start_from_head: 'boolean',
      ...COMMON_PARAMETERS,
    },
    required: ['log_group_name', 'log_stream_name'],
    defaults: { start_from_head: false },
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_logs_filter_log_events',
    parameters: {
      log_group_name: 'string',
      log_stream_names: 'array',
      log_stream_name_prefix: 'string',
      filter_pattern: 'string',
      start_time: 'integer',
      end_time: 'integer',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: ['log_group_name'],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    // dimensions は要素が Name / Value の 2 項目で、awscli へは `Name=…,Value=…` の
    // 1 トークンとして渡る。statistics は string の列挙リスト（items.enum）。
    name: 'aws_cloudwatch_get_metric_statistics',
    parameters: {
      namespace: 'string',
      metric_name: 'string',
      dimensions: 'array',
      start_time: 'string',
      end_time: 'string',
      period: 'integer',
      statistics: 'array',
      unit: 'string',
      ...COMMON_PARAMETERS,
    },
    required: ['namespace', 'metric_name', 'start_time', 'end_time', 'period', 'statistics'],
    defaults: {},
    enums: { unit: CLOUDWATCH_UNIT_VALUES },
    itemEnums: { statistics: ['SampleCount', 'Average', 'Sum', 'Minimum', 'Maximum'] },
    itemProperties: {
      dimensions: {
        properties: { name: 'string', value: 'string' },
        required: ['name', 'value'],
      },
    },
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_sqs_list_queues',
    parameters: { queue_name_prefix: 'string', ...MAX_ITEMS_PARAMETERS, ...COMMON_PARAMETERS },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_sqs_get_queue_attributes',
    parameters: { queue_url: 'string', attribute_names: 'array', ...COMMON_PARAMETERS },
    required: ['queue_url'],
    defaults: { attribute_names: ['All'] },
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    // database / catalog / output_location は shorthand の材料。組み立て後の
    // --query-execution-context / --result-configuration は入力として公開しない。
    name: 'aws_athena_start_query_execution',
    parameters: {
      query_string: 'string',
      work_group: 'string',
      database: 'string',
      catalog: 'string',
      output_location: 'string',
      ...COMMON_PARAMETERS,
    },
    required: ['query_string'],
    defaults: {},
    enums: {},
    readOnly: false,
    destructive: false,
  },
  {
    name: 'aws_athena_get_query_execution',
    parameters: { query_execution_id: 'string', ...COMMON_PARAMETERS },
    required: ['query_execution_id'],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_athena_get_query_results',
    parameters: { query_execution_id: 'string', ...MAX_ITEMS_PARAMETERS, ...COMMON_PARAMETERS },
    required: ['query_execution_id'],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_s3_ls',
    parameters: { s3_uri: 'string', ...COMMON_PARAMETERS },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_s3_cp',
    parameters: {
      s3_uri: 'string',
      local_path: 'string',
      overwrite: 'boolean',
      ...COMMON_PARAMETERS,
    },
    required: ['s3_uri', 'local_path'],
    defaults: { overwrite: false },
    enums: {},
    readOnly: false,
    destructive: true,
  },
  {
    name: 'aws_s3api_get_object',
    parameters: {
      bucket: 'string',
      key: 'string',
      outfile: 'string',
      version_id: 'string',
      range: 'string',
      overwrite: 'boolean',
      ...COMMON_PARAMETERS,
    },
    required: ['bucket', 'key', 'outfile'],
    defaults: { overwrite: false },
    enums: {},
    readOnly: false,
    destructive: true,
  },
  {
    name: 'aws_rds_describe_events',
    parameters: {
      source_identifier: 'string',
      source_type: 'string',
      start_time: 'string',
      end_time: 'string',
      duration: 'integer',
      event_categories: 'array',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: [],
    defaults: {},
    enums: { source_type: RDS_SOURCE_TYPE_VALUES },
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_rds_describe_db_clusters',
    parameters: {
      db_cluster_identifier: 'string',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_rds_describe_db_instances',
    parameters: {
      db_instance_identifier: 'string',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: [],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_scheduler_list_schedules',
    parameters: {
      group_name: 'string',
      name_prefix: 'string',
      state: 'string',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: [],
    defaults: {},
    enums: { state: ['ENABLED', 'DISABLED'] },
    readOnly: true,
    destructive: false,
  },
  {
    name: 'aws_scheduler_get_schedule',
    parameters: { name: 'string', group_name: 'string', ...COMMON_PARAMETERS },
    required: ['name'],
    defaults: {},
    enums: {},
    readOnly: true,
    destructive: false,
  },
  {
    // tag_status は shorthand の材料。組み立て後の --filter は入力として公開しない。
    // image_ids は要素の 2 項目がいずれも任意で、1 つ以上の指定を許可リスト側が求める。
    name: 'aws_ecr_describe_images',
    parameters: {
      repository_name: 'string',
      registry_id: 'string',
      image_ids: 'array',
      tag_status: 'string',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: ['repository_name'],
    defaults: {},
    enums: { tag_status: ['TAGGED', 'UNTAGGED', 'ANY'] },
    itemProperties: {
      image_ids: {
        properties: { image_tag: 'string', image_digest: 'string' },
        required: [],
      },
    },
    readOnly: true,
    destructive: false,
  },
  {
    // filters は要素の Values が string の配列で、awscli へは `Name=…,Values=a,b` の
    // 1 トークンとして渡る。
    name: 'aws_ec2_describe_instances',
    parameters: {
      instance_ids: 'array',
      filters: 'array',
      ...MAX_ITEMS_PARAMETERS,
      ...COMMON_PARAMETERS,
    },
    required: [],
    defaults: {},
    enums: {},
    itemProperties: {
      filters: {
        properties: { name: 'string', values: 'array' },
        required: ['name', 'values'],
      },
    },
    readOnly: true,
    destructive: false,
  },
]

/**
region を公開するツール (契約表で region を持つもの)。
*/
const REGION_CONTRACTS = TOOL_CONTRACTS.filter(contract => 'region' in contract.parameters)

function sorted(values: readonly string[]): readonly string[] {
  return values.toSorted(compareStrings)
}

/**
JSON Schema のプロパティ 1 件を Record として取り出す。
*/
function propertyOf(schema: Readonly<Record<string, unknown>> | undefined, name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-object-injection -- name は本ファイルの期待値テーブル由来の定数
  const property = schema?.[name]
  if (!isRecord(property)) throw new Error(`JSON Schema に ${name} がありません`)
  return property
}

/**
配列パラメータの items を Record として取り出す。
*/
function itemsOf(schema: Readonly<Record<string, unknown>> | undefined, name: string): Record<string, unknown> {
  const items = propertyOf(schema, name)['items']
  if (!isRecord(items)) throw new Error(`JSON Schema の ${name} に items がありません`)
  return items
}

/**
items.required のように「省略されうる文字列配列」を配列として読む。
*/
function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter(element => typeof element === 'string') : []
}

describe('MCP ツール契約 (tools/list)', () => {
  let listed: readonly Tool[] = []
  let connected: ConnectedMcp | undefined

  beforeAll(async () => {
    connected = await connectMcp(allTools())
    const result = await connected.client.listTools()
    listed = result.tools
  })

  afterAll(async () => {
    if (connected !== undefined) await closeMcp(connected)
  })

  function toolOf(name: string): Tool {
    const found = listed.find(tool => tool.name === name)
    if (found === undefined) throw new Error(`tools/list に ${name} が載っていません`)
    return found
  }

  it('契約表の順で 26 件を公開する', () => {
    // 3 者 (契約表 / 許可リスト / tools/list) を比較して、片方だけ直すと必ず失敗するようにする。
    // 許可リストは SSO の 2 件を持たない。そのため契約表の尾部と比較する。
    const expected = TOOL_CONTRACTS.map(contract => contract.name)

    expect(listed.map(tool => tool.name)).toEqual(expected)
    expect(ALLOWLIST.map(entry => entry.toolName)).toEqual(expected.slice(SSO_TOOL_NAMES.length))
  })

  it('SSO の 2 件は許可リストに載せない', () => {
    // 載せると tests/integration/real-awscli.test.ts が実行のたびに本物のデバイス認証を発行する。
    const allowlisted = new Set(ALLOWLIST.map(entry => entry.toolName))

    for (const name of SSO_TOOL_NAMES) expect(allowlisted.has(name)).toBe(false)
  })

  it('ツール名は aws_ で始まる', () => {
    for (const tool of listed) expect(tool.name).toMatch(/^aws_/)
  })

  it.each(TOOL_CONTRACTS)('$name の inputSchema が契約表と一致する', (contract) => {
    const tool = toolOf(contract.name)
    const properties = tool.inputSchema.properties

    expect(sorted(Object.keys(properties ?? {}))).toEqual(sorted(Object.keys(contract.parameters)))
    expect(sorted(tool.inputSchema.required ?? [])).toEqual(sorted(contract.required))

    for (const [name, type] of Object.entries(contract.parameters)) {
      const property = propertyOf(properties, name)
      expect(property['type'], `${contract.name}.${name}`).toBe(type)
      // description はエージェントが引数を決める唯一の手掛かりなので全パラメータに要る。
      expect(typeof property['description'], `${contract.name}.${name}`).toBe('string')
      expect(property['description'], `${contract.name}.${name}`).not.toBe('')
    }

    for (const [name, values] of Object.entries(contract.enums)) {
      expect(propertyOf(properties, name)['enum']).toEqual(values)
    }

    const itemEnumEntries = Object.entries(contract.itemEnums ?? {})
    for (const [name, values] of itemEnumEntries) {
      expect(itemsOf(properties, name)['enum'], `${contract.name}.${name}.items`).toEqual(values)
    }

    const itemPropertyEntries = Object.entries(contract.itemProperties ?? {})
    for (const [name, item] of itemPropertyEntries) {
      const items = itemsOf(properties, name)

      // 宣言外のキーを SDK が入力検証エラーで落とすための条件。z.object だと通知なく削られる。
      expect(items['additionalProperties'], `${contract.name}.${name}.items`).toBe(false)
      const itemProperties = items['properties']
      if (!isRecord(itemProperties)) {
        throw new Error(`${contract.name}.${name}.items に properties がありません`)
      }
      expect(sorted(Object.keys(itemProperties)), `${contract.name}.${name}.items`)
        .toEqual(sorted(Object.keys(item.properties)))
      expect(sorted(asStringArray(items['required'])), `${contract.name}.${name}.items`)
        .toEqual(sorted(item.required))

      for (const [field, type] of Object.entries(item.properties)) {
        const property = propertyOf(itemProperties, field)
        expect(property['type'], `${contract.name}.${name}.items.${field}`).toBe(type)
        // description はエージェントが引数を決める唯一の手掛かりなので全パラメータに要る。
        expect(typeof property['description'], `${contract.name}.${name}.items.${field}`).toBe('string')
        expect(property['description'], `${contract.name}.${name}.items.${field}`).not.toBe('')
      }
    }
  })

  it.each(TOOL_CONTRACTS)('$name の inputSchema が契約表どおりの既定値を持つ', (contract) => {
    const properties = toolOf(contract.name).inputSchema.properties ?? {}

    // 契約表に無いパラメータが既定値を持ってしまう退行も見たいので、集合として比較する。
    const withDefault = Object.entries(properties)
      .filter(([, property]) => isRecord(property) && 'default' in property)
      .map(([name]) => name)
    expect(sorted(withDefault)).toEqual(sorted(Object.keys(contract.defaults)))

    for (const [name, value] of Object.entries(contract.defaults)) {
      expect(propertyOf(properties, name)['default']).toEqual(value)
    }
  })

  it.each(TOOL_CONTRACTS)('$name の profile が共通規約の書式を公開する', (contract) => {
    const properties = toolOf(contract.name).inputSchema.properties

    expect(propertyOf(properties, 'profile')['pattern']).toBe(PROFILE_SCHEMA_PATTERN)
  })

  // region を持つのは契約表がそう定めているツールだけ (SSO の 2 件は持たない)。
  it.each(REGION_CONTRACTS)('$name の region が共通規約の書式を公開する', (contract) => {
    const properties = toolOf(contract.name).inputSchema.properties

    expect(propertyOf(properties, 'region')['pattern']).toBe(REGION_SCHEMA_PATTERN)
  })

  it.each(TOOL_CONTRACTS)('$name の annotations が契約表と一致する', (contract) => {
    expect(toolOf(contract.name).annotations).toMatchObject({
      readOnlyHint: contract.readOnly,
      destructiveHint: contract.destructive,
      openWorldHint: true,
    })
  })

  it.each(TOOL_CONTRACTS)('$name が ExecutionResult 同形の outputSchema を公開する', (contract) => {
    const outputSchema = toolOf(contract.name).outputSchema

    const properties = outputSchema?.['properties']

    const exposedKeys = Object.keys(isRecord(properties) ? properties : {})

    expect(sorted(exposedKeys))
      .toEqual(sorted(Object.keys(TOOL_OUTPUT_SCHEMA.shape)))
    // category / stderr は失敗時のみ載るため必須にしない。
    expect(sorted(asStringArray(outputSchema?.['required'])))
      .toEqual(['artifacts', 'data', 'exitCode', 'message', 'ok'])
  })

  it.each(TOOL_CONTRACTS)('$name が title と description を持つ', (contract) => {
    const tool = toolOf(contract.name)

    // undefined を素通しさせない。型で見てから空文字を弾く (パラメータ側の description と同じ厳しさ)。
    expect(typeof tool.title, `${contract.name}.title`).toBe('string')
    expect(tool.title, `${contract.name}.title`).not.toBe('')
    expect(typeof tool.description, `${contract.name}.description`).toBe('string')
    expect(tool.description, `${contract.name}.description`).not.toBe('')
  })
})

// 許可リストの型と実体。公開する awscli コマンドは全てここで静的に宣言し、
// ツール実装（mcp/tools/*）はこの宣言からしか引数を組み立てない。
//
// エントリの並びは contracts/mcp-tools.md の表の順で、そのまま tools/list の並びになる。
// 系統ごとの配列に分けてから ALLOWLIST へ連結する（1 系統を足すときに触る範囲が閉じる）。

/**
失敗理由の種別（research R4）。
*/
export type FailureCategory
  = | 'not-allowed'
    | 'invalid-input'
    | 'awscli-missing'
    | 'auth-missing'
    | 'auth-expired'
    | 'permission-denied'
    | 'resource-not-found'
    | 'timeout'
    | 'other'

/**
入力 1 項目の値の種類。検証規則と awscli 引数への写し方の双方を決める。

`shorthand` だけは、利用者が直接指定する入力ではない。
他の入力から `Key=value,Key=value` を組み立てる合成項目（`--query-execution-context` 等）。

`shorthand-list` は、利用者がオブジェクトの配列で直接指定する入力。
配列全体が `[{"Name":"…","Value":"…"}]` の JSON 1 トークンになる（`--dimensions` / `--filters` /
`--image-ids`）。awscli はこれらのフラグを shorthand と JSON の双方で受ける。
*/
export type InputKind
  = | 'string'
    | 'string-list'
    | 'integer'
    | 'boolean'
    | 'enum'
    | 'abs-path'
    | 's3-uri'
    | 's3-list-uri'
    | 'shorthand'
    | 'shorthand-list'

/**
`shorthand` の構成要素 1 件。同じエントリの入力 `from` の値を `key=<値>` として載せる。
*/
export interface ShorthandPart {
  readonly key: string
  readonly from: string
}

/**
`shorthand-list` の要素が持てる構成要素 1 件。要素の `field` の値を JSON の `key` として載せる。

`ShorthandPart.from` が「同じエントリの別入力」を指すのに対し、こちらは「配列要素の中の
キー」を指す。意味が違うので型を分ける。`list` が true の構成要素は string[] を受け、
JSON でも配列のまま載せる（`--filters` の `Values`）。
*/
export interface ShorthandElementPart {
  readonly key: string
  readonly field: string
  readonly list?: boolean
}

/**
入力 1 項目の宣言。

`awsFlag` を持つ項目は `--flag value`、`positional` を持つ項目は指定順の位置引数として渡す。
どちらも持たない項目（`overwrite` 等）は検証だけに使い、awscli の引数には現れない。
*/
export interface InputSpec {
  readonly name: string
  readonly kind: InputKind
  readonly required: boolean
  /**
  `--log-group-name` のような awscli のオプション名。
  */
  readonly awsFlag?: string
  /**
  位置引数の並び順（0 始まり）。
  */
  readonly positional?: number
  /**
  未指定時に補う値。
  */
  readonly default?: string | number | boolean | readonly string[]
  /**
  kind が 'enum' のときの許容値。
  */
  readonly values?: readonly string[]
  /**
  kind が 'integer' のときの下限・上限（両端を含む）。
  */
  readonly min?: number
  readonly max?: number
  /**
  kind が 'string' / 'string-list' のときの書式。
  */
  readonly pattern?: Readonly<RegExp>
  /**
  kind が 'shorthand' のときの組み立て元。値を持つ構成要素だけが `,` 連結で並ぶ。
  */
  readonly parts?: readonly ShorthandPart[]
  /**
  kind が 'shorthand-list' のときの要素の構成。宣言外のキーは受け付けない。
  */
  readonly elements?: readonly ShorthandElementPart[]
}

/**
公開を許可する awscli コマンド 1 件の静的定義（data-model.md の AllowlistEntry）。
*/
export interface AllowlistEntry {
  readonly toolName: string
  readonly service: string
  readonly subcommand: string
  readonly kind: 'read' | 'fetch' | 'execute' | 'auth'
  /**
  `--output json` を付与するか（`s3 ls` / `s3 cp` は高レベルコマンドのため false）。
  */
  readonly jsonOutput: boolean
  readonly pagination: 'none' | 'max-items' | 'limit-next-token'
  readonly inputs: readonly InputSpec[]
  /**
  同時指定を invalid-input にする入力名の組（例 log_stream_names と log_stream_name_prefix）。
  */
  readonly exclusive?: readonly (readonly string[])[]
}

/**
`profile` の書式。data-model.md の `^[A-Za-z0-9_.-]+$` と同値（`\w` = `[A-Za-z0-9_]`）。

inputSchema へ載せる mcp 層も同じ定数を読む。書式の定義をここ 1 箇所に保つため。
*/
export const PROFILE_PATTERN = /^[\w.-]+$/

/**
`region` の書式（`ap-northeast-1` 等）。

先頭は 2〜4 文字。European Sovereign Cloud の `eusc-de-east-1` が 4 文字始まりで、
2 文字固定だと入力検証エラーで弾かれる。
契約書の共通規約も `^[a-z]{2,4}(-[a-z]+)+-\d$` で、本パターンと一致している。
契約書は specs/012-awscli-mcp-server/contracts/mcp-tools.md を指す。
*/
// eslint-disable-next-line security/detect-unsafe-regex -- 繰り返し部の先頭 '-' は内側の文字クラスに無く backtracking しない
export const REGION_PATTERN = /^[a-z]{2,4}(?:-[a-z]+)+-\d$/

/**
ISO 8601 の日時（`2026-09-01T00:00Z` / `2026-09-01T00:00:00.000+09:00`）。

CloudWatch と RDS の timestamp 引数はこの書式で渡す。CloudWatch Logs 系の epoch ミリ秒
（integer）とは型が異なるので、契約と description にも「ISO 8601」と明記している。
`Z` とオフセット付きの双方を awscli 2.36.40 が正しく変換することを動作確認済み。
*/
// eslint-disable-next-line security/detect-unsafe-regex -- 任意の繰り返しは `(?:\.\d+)?` の 1 段だけ。直前が固定文字 '.' で、直後は Z かオフセットの固定長。入れ子が無く backtracking しない
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
全エントリ共通の任意入力 `profile`。
*/
export const PROFILE_INPUT: InputSpec = {
  name: 'profile',
  kind: 'string',
  required: false,
  awsFlag: '--profile',
  pattern: PROFILE_PATTERN,
}

/**
全エントリ共通の任意入力 `region`。
*/
export const REGION_INPUT: InputSpec = {
  name: 'region',
  kind: 'string',
  required: false,
  awsFlag: '--region',
  pattern: REGION_PATTERN,
}

/**
ページング列が `max-items` のエントリが共通で持つ入力（契約の共通規約）。
*/
const MAX_ITEMS_INPUTS: readonly InputSpec[] = [
  { name: 'max_items', kind: 'integer', required: false, awsFlag: '--max-items', min: 1 },
  { name: 'starting_token', kind: 'string', required: false, awsFlag: '--starting-token' },
]

export const STS_GET_CALLER_IDENTITY: AllowlistEntry = {
  toolName: 'aws_sts_get_caller_identity',
  service: 'sts',
  subcommand: 'get-caller-identity',
  kind: 'read',
  jsonOutput: true,
  pagination: 'none',
  inputs: [],
}

const STS_ENTRIES: readonly AllowlistEntry[] = [STS_GET_CALLER_IDENTITY]

export const LAMBDA_LIST_FUNCTIONS: AllowlistEntry = {
  toolName: 'aws_lambda_list_functions',
  service: 'lambda',
  subcommand: 'list-functions',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [...MAX_ITEMS_INPUTS],
}

export const LAMBDA_GET_FUNCTION_CONFIGURATION: AllowlistEntry = {
  toolName: 'aws_lambda_get_function_configuration',
  service: 'lambda',
  subcommand: 'get-function-configuration',
  kind: 'read',
  jsonOutput: true,
  pagination: 'none',
  inputs: [
    { name: 'function_name', kind: 'string', required: true, awsFlag: '--function-name' },
    { name: 'qualifier', kind: 'string', required: false, awsFlag: '--qualifier' },
  ],
}

/**
`lambda list-event-source-mappings`。

関数とイベントソース（SQS キュー等）の対応を引くために使う。`--event-source-arn` と
`--function-name` は、片方だけでも両方でも指定できる。
*/
export const LAMBDA_LIST_EVENT_SOURCE_MAPPINGS: AllowlistEntry = {
  toolName: 'aws_lambda_list_event_source_mappings',
  service: 'lambda',
  subcommand: 'list-event-source-mappings',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    {
      name: 'event_source_arn',
      kind: 'string',
      required: false,
      awsFlag: '--event-source-arn',
      pattern: /^arn:/,
    },
    { name: 'function_name', kind: 'string', required: false, awsFlag: '--function-name' },
    ...MAX_ITEMS_INPUTS,
  ],
}

const LAMBDA_ENTRIES: readonly AllowlistEntry[] = [
  LAMBDA_LIST_FUNCTIONS,
  LAMBDA_GET_FUNCTION_CONFIGURATION,
  LAMBDA_LIST_EVENT_SOURCE_MAPPINGS,
]

export const LOGS_DESCRIBE_LOG_GROUPS: AllowlistEntry = {
  toolName: 'aws_logs_describe_log_groups',
  service: 'logs',
  subcommand: 'describe-log-groups',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    { name: 'log_group_name_prefix', kind: 'string', required: false, awsFlag: '--log-group-name-prefix' },
    ...MAX_ITEMS_INPUTS,
  ],
}

export const LOGS_DESCRIBE_LOG_STREAMS: AllowlistEntry = {
  toolName: 'aws_logs_describe_log_streams',
  service: 'logs',
  subcommand: 'describe-log-streams',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    { name: 'log_group_name', kind: 'string', required: true, awsFlag: '--log-group-name' },
    { name: 'log_stream_name_prefix', kind: 'string', required: false, awsFlag: '--log-stream-name-prefix' },
    {
      name: 'order_by',
      kind: 'enum',
      required: false,
      awsFlag: '--order-by',
      values: ['LogStreamName', 'LastEventTime'],
    },
    { name: 'descending', kind: 'boolean', required: false, awsFlag: '--descending', default: false },
    ...MAX_ITEMS_INPUTS,
  ],
}

export const LOGS_GET_LOG_EVENTS: AllowlistEntry = {
  toolName: 'aws_logs_get_log_events',
  service: 'logs',
  subcommand: 'get-log-events',
  kind: 'read',
  jsonOutput: true,
  pagination: 'limit-next-token',
  inputs: [
    { name: 'log_group_name', kind: 'string', required: true, awsFlag: '--log-group-name' },
    { name: 'log_stream_name', kind: 'string', required: true, awsFlag: '--log-stream-name' },
    { name: 'start_time', kind: 'integer', required: false, awsFlag: '--start-time' },
    { name: 'end_time', kind: 'integer', required: false, awsFlag: '--end-time' },
    { name: 'limit', kind: 'integer', required: false, awsFlag: '--limit', min: 1, max: 10_000 },
    { name: 'next_token', kind: 'string', required: false, awsFlag: '--next-token' },
    { name: 'start_from_head', kind: 'boolean', required: false, awsFlag: '--start-from-head', default: false },
  ],
}

export const LOGS_FILTER_LOG_EVENTS: AllowlistEntry = {
  toolName: 'aws_logs_filter_log_events',
  service: 'logs',
  subcommand: 'filter-log-events',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    { name: 'log_group_name', kind: 'string', required: true, awsFlag: '--log-group-name' },
    { name: 'log_stream_names', kind: 'string-list', required: false, awsFlag: '--log-stream-names' },
    { name: 'log_stream_name_prefix', kind: 'string', required: false, awsFlag: '--log-stream-name-prefix' },
    { name: 'filter_pattern', kind: 'string', required: false, awsFlag: '--filter-pattern' },
    { name: 'start_time', kind: 'integer', required: false, awsFlag: '--start-time' },
    { name: 'end_time', kind: 'integer', required: false, awsFlag: '--end-time' },
    ...MAX_ITEMS_INPUTS,
  ],
  exclusive: [['log_stream_names', 'log_stream_name_prefix']],
}

const LOGS_ENTRIES: readonly AllowlistEntry[] = [
  LOGS_DESCRIBE_LOG_GROUPS,
  LOGS_DESCRIBE_LOG_STREAMS,
  LOGS_GET_LOG_EVENTS,
  LOGS_FILTER_LOG_EVENTS,
]

/**
CloudWatch の標準単位（`--unit` の候補。awscli 2.36.40）。

許可リストの `values` と mcp 層の `z.enum`、契約テストが同じ配列を読む。3 箇所に写すと
綴りがずれるので定義をここ 1 箇所に置く。`z.enum` は非空タプルを要求するため型注釈を付ける。
*/
export const CLOUDWATCH_UNIT_VALUES: readonly [string, ...string[]] = [
  'Seconds', 'Microseconds', 'Milliseconds',
  'Bytes', 'Kilobytes', 'Megabytes', 'Gigabytes', 'Terabytes',
  'Bits', 'Kilobits', 'Megabits', 'Gigabits', 'Terabits',
  'Percent', 'Count',
  'Bytes/Second', 'Kilobytes/Second', 'Megabytes/Second', 'Gigabytes/Second',
  'Terabytes/Second',
  'Bits/Second', 'Kilobits/Second', 'Megabits/Second', 'Gigabits/Second',
  'Terabits/Second',
  'Count/Second', 'None',
]

/**
`cloudwatch get-metric-statistics`。

`--statistics` を必須にすることで `--extended-statistics`（パーセンタイル）を公開しない形に
閉じている。API は双方の同時指定を拒否するため、片方だけを公開すれば足りる。
*/
export const CLOUDWATCH_GET_METRIC_STATISTICS: AllowlistEntry = {
  toolName: 'aws_cloudwatch_get_metric_statistics',
  service: 'cloudwatch',
  subcommand: 'get-metric-statistics',
  kind: 'read',
  jsonOutput: true,
  pagination: 'none',
  inputs: [
    { name: 'namespace', kind: 'string', required: true, awsFlag: '--namespace' },
    { name: 'metric_name', kind: 'string', required: true, awsFlag: '--metric-name' },
    {
      name: 'dimensions',
      kind: 'shorthand-list',
      required: false,
      awsFlag: '--dimensions',
      elements: [{ key: 'Name', field: 'name' }, { key: 'Value', field: 'value' }],
    },
    {
      name: 'start_time',
      kind: 'string',
      required: true,
      awsFlag: '--start-time',
      pattern: TIMESTAMP_PATTERN,
    },
    {
      name: 'end_time',
      kind: 'string',
      required: true,
      awsFlag: '--end-time',
      pattern: TIMESTAMP_PATTERN,
    },
    { name: 'period', kind: 'integer', required: true, awsFlag: '--period', min: 1 },
    {
      name: 'statistics',
      kind: 'string-list',
      required: true,
      awsFlag: '--statistics',
      values: ['SampleCount', 'Average', 'Sum', 'Minimum', 'Maximum'],
    },
    {
      name: 'unit',
      kind: 'enum',
      required: false,
      awsFlag: '--unit',
      values: CLOUDWATCH_UNIT_VALUES,
    },
  ],
}

const CLOUDWATCH_ENTRIES: readonly AllowlistEntry[] = [CLOUDWATCH_GET_METRIC_STATISTICS]

export const SQS_LIST_QUEUES: AllowlistEntry = {
  toolName: 'aws_sqs_list_queues',
  service: 'sqs',
  subcommand: 'list-queues',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    { name: 'queue_name_prefix', kind: 'string', required: false, awsFlag: '--queue-name-prefix' },
    ...MAX_ITEMS_INPUTS,
  ],
}

export const SQS_GET_QUEUE_ATTRIBUTES: AllowlistEntry = {
  toolName: 'aws_sqs_get_queue_attributes',
  service: 'sqs',
  subcommand: 'get-queue-attributes',
  kind: 'read',
  jsonOutput: true,
  pagination: 'none',
  inputs: [
    { name: 'queue_url', kind: 'string', required: true, awsFlag: '--queue-url', pattern: /^https:\/\// },
    {
      name: 'attribute_names',
      kind: 'string-list',
      required: false,
      awsFlag: '--attribute-names',
      default: ['All'],
    },
  ],
}

const SQS_ENTRIES: readonly AllowlistEntry[] = [SQS_LIST_QUEUES, SQS_GET_QUEUE_ATTRIBUTES]

/**
`athena start-query-execution`。

`database` / `catalog` / `output_location` は検証だけに使う。
awscli へは shorthand の `--query-execution-context` / `--result-configuration` として渡す。利用者に shorthand の
文字列そのものを書かせると契約外のキー（`ExpectedBucketOwner` 等）を混ぜられるため、
組み立てはここの宣言に閉じる。
*/
export const ATHENA_START_QUERY_EXECUTION: AllowlistEntry = {
  toolName: 'aws_athena_start_query_execution',
  service: 'athena',
  subcommand: 'start-query-execution',
  kind: 'execute',
  jsonOutput: true,
  pagination: 'none',
  inputs: [
    { name: 'query_string', kind: 'string', required: true, awsFlag: '--query-string' },
    { name: 'work_group', kind: 'string', required: false, awsFlag: '--work-group' },
    { name: 'database', kind: 'string', required: false },
    { name: 'catalog', kind: 'string', required: false },
    { name: 'output_location', kind: 'string', required: false, pattern: /^s3:\/\// },
    {
      name: 'query_execution_context',
      kind: 'shorthand',
      required: false,
      awsFlag: '--query-execution-context',
      parts: [{ key: 'Database', from: 'database' }, { key: 'Catalog', from: 'catalog' }],
    },
    {
      name: 'result_configuration',
      kind: 'shorthand',
      required: false,
      awsFlag: '--result-configuration',
      parts: [{ key: 'OutputLocation', from: 'output_location' }],
    },
  ],
}

export const ATHENA_GET_QUERY_EXECUTION: AllowlistEntry = {
  toolName: 'aws_athena_get_query_execution',
  service: 'athena',
  subcommand: 'get-query-execution',
  kind: 'read',
  jsonOutput: true,
  pagination: 'none',
  inputs: [
    { name: 'query_execution_id', kind: 'string', required: true, awsFlag: '--query-execution-id' },
  ],
}

export const ATHENA_GET_QUERY_RESULTS: AllowlistEntry = {
  toolName: 'aws_athena_get_query_results',
  service: 'athena',
  subcommand: 'get-query-results',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    { name: 'query_execution_id', kind: 'string', required: true, awsFlag: '--query-execution-id' },
    ...MAX_ITEMS_INPUTS,
  ],
}

const ATHENA_ENTRIES: readonly AllowlistEntry[] = [
  ATHENA_START_QUERY_EXECUTION,
  ATHENA_GET_QUERY_EXECUTION,
  ATHENA_GET_QUERY_RESULTS,
]

/**
`s3 ls`。高レベルコマンドで JSON 出力を持たないため jsonOutput は false。
*/
export const S3_LS: AllowlistEntry = {
  toolName: 'aws_s3_ls',
  service: 's3',
  subcommand: 'ls',
  kind: 'read',
  jsonOutput: false,
  pagination: 'none',
  inputs: [
    { name: 's3_uri', kind: 's3-list-uri', required: false, positional: 0 },
  ],
}

/**
`s3 cp <s3_uri> <local_path>`。

入力は「取得元は S3、書き出し先はローカル」の 2 項目に固定されている。
そのため、アップロード方向は検証で弾くまでもなく表現できない（research R7）。
*/
export const S3_CP: AllowlistEntry = {
  toolName: 'aws_s3_cp',
  service: 's3',
  subcommand: 'cp',
  kind: 'fetch',
  jsonOutput: false,
  pagination: 'none',
  inputs: [
    { name: 's3_uri', kind: 's3-uri', required: true, positional: 0 },
    { name: 'local_path', kind: 'abs-path', required: true, positional: 1 },
    { name: 'overwrite', kind: 'boolean', required: false, default: false },
  ],
}

export const S3API_GET_OBJECT: AllowlistEntry = {
  toolName: 'aws_s3api_get_object',
  service: 's3api',
  subcommand: 'get-object',
  kind: 'fetch',
  jsonOutput: true,
  pagination: 'none',
  inputs: [
    { name: 'bucket', kind: 'string', required: true, awsFlag: '--bucket' },
    { name: 'key', kind: 'string', required: true, awsFlag: '--key' },
    { name: 'outfile', kind: 'abs-path', required: true, positional: 0 },
    { name: 'version_id', kind: 'string', required: false, awsFlag: '--version-id' },
    { name: 'range', kind: 'string', required: false, awsFlag: '--range', pattern: /^bytes=/ },
    { name: 'overwrite', kind: 'boolean', required: false, default: false },
  ],
}

const S3_ENTRIES: readonly AllowlistEntry[] = [S3_LS, S3_CP, S3API_GET_OBJECT]

/**
イベントを引ける発生元の種別（`--source-type` の候補。awscli 2.36.40）。

許可リストの `values` と mcp 層の `z.enum`、契約テストが同じ配列を読む（`CLOUDWATCH_UNIT_VALUES`
と同型）。
*/
export const RDS_SOURCE_TYPE_VALUES: readonly [string, ...string[]] = [
  'db-instance', 'db-parameter-group', 'db-security-group', 'db-snapshot',
  'db-cluster', 'db-cluster-snapshot', 'custom-engine-version', 'db-proxy',
  'blue-green-deployment', 'db-shard-group', 'zero-etl',
]

/**
`rds describe-events`。

DB の停止・フェイルオーバー等のイベント履歴を引く。`--filters` は公開しない
（API が受ける属性は版で動くので、契約に固定できる範囲へ絞る）。

`duration`（現在から遡る分数）は `start_time` / `end_time` と意味が重なるので排他にする。
*/
export const RDS_DESCRIBE_EVENTS: AllowlistEntry = {
  toolName: 'aws_rds_describe_events',
  service: 'rds',
  subcommand: 'describe-events',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    { name: 'source_identifier', kind: 'string', required: false, awsFlag: '--source-identifier' },
    {
      name: 'source_type',
      kind: 'enum',
      required: false,
      awsFlag: '--source-type',
      values: RDS_SOURCE_TYPE_VALUES,
    },
    {
      name: 'start_time',
      kind: 'string',
      required: false,
      awsFlag: '--start-time',
      pattern: TIMESTAMP_PATTERN,
    },
    {
      name: 'end_time',
      kind: 'string',
      required: false,
      awsFlag: '--end-time',
      pattern: TIMESTAMP_PATTERN,
    },
    { name: 'duration', kind: 'integer', required: false, awsFlag: '--duration', min: 1 },
    {
      name: 'event_categories',
      kind: 'string-list',
      required: false,
      awsFlag: '--event-categories',
    },
    ...MAX_ITEMS_INPUTS,
  ],
  exclusive: [['start_time', 'duration'], ['end_time', 'duration']],
}

export const RDS_DESCRIBE_DB_CLUSTERS: AllowlistEntry = {
  toolName: 'aws_rds_describe_db_clusters',
  service: 'rds',
  subcommand: 'describe-db-clusters',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    {
      name: 'db_cluster_identifier',
      kind: 'string',
      required: false,
      awsFlag: '--db-cluster-identifier',
    },
    ...MAX_ITEMS_INPUTS,
  ],
}

export const RDS_DESCRIBE_DB_INSTANCES: AllowlistEntry = {
  toolName: 'aws_rds_describe_db_instances',
  service: 'rds',
  subcommand: 'describe-db-instances',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    {
      name: 'db_instance_identifier',
      kind: 'string',
      required: false,
      awsFlag: '--db-instance-identifier',
    },
    ...MAX_ITEMS_INPUTS,
  ],
}

const RDS_ENTRIES: readonly AllowlistEntry[] = [
  RDS_DESCRIBE_EVENTS,
  RDS_DESCRIBE_DB_CLUSTERS,
  RDS_DESCRIBE_DB_INSTANCES,
]

export const SCHEDULER_LIST_SCHEDULES: AllowlistEntry = {
  toolName: 'aws_scheduler_list_schedules',
  service: 'scheduler',
  subcommand: 'list-schedules',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    { name: 'group_name', kind: 'string', required: false, awsFlag: '--group-name' },
    { name: 'name_prefix', kind: 'string', required: false, awsFlag: '--name-prefix' },
    {
      name: 'state',
      kind: 'enum',
      required: false,
      awsFlag: '--state',
      values: ['ENABLED', 'DISABLED'],
    },
    ...MAX_ITEMS_INPUTS,
  ],
}

export const SCHEDULER_GET_SCHEDULE: AllowlistEntry = {
  toolName: 'aws_scheduler_get_schedule',
  service: 'scheduler',
  subcommand: 'get-schedule',
  kind: 'read',
  jsonOutput: true,
  pagination: 'none',
  inputs: [
    { name: 'name', kind: 'string', required: true, awsFlag: '--name' },
    { name: 'group_name', kind: 'string', required: false, awsFlag: '--group-name' },
  ],
}

const SCHEDULER_ENTRIES: readonly AllowlistEntry[] = [
  SCHEDULER_LIST_SCHEDULES,
  SCHEDULER_GET_SCHEDULE,
]

/**
`ecr describe-images`。

`tag_status` は awsFlag を持たない。shorthand の `--filter tagStatus=<値>` へ合成する
（Athena の `query_execution_context` と同型）。`--filter` の `imageStatus` は公開しない
ため、未指定時は API 既定の ACTIVE のイメージだけが返る。

`image_ids` と `starting_token` は排他。ECR の API が `imageIds` 指定時に `nextToken` を
受け付けない（botocore のサービスモデル）ため、構文としては通っても実行できない。
*/
export const ECR_DESCRIBE_IMAGES: AllowlistEntry = {
  toolName: 'aws_ecr_describe_images',
  service: 'ecr',
  subcommand: 'describe-images',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    { name: 'repository_name', kind: 'string', required: true, awsFlag: '--repository-name' },
    {
      name: 'registry_id',
      kind: 'string',
      required: false,
      awsFlag: '--registry-id',
      pattern: /^\d{12}$/,
    },
    {
      name: 'image_ids',
      kind: 'shorthand-list',
      required: false,
      awsFlag: '--image-ids',
      elements: [
        { key: 'imageTag', field: 'image_tag' },
        { key: 'imageDigest', field: 'image_digest' },
      ],
    },
    {
      name: 'tag_status',
      kind: 'enum',
      required: false,
      values: ['TAGGED', 'UNTAGGED', 'ANY'],
    },
    {
      name: 'filter',
      kind: 'shorthand',
      required: false,
      awsFlag: '--filter',
      parts: [{ key: 'tagStatus', from: 'tag_status' }],
    },
    ...MAX_ITEMS_INPUTS,
  ],
  exclusive: [['image_ids', 'starting_token']],
}

const ECR_ENTRIES: readonly AllowlistEntry[] = [ECR_DESCRIBE_IMAGES]

/**
`ec2 describe-instances`。

応答が大きくなりやすいので、description で max_items か filters による絞り込みを促している。
`--dry-run` と `--include-managed-resources` は公開しない。
*/
export const EC2_DESCRIBE_INSTANCES: AllowlistEntry = {
  toolName: 'aws_ec2_describe_instances',
  service: 'ec2',
  subcommand: 'describe-instances',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [
    {
      name: 'instance_ids',
      kind: 'string-list',
      required: false,
      awsFlag: '--instance-ids',
      pattern: /^i-[0-9a-f]+$/,
    },
    {
      name: 'filters',
      kind: 'shorthand-list',
      required: false,
      awsFlag: '--filters',
      elements: [
        { key: 'Name', field: 'name' },
        { key: 'Values', field: 'values', list: true },
      ],
    },
    ...MAX_ITEMS_INPUTS,
  ],
}

const EC2_ENTRIES: readonly AllowlistEntry[] = [EC2_DESCRIBE_INSTANCES]

/**
公開するエントリの一覧。並びは契約表の順で、tools/list の並びもこれに従う。
*/
export const ALLOWLIST: readonly AllowlistEntry[] = [
  ...STS_ENTRIES,
  ...LAMBDA_ENTRIES,
  ...LOGS_ENTRIES,
  ...CLOUDWATCH_ENTRIES,
  ...SQS_ENTRIES,
  ...ATHENA_ENTRIES,
  ...S3_ENTRIES,
  ...RDS_ENTRIES,
  ...SCHEDULER_ENTRIES,
  ...ECR_ENTRIES,
  ...EC2_ENTRIES,
]

/**
ツール名からエントリを引く。見つからなければ undefined（呼び出し側が not-allowed にする）。
*/
export function findAllowlistEntry(
  toolName: string,
  entries: readonly AllowlistEntry[] = ALLOWLIST,
): AllowlistEntry | undefined {
  return entries.find(entry => entry.toolName === toolName)
}

import { describe, expect, it } from 'vitest'

import type { AllowlistEntry, InputSpec } from '../allowlist.js'
import { TIMESTAMP_PATTERN } from '../allowlist.js'
import { buildArguments, validateInput } from '../arguments.js'

/**
制御文字の代表。argv に載ると spawn が同期 throw する。
*/
const NUL = String.fromCodePoint(0)

function entryOf(overrides: Partial<AllowlistEntry> = {}): AllowlistEntry {
  return {
    toolName: 'test_tool',
    service: 'logs',
    subcommand: 'describe-log-groups',
    kind: 'read',
    jsonOutput: true,
    pagination: 'none',
    inputs: [],
    ...overrides,
  }
}

function inputOf(overrides: Partial<InputSpec> = {}): InputSpec {
  return { name: 'value', kind: 'string', required: false, awsFlag: '--value', ...overrides }
}

/**
awsFlag を持たない入力（位置引数・検証専用入力）。
*/
function bareInput(overrides: Partial<InputSpec> = {}): InputSpec {
  return { name: 'value', kind: 'string', required: false, ...overrides }
}

/**
shorthand（合成フラグ）と、その項目の取得元になる検証専用入力を持つエントリ。
*/
function shorthandEntry(): AllowlistEntry {
  return entryOf({
    service: 'athena',
    subcommand: 'start-query-execution',
    inputs: [
      bareInput({ name: 'database' }),
      bareInput({ name: 'catalog' }),
      {
        name: 'query_execution_context',
        kind: 'shorthand',
        required: false,
        awsFlag: '--query-execution-context',
        parts: [{ key: 'Database', from: 'database' }, { key: 'Catalog', from: 'catalog' }],
      },
    ],
  })
}

/**
shorthand-list（利用者がオブジェクトの配列で直接指定する入力）を持つエントリ。
*/
function shorthandListEntry(): AllowlistEntry {
  return entryOf({
    service: 'ec2',
    subcommand: 'describe-instances',
    inputs: [
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
    ],
  })
}

describe('buildArguments', () => {
  it('service / subcommand の後に --output json と --no-cli-pager を置く', () => {
    expect(buildArguments(entryOf(), {})).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('jsonOutput が false でも --no-cli-pager は常に付ける', () => {
    // 高レベルコマンド（s3 ls / s3 cp）は --output json を受け付けない。
    expect(buildArguments(entryOf({ service: 's3', subcommand: 'ls', jsonOutput: false }), {})).toEqual([
      's3', 'ls', '--no-cli-pager',
    ])
  })

  it('profile / region は指定時だけ末尾に付く', () => {
    expect(buildArguments(entryOf(), {}, { profile: 'dev', region: 'ap-northeast-1' })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager',
      '--profile', 'dev', '--region', 'ap-northeast-1',
    ])
    expect(buildArguments(entryOf(), {}, { profile: 'dev' })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager', '--profile', 'dev',
    ])
    expect(buildArguments(entryOf(), {}, { region: 'us-east-1' })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager', '--region', 'us-east-1',
    ])
  })

  it('エントリが --profile / --region を宣言しても末尾に 1 度だけ付ける', () => {
    // aws_sso_login のように inputs 側へ --profile を宣言するエントリでも、共通入力は
    // 末尾の 1 本だけにする。awscli は後勝ちだが、同じフラグが 2 度並ぶため。
    const entry = entryOf({
      service: 'sso',
      subcommand: 'login',
      inputs: [inputOf({ name: 'profile', awsFlag: '--profile' })],
    })

    expect(buildArguments(entry, { profile: 'dev' }, { profile: 'dev' })).toEqual([
      'sso', 'login', '--output', 'json', '--no-cli-pager', '--profile', 'dev',
    ])
  })

  it('位置引数を index 順にフラグより先へ置く', () => {
    // string-list の nargs は貪欲なので、位置引数を後ろに置くと awscli の argparse が取り違える。
    const entry = entryOf({
      service: 's3api',
      subcommand: 'get-object',
      inputs: [
        bareInput({ name: 'outfile', kind: 'abs-path', positional: 1 }),
        inputOf({ name: 'bucket', awsFlag: '--bucket' }),
        bareInput({ name: 'first', positional: 0 }),
      ],
    })

    expect(buildArguments(entry, { outfile: '/var/data/out.json', bucket: 'b', first: 'x' })).toEqual([
      's3api', 'get-object', 'x', '/var/data/out.json', '--bucket', 'b', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('boolean は --flag / --no-flag の両形を出す', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'descending', kind: 'boolean', awsFlag: '--descending' })] })

    expect(buildArguments(entry, { descending: true })).toContain('--descending')
    expect(buildArguments(entry, { descending: false })).toContain('--no-descending')
  })

  it('string-list は 1 要素 1 トークンで並べる', () => {
    const entry = entryOf({
      inputs: [inputOf({ name: 'log_stream_names', kind: 'string-list', awsFlag: '--log-stream-names' })],
    })

    expect(buildArguments(entry, { log_stream_names: ['a', 'b'] })).toEqual([
      'logs', 'describe-log-groups', '--log-stream-names', 'a', 'b', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('integer は文字列化して渡す', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'max_items', kind: 'integer', awsFlag: '--max-items' })] })

    expect(buildArguments(entry, { max_items: 50 })).toContain('50')
  })

  it('default は未指定のときだけ補う（string[] を含む）', () => {
    const entry = entryOf({
      inputs: [
        inputOf({ name: 'attribute_names', kind: 'string-list', awsFlag: '--attribute-names', default: ['All'] }),
        inputOf({ name: 'order_by', kind: 'enum', awsFlag: '--order-by', values: ['LogStreamName'], default: 'LogStreamName' }),
      ],
    })

    expect(buildArguments(entry, {})).toEqual([
      'logs', 'describe-log-groups',
      '--attribute-names', 'All',
      '--order-by', 'LogStreamName',
      '--output', 'json', '--no-cli-pager',
    ])
    expect(buildArguments(entry, { attribute_names: ['QueueArn', 'VisibilityTimeout'] })).toContain('QueueArn')
  })

  it('awsFlag と positional のどちらも持たない入力は引数に出さない', () => {
    // overwrite のような検証専用の入力。
    const entry = entryOf({ inputs: [bareInput({ name: 'overwrite', kind: 'boolean' })] })

    expect(buildArguments(entry, { overwrite: true })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('引数に載せられない型の値は無視する', () => {
    // 検証を通っていれば起きないが、buildArguments 単体では素通しさせない。
    const entry = entryOf({ inputs: [inputOf({ name: 'value' })] })

    expect(buildArguments(entry, { value: { nested: true } })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('位置引数が未指定なら位置ごと省く', () => {
    const entry = entryOf({
      service: 's3',
      subcommand: 'ls',
      jsonOutput: false,
      inputs: [bareInput({ name: 's3_uri', kind: 's3-list-uri', positional: 0 })],
    })

    expect(buildArguments(entry, {})).toEqual(['s3', 'ls', '--no-cli-pager'])
    expect(buildArguments(entry, { s3_uri: 's3://bucket/prefix/' }))
      .toEqual(['s3', 'ls', 's3://bucket/prefix/', '--no-cli-pager'])
  })

  it('\'-\' 始まりの値は --flag=value の 1 トークンにする', () => {
    // 別トークンで渡すと awscli の argparse が値をオプションとして読む。
    const entry = entryOf({ inputs: [inputOf({ name: 'filter_pattern', awsFlag: '--filter-pattern' })] })

    expect(buildArguments(entry, { filter_pattern: '-INFO' })).toEqual([
      'logs', 'describe-log-groups', '--filter-pattern=-INFO', '--output', 'json', '--no-cli-pager',
    ])
    expect(buildArguments(entry, { filter_pattern: 'ERROR' })).toEqual([
      'logs', 'describe-log-groups', '--filter-pattern', 'ERROR', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('末尾の profile / region も \'-\' 始まりなら 1 トークンにする', () => {
    expect(buildArguments(entryOf(), {}, { profile: '-dev' })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager', '--profile=-dev',
    ])
  })

  it('shorthand は値を持つ項目だけを Key=value で並べる', () => {
    expect(buildArguments(shorthandEntry(), { database: 'analytics', catalog: 'awsdatacatalog' })).toEqual([
      'athena', 'start-query-execution',
      '--query-execution-context', 'Database=analytics,Catalog=awsdatacatalog',
      '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand の項目が片方だけでもその 1 件を載せる', () => {
    expect(buildArguments(shorthandEntry(), { catalog: 'awsdatacatalog' })).toEqual([
      'athena', 'start-query-execution',
      '--query-execution-context', 'Catalog=awsdatacatalog',
      '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand の項目が 1 つも無ければフラグごと省く', () => {
    expect(buildArguments(shorthandEntry(), {})).toEqual([
      'athena', 'start-query-execution', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand 自身を入力で指定しても引数には出さない', () => {
    // 合成の材料は parts の from だけ。利用者が shorthand 名で値を送っても素通ししない。
    expect(buildArguments(shorthandEntry(), { query_execution_context: 'Database=injected' })).toEqual([
      'athena', 'start-query-execution', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list は配列全体を JSON の 1 トークンにする', () => {
    // list 項目は JSON の配列のまま載る（shorthand の `Values=a,b` 連結は使わない）。
    expect(buildArguments(shorthandListEntry(), {
      filters: [
        { name: 'instance-state-name', values: ['running', 'stopped'] },
        { name: 'tag:Name', values: ['order-api-01'] },
      ],
    })).toEqual([
      'ec2', 'describe-instances',
      '--filters',
      '[{"Name":"instance-state-name","Values":["running","stopped"]},{"Name":"tag:Name","Values":["order-api-01"]}]',
      '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list は宣言順の項目だけを載せる', () => {
    // 要素の中のキーの並びに依らず、elements の宣言順で JSON のキーが並ぶ。
    expect(buildArguments(shorthandListEntry(), { filters: [{ values: ['running'], name: 'state' }] })).toEqual([
      'ec2', 'describe-instances',
      '--filters', '[{"Name":"state","Values":["running"]}]',
      '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list が空配列ならフラグごと省く', () => {
    expect(buildArguments(shorthandListEntry(), { filters: [] })).toEqual([
      'ec2', 'describe-instances', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list の値が配列でなければフラグごと省く', () => {
    // 検証を通っていれば起きないが、buildArguments 単体では素通しさせない。
    expect(buildArguments(shorthandListEntry(), { filters: '[{"Name":"state"}]' })).toEqual([
      'ec2', 'describe-instances', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list の値を持たない要素は落とす', () => {
    // 非オブジェクトの要素・空の要素・list 項目が空配列の要素は JSON に残らない。
    expect(buildArguments(shorthandListEntry(), {
      filters: ['Name=state', {}, { values: [] }],
    })).toEqual([
      'ec2', 'describe-instances', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list の項目値の , = { } は JSON にエスケープして載せる', () => {
    // 組み立てが JSON.stringify なので区切り文字の解釈が無く、`,` を含むタグ値も渡せる。
    expect(buildArguments(shorthandListEntry(), {
      filters: [{ name: 'tag:Name', values: ['a,b', 'c={d}'] }],
    })).toEqual([
      'ec2', 'describe-instances',
      '--filters', '[{"Name":"tag:Name","Values":["a,b","c={d}"]}]',
      '--output', 'json', '--no-cli-pager',
    ])
  })
})

describe('validateInput', () => {
  it('必須入力が無ければ invalid-input', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'function_name', required: true })] })

    expect(validateInput(entry, {})).toMatchObject({ category: 'invalid-input' })
    expect(validateInput(entry, {})?.message).toContain('function_name')
  })

  it('任意入力が無ければ通す', () => {
    const entry = entryOf({ inputs: [inputOf()] })
    expect(validateInput(entry, {})).toBeUndefined()
  })

  it('フラグを持たない string の先頭 \'-\' を拒否する', () => {
    // 位置引数・検証専用入力には `--flag=value` の逃がし先が無い。
    const entry = entryOf({ inputs: [bareInput()] })

    expect(validateInput(entry, { value: '--debug' })?.message).toContain('\'-\'')
    expect(validateInput(entry, { value: 'ok' })).toBeUndefined()
  })

  it('位置引数は awsFlag があっても先頭 \'-\' を拒否する', () => {
    const entry = entryOf({ inputs: [bareInput({ name: 's3_uri', kind: 's3-list-uri', positional: 0 })] })

    expect(validateInput(entry, { s3_uri: '-x' })?.message).toContain('\'-\'')
  })

  it('フラグで渡す string は先頭 \'-\' を通す', () => {
    // CloudWatch Logs の除外パターン（-INFO）。組み立ては --flag=value の 1 トークン形になる。
    const entry = entryOf({ inputs: [inputOf({ name: 'filter_pattern', awsFlag: '--filter-pattern' })] })

    expect(validateInput(entry, { filter_pattern: '-INFO' })).toBeUndefined()
  })

  it('string-list の各要素についても先頭 \'-\' を拒否する', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'names', kind: 'string-list' })] })

    expect(validateInput(entry, { names: ['ok', '--debug'] })?.message).toContain('\'-\'')
    expect(validateInput(entry, { names: ['ok', 'fine'] })).toBeUndefined()
  })

  it('abs-path は絶対パスだけを受ける', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'outfile', kind: 'abs-path' })] })

    expect(validateInput(entry, { outfile: '/var/data/a.json' })).toBeUndefined()
    expect(validateInput(entry, { outfile: 'relative/a.json' })?.message).toContain('絶対パス')
  })

  it('s3-uri はバケットとキーの双方を求める', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 's3_uri', kind: 's3-uri' })] })

    expect(validateInput(entry, { s3_uri: 's3://bucket/key.txt' })).toBeUndefined()
    expect(validateInput(entry, { s3_uri: 's3://bucket' })?.message).toContain('s3://')
    expect(validateInput(entry, { s3_uri: '/local/path' })?.message).toContain('s3://')
  })

  it('integer は整数と min / max を見る', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'limit', kind: 'integer', min: 1, max: 10_000 })] })

    expect(validateInput(entry, { limit: 100 })).toBeUndefined()
    expect(validateInput(entry, { limit: 1.5 })?.message).toContain('整数')
    expect(validateInput(entry, { limit: 0 })?.message).toContain('1 以上')
    expect(validateInput(entry, { limit: 10_001 })?.message).toContain('10000 以下')
    expect(validateInput(entry, { limit: '10' })?.message).toContain('整数')
  })

  it('enum は values の中だけを受ける', () => {
    const entry = entryOf({
      inputs: [inputOf({ name: 'order_by', kind: 'enum', values: ['LogStreamName', 'LastEventTime'] })],
    })

    expect(validateInput(entry, { order_by: 'LastEventTime' })).toBeUndefined()
    expect(validateInput(entry, { order_by: 'Other' })?.message).toContain('order_by')
    expect(validateInput(entry, { order_by: 7 })?.message).toContain('文字列')
  })

  it('values を持たない enum は全て拒否する', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'order_by', kind: 'enum' })] })

    expect(validateInput(entry, { order_by: 'LogStreamName' })?.category).toBe('invalid-input')
  })

  it('boolean は真偽値だけを受ける', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'overwrite', kind: 'boolean' })] })

    expect(validateInput(entry, { overwrite: false })).toBeUndefined()
    expect(validateInput(entry, { overwrite: 'true' })?.message).toContain('true / false')
  })

  it('string 系に非文字列を渡すと拒否する', () => {
    const stringEntry = entryOf({ inputs: [inputOf()] })
    const listEntry = entryOf({ inputs: [inputOf({ name: 'names', kind: 'string-list' })] })
    expect(validateInput(stringEntry, { value: 1 })?.message).toContain('文字列')
    expect(validateInput(listEntry, { names: 'a' })?.message).toContain('配列')
    expect(validateInput(listEntry, { names: [1] })?.message).toContain('配列')
  })

  it('pattern 付き string は書式を見る', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 'queue_url', pattern: /^https:\/\// })] })

    expect(validateInput(entry, { queue_url: 'https://sqs.example/q' })).toBeUndefined()
    expect(validateInput(entry, { queue_url: 'http://sqs.example/q' })?.message).toContain('形式')
  })

  it('exclusive の同時指定を拒否する', () => {
    const entry = entryOf({
      inputs: [inputOf({ name: 'names', kind: 'string-list' }), inputOf({ name: 'prefix' })],
      exclusive: [['names', 'prefix']],
    })

    expect(validateInput(entry, { names: ['a'] })).toBeUndefined()
    expect(validateInput(entry, { names: ['a'], prefix: 'p' })?.message).toContain('同時に指定できません')
  })

  it('s3-list-uri はバケット指定と prefix 指定を受ける', () => {
    const entry = entryOf({ inputs: [inputOf({ name: 's3_uri', kind: 's3-list-uri' })] })

    expect(validateInput(entry, { s3_uri: 's3://bucket' })).toBeUndefined()
    expect(validateInput(entry, { s3_uri: 's3://bucket/prefix/' })).toBeUndefined()
    expect(validateInput(entry, { s3_uri: '/local/path' })?.message).toContain('s3://')
  })

  it('shorthand の項目値に , = { } を含めば拒否する', () => {
    // 素通しすると `OutputLocation=s3://b/p,ExpectedBucketOwner=…` のように契約外のキーを
    // 足せる（実 awscli が受理することを確認済み）。
    const entry = shorthandEntry()

    expect(validateInput(entry, { database: 'analytics' })).toBeUndefined()
    expect(validateInput(entry, { database: 'a,Catalog=x' })?.message).toContain(', = { }')
    expect(validateInput(entry, { catalog: 'x=y' })?.category).toBe('invalid-input')
    expect(validateInput(entry, { catalog: 'x{y}' })?.category).toBe('invalid-input')
  })

  it('shorthand 自身は入力レコードから読まない', () => {
    // 利用者が shorthand 名で値を送っても、見るのは項目の from だけ。検証と組み立ての両方で同じ。
    expect(validateInput(shorthandEntry(), { query_execution_context: 'Database=a,Catalog=b' }))
      .toBeUndefined()
  })

  it('string-list に values があれば要素ごとに values と比べる', () => {
    // awscli は列挙をクライアント側で検証しない（--statistics Bogus も構文としては通る）。
    const entry = entryOf({
      inputs: [inputOf({
        name: 'statistics',
        kind: 'string-list',
        values: ['Sum', 'Average'],
      })],
    })

    expect(validateInput(entry, { statistics: ['Sum', 'Average'] })).toBeUndefined()
    expect(validateInput(entry, { statistics: ['Sum', 'Bogus'] })?.message).toContain('Bogus')
  })

  it('shorthand-list はオブジェクトの配列だけを受ける', () => {
    const entry = shorthandListEntry()

    expect(validateInput(entry, { filters: [{ name: 'state', values: ['running'] }] })).toBeUndefined()
    expect(validateInput(entry, { filters: 'Name=state' })?.message).toContain('オブジェクトの配列')
    expect(validateInput(entry, { filters: ['Name=state'] })?.message).toContain('オブジェクト')
    expect(validateInput(entry, { filters: [['state']] })?.message).toContain('オブジェクト')
  })

  it('shorthand-list の項目の型を見る', () => {
    const entry = shorthandListEntry()

    expect(validateInput(entry, { filters: [{ name: 7, values: ['a'] }] })?.message).toContain('文字列')
    expect(validateInput(entry, { filters: [{ name: 'state', values: 'a' }] })?.message)
      .toContain('文字列の配列')
    expect(validateInput(entry, { filters: [{ name: 'state', values: [] }] })?.message)
      .toContain('1 つ以上')
  })

  it('shorthand-list の項目値に空文字を許さない', () => {
    // 空文字は awscli が空値として解釈する。通常項目と list 項目の双方で弾く。
    const entry = shorthandListEntry()

    expect(validateInput(entry, { filters: [{ name: '' }] })?.message).toContain('空文字')
    expect(validateInput(entry, { filters: [{ name: 'state', values: [''] }] })?.message)
      .toContain('空文字')
  })

  it('shorthand-list の項目値の , = { } は受理する', () => {
    // JSON 組み立てでは区切り文字が構文へ漏れないので、`,` を含むタグ値も通す。
    const entry = shorthandListEntry()

    expect(validateInput(entry, { filters: [{ name: 'tag:Name', values: ['a,b'] }] })).toBeUndefined()
    expect(validateInput(entry, { filters: [{ name: 'a=b' }] })).toBeUndefined()
    expect(validateInput(entry, { filters: [{ name: 'a{b}' }] })).toBeUndefined()
  })

  it('制御文字を含む値を拒否する', () => {
    // argv に NUL を載せると spawn が同期 throw し、ExecutionResult を伴わない応答になる。
    const stringEntry = entryOf({ inputs: [inputOf({ name: 'log_group_name' })] })
    const listEntry = entryOf({ inputs: [inputOf({ name: 'names', kind: 'string-list' })] })
    const listValue = shorthandListEntry()

    expect(validateInput(stringEntry, { log_group_name: `g${NUL}x` })?.message).toContain('制御文字')
    expect(validateInput(listEntry, { names: [`a${NUL}b`] })?.category).toBe('invalid-input')
    expect(validateInput(listValue, { filters: [{ name: `state${NUL}` }] })?.message)
      .toContain('制御文字')
    expect(validateInput(listValue, { filters: [{ name: 'state', values: [`a${NUL}`] }] })?.message)
      .toContain('制御文字')
  })

  it('shorthand-list の要素は 1 項目以上を求める', () => {
    // 空の要素を渡すと awscli が空の JSON オブジェクトを受け取り、意図しない絞り込みになる。
    expect(validateInput(shorthandListEntry(), { filters: [{}] })?.message).toContain('name / values')
  })

  it('TIMESTAMP_PATTERN はタイムゾーン付きの ISO 8601 だけを受ける', () => {
    // タイムゾーンを欠いた形と epoch ミリ秒は description が示す書式の外にある。
    const entry = entryOf({ inputs: [inputOf({ name: 'start_time', pattern: TIMESTAMP_PATTERN })] })

    expect(validateInput(entry, { start_time: '2026-09-01T00:00:00Z' })).toBeUndefined()
    expect(validateInput(entry, { start_time: '2026-09-01T09:00:00+09:00' })).toBeUndefined()
    expect(validateInput(entry, { start_time: '2026-09-01T00:00:00' })?.message).toContain('形式が不正')
    expect(validateInput(entry, { start_time: '1756684800000' })?.message).toContain('形式が不正')
  })

  it('profile / region も同じ手順で検証する', () => {
    const entry = entryOf()

    expect(validateInput(entry, { profile: 'dev-1' })).toBeUndefined()
    expect(validateInput(entry, { profile: 'dev account' })?.message).toContain('profile')
    expect(validateInput(entry, { region: 'tokyo' })?.message).toContain('region')
  })
})

import { describe, expect, it } from 'vitest'

import type { AllowlistEntry, InputSpec } from '../allowlist.js'
import { TIMESTAMP_PATTERN } from '../allowlist.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { verifies } from '../../../tests/_helpers/verifies.js'
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
  it('引数を組み立てると、service と subcommand の後に --output json と --no-cli-pager を置く', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。入力が空の場合に、`logs describe-log-groups` の後ろへ `--output json` と `--no-cli-pager` が続く並びになることを確認します。')
    expect(buildArguments(entryOf(), {})).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('jsonOutput が false のコマンドでも、--no-cli-pager は常に付け、--output json は付けない', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。高レベルコマンドの `s3 ls` のように `jsonOutput` が偽の場合に、`--output json` は付かず、`--no-cli-pager` だけが付くことを確認します。')
    // 高レベルコマンド（s3 ls）は --output json を受け付けない。
    expect(buildArguments(entryOf({ service: 's3', subcommand: 'ls', jsonOutput: false }), {})).toEqual([
      's3', 'ls', '--no-cli-pager',
    ])
  })

  it('profile と region を指定したときだけ、引数の末尾に付ける', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`profile` と `region` の両方、`profile` だけ、`region` だけを指定した場合に、指定したものだけが引数の末尾に付くことを確認します。')
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

  it('エントリが --profile を入力として宣言していても、引数の末尾に 1 回だけ付ける', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`aws_sso_login` のように入力側にも `--profile` を宣言したエントリで、同じフラグが 2 回並ばず、末尾の 1 回だけになることを確認します。')
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

  it('位置引数は、位置の番号の順にして、フラグより先に置く', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。位置の番号が 1、0 の順で宣言された入力を渡した場合に、番号の昇順で並び、`--bucket` などのフラグより前に置かれることを確認します。')
    // string-list の nargs は貪欲なので、位置引数を後ろに置くと awscli の argparse が取り違える。
    const entry = entryOf({
      service: 'svc',
      subcommand: 'op',
      inputs: [
        bareInput({ name: 'second', positional: 1 }),
        inputOf({ name: 'bucket', awsFlag: '--bucket' }),
        bareInput({ name: 'first', positional: 0 }),
      ],
    })

    expect(buildArguments(entry, { second: 'y', bucket: 'b', first: 'x' })).toEqual([
      'svc', 'op', 'x', 'y', '--bucket', 'b', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('boolean の入力は、true なら --flag、false なら --no-flag の形で渡す', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`descending` に `true` を渡した場合は `--descending`、`false` を渡した場合は `--no-descending` が引数に含まれることを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 'descending', kind: 'boolean', awsFlag: '--descending' })] })

    expect(buildArguments(entry, { descending: true })).toContain('--descending')
    expect(buildArguments(entry, { descending: false })).toContain('--no-descending')
  })

  it('string-list の入力は、要素ごとに 1 つの引数として並べる', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`log_stream_names` に 2 つの要素を渡した場合に、フラグの後ろへ要素が 1 つずつ別の引数として並ぶことを確認します。')
    const entry = entryOf({
      inputs: [inputOf({ name: 'log_stream_names', kind: 'string-list', awsFlag: '--log-stream-names' })],
    })

    expect(buildArguments(entry, { log_stream_names: ['a', 'b'] })).toEqual([
      'logs', 'describe-log-groups', '--log-stream-names', 'a', 'b', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('integer の入力は、文字列に変換して引数に含める', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`max_items` に数値の `50` を渡した場合に、文字列の `50` が引数に含まれることを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 'max_items', kind: 'integer', awsFlag: '--max-items' })] })

    expect(buildArguments(entry, { max_items: 50 })).toContain('50')
  })

  it('入力が指定されていないときだけ、default の値を引数に補う', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。入力が空の場合は `string-list` と `enum` の既定値が引数に補われ、値を指定した場合は指定した値が使われることを確認します。')
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

  it('awsFlag と positional のどちらも持たない入力は、引数に含めない', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。検証専用の `overwrite` に `true` を渡した場合でも、引数にフラグが含まれないことを確認します。')
    // overwrite のような検証専用の入力。
    const entry = entryOf({ inputs: [bareInput({ name: 'overwrite', kind: 'boolean' })] })

    expect(buildArguments(entry, { overwrite: true })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('引数にできない型の値は、無視して引数に含めない', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。文字列を受ける入力にオブジェクトを渡した場合に、その入力が引数に含まれないことを確認します。')
    // 検証を通っていれば起きないが、buildArguments 単体では素通しさせない。
    const entry = entryOf({ inputs: [inputOf({ name: 'value' })] })

    expect(buildArguments(entry, { value: { nested: true } })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('位置引数が指定されていないときは、その位置の引数を含めない', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`s3_uri` を指定しない場合は `s3 ls` だけになり、指定した場合は `s3://bucket/prefix/` が `s3 ls` の直後に置かれることを確認します。')
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

  it('先頭が - の値は、--flag=value の 1 つの引数にして渡す', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`filter_pattern` が `-INFO` の場合は `--filter-pattern=-INFO` の 1 つの引数になり、`ERROR` のような通常の値は 2 つの引数になることを確認します。')
    // 別トークンで渡すと awscli の argparse が値をオプションとして読む。
    const entry = entryOf({ inputs: [inputOf({ name: 'filter_pattern', awsFlag: '--filter-pattern' })] })

    expect(buildArguments(entry, { filter_pattern: '-INFO' })).toEqual([
      'logs', 'describe-log-groups', '--filter-pattern=-INFO', '--output', 'json', '--no-cli-pager',
    ])
    expect(buildArguments(entry, { filter_pattern: 'ERROR' })).toEqual([
      'logs', 'describe-log-groups', '--filter-pattern', 'ERROR', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('末尾に付ける profile も、先頭が - の値なら --profile=値 の 1 つの引数にする', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`profile` に `-dev` を渡した場合に、`--profile=-dev` の 1 つの引数として末尾に付くことを確認します。')
    expect(buildArguments(entryOf(), {}, { profile: '-dev' })).toEqual([
      'logs', 'describe-log-groups', '--output', 'json', '--no-cli-pager', '--profile=-dev',
    ])
  })

  it('shorthand の入力は、値を指定した項目を Key=value の形で連結して渡す', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`database` と `catalog` を指定した場合は、`--query-execution-context` が `Database=…,Catalog=…` の形になることを確認します。')
    expect(buildArguments(shorthandEntry(), { database: 'analytics', catalog: 'awsdatacatalog' })).toEqual([
      'athena', 'start-query-execution',
      '--query-execution-context', 'Database=analytics,Catalog=awsdatacatalog',
      '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand の項目のうち 1 つだけを指定したときも、その 1 つを引数に含める', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`catalog` だけを指定した場合に、`--query-execution-context` の値が `Catalog=awsdatacatalog` になることを確認します。')
    expect(buildArguments(shorthandEntry(), { catalog: 'awsdatacatalog' })).toEqual([
      'athena', 'start-query-execution',
      '--query-execution-context', 'Catalog=awsdatacatalog',
      '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand の項目を 1 つも指定していないときは、フラグごと引数に含めない', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。shorthand の項目をどれも指定しない場合に、`--query-execution-context` が引数に含まれないことを確認します。')
    expect(buildArguments(shorthandEntry(), {})).toEqual([
      'athena', 'start-query-execution', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand の入力名で直接値を指定しても、引数に含めない', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。利用者が `query_execution_context` に `Database=injected` を直接渡した場合に、その値が引数に含まれないことを確認します。')
    // 合成の材料は parts の from だけ。利用者が shorthand 名で値を送っても素通ししない。
    expect(buildArguments(shorthandEntry(), { query_execution_context: 'Database=injected' })).toEqual([
      'athena', 'start-query-execution', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list の入力は、配列全体を JSON の 1 つの引数にして渡す', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。2 件の条件を持つ `filters` を渡した場合に、`--filters` の値が `Name` と `Values` を持つ JSON の配列の 1 つの引数になることを確認します。')
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

  it('shorthand-list の入力は、要素のキーの順にかかわらず、宣言した順に JSON のキーを並べる', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`values` を `name` より先に書いた要素を渡した場合でも、JSON のキーが `Name`、`Values` の宣言順に並ぶことを確認します。')
    // 要素の中のキーの並びに依らず、elements の宣言順で JSON のキーが並ぶ。
    expect(buildArguments(shorthandListEntry(), { filters: [{ values: ['running'], name: 'state' }] })).toEqual([
      'ec2', 'describe-instances',
      '--filters', '[{"Name":"state","Values":["running"]}]',
      '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list の入力が空の配列のときは、フラグごと引数に含めない', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`filters` に空の配列を渡した場合に、`--filters` が引数に含まれないことを確認します。')
    expect(buildArguments(shorthandListEntry(), { filters: [] })).toEqual([
      'ec2', 'describe-instances', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list の入力が配列でないときは、フラグごと引数に含めない', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`filters` に文字列を渡した場合に、`--filters` が引数に含まれないことを確認します。')
    // 検証を通っていれば起きないが、buildArguments 単体では素通しさせない。
    expect(buildArguments(shorthandListEntry(), { filters: '[{"Name":"state"}]' })).toEqual([
      'ec2', 'describe-instances', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list の要素のうち、値を持たないものは JSON から除外する', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。文字列の要素、空のオブジェクト、`values` が空の配列の要素だけを渡した場合に、`--filters` が引数に含まれないことを確認します。')
    // 非オブジェクトの要素・空の要素・list 項目が空配列の要素は JSON に残らない。
    expect(buildArguments(shorthandListEntry(), {
      filters: ['Name=state', {}, { values: [] }],
    })).toEqual([
      'ec2', 'describe-instances', '--output', 'json', '--no-cli-pager',
    ])
  })

  it('shorthand-list の項目値に , = { } を含んでいても、JSON の文字列として渡す', async () => {
    await explains('awscli に渡す引数を組み立てる `buildArguments` のテストです。`a,b` や `c={d}` のように区切り文字を含む値を渡した場合に、そのまま JSON の文字列に入り、`--filters` の 1 つの引数になることを確認します。')
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
  it('必須の入力が指定されていないときは、invalid-input を返す', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。必須の `function_name` を指定しない場合に、種類が `invalid-input` で、メッセージに `function_name` を含む失敗を返すことを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 'function_name', required: true })] })

    expect(validateInput(entry, {})).toMatchObject({ kind: 'invalid-input' })
    expect(validateInput(entry, {})?.message).toContain('function_name')
  })

  it('任意の入力が指定されていなくても、検証を通す', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。必須でない入力を指定しない場合に、失敗を返さず `undefined` を返すことを確認します。')
    const entry = entryOf({ inputs: [inputOf()] })
    expect(validateInput(entry, {})).toBeUndefined()
  })

  it('フラグを持たない string の入力は、先頭が - の値を拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。位置引数のようにフラグを持たない入力に `--debug` を渡した場合は、`-` で始まることを示すエラーを返し、`ok` のような通常の値は通すことを確認します。')
    // 位置引数・検証専用入力には `--flag=value` の逃がし先が無い。
    const entry = entryOf({ inputs: [bareInput()] })

    expect(validateInput(entry, { value: '--debug' })?.message).toContain('\'-\'')
    expect(validateInput(entry, { value: 'ok' })).toBeUndefined()
  })

  it('位置引数は、awsFlag を持っていても、先頭が - の値を拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`awsFlag` を持つ位置引数の `s3_uri` に `-x` を渡した場合に、`-` で始まることを示すエラーを返すことを確認します。')
    const entry = entryOf({ inputs: [bareInput({ name: 's3_uri', kind: 's3-list-uri', positional: 0 })] })

    expect(validateInput(entry, { s3_uri: '-x' })?.message).toContain('\'-\'')
  })

  it('フラグで渡す string の入力は、先頭が - の値を受け付ける', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。CloudWatch Logs の除外パターンである `-INFO` を `filter_pattern` へ渡した場合は、エラーを返さないことを確認します。')
    // CloudWatch Logs の除外パターン（-INFO）。組み立ては --flag=value の 1 トークン形になる。
    const entry = entryOf({ inputs: [inputOf({ name: 'filter_pattern', awsFlag: '--filter-pattern' })] })

    expect(validateInput(entry, { filter_pattern: '-INFO' })).toBeUndefined()
  })

  it('string-list の入力は、要素のどれかの先頭が - なら拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`names` の要素に `--debug` を含めた場合は、`-` で始まることを示すエラーを返し、通常の値だけなら通すことを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 'names', kind: 'string-list' })] })

    expect(validateInput(entry, { names: ['ok', '--debug'] })?.message).toContain('\'-\'')
    expect(validateInput(entry, { names: ['ok', 'fine'] })).toBeUndefined()
  })

  it('integer の入力は、整数であることと min と max の範囲内であることを検証する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。範囲が 1 から 10000 の `limit` に対して、`100` は通し、小数、範囲外の値、文字列の `10` には、それぞれ原因を示すエラーを返すことを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 'limit', kind: 'integer', min: 1, max: 10_000 })] })

    expect(validateInput(entry, { limit: 100 })).toBeUndefined()
    expect(validateInput(entry, { limit: 1.5 })?.message).toContain('must be an integer')
    expect(validateInput(entry, { limit: 0 })?.message).toContain('must be at least 1')
    expect(validateInput(entry, { limit: 10_001 })?.message).toContain('must be at most 10000')
    expect(validateInput(entry, { limit: '10' })?.message).toContain('must be an integer')
  })

  it('enum の入力は、values に含まれる値だけを受け付ける', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`LastEventTime` は通し、`values` に含まれない `Other` と文字列でない `7` は、エラーを返すことを確認します。')
    const entry = entryOf({
      inputs: [inputOf({ name: 'order_by', kind: 'enum', values: ['LogStreamName', 'LastEventTime'] })],
    })

    expect(validateInput(entry, { order_by: 'LastEventTime' })).toBeUndefined()
    expect(validateInput(entry, { order_by: 'Other' })?.message).toContain('order_by')
    expect(validateInput(entry, { order_by: 7 })?.message).toContain('must be a string')
  })

  it('values を持たない enum の入力は、どの値も拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`values` を宣言していない `enum` の入力に `LogStreamName` を渡した場合に、種類が `invalid-input` の失敗を返すことを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 'order_by', kind: 'enum' })] })

    expect(validateInput(entry, { order_by: 'LogStreamName' })?.kind).toBe('invalid-input')
  })

  it('boolean の入力は、真偽値だけを受け付ける', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`false` は通し、文字列の `true` は、`must be true or false` を含むエラーで拒否することを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 'overwrite', kind: 'boolean' })] })

    expect(validateInput(entry, { overwrite: false })).toBeUndefined()
    expect(validateInput(entry, { overwrite: 'true' })?.message).toContain('must be true or false')
  })

  it('string と string-list の入力に、文字列でない値を渡すと拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`string` の入力に数値を渡した場合と、`string-list` の入力に文字列や数値の要素を渡した場合に、型が不正であることを示すエラーを返すことを確認します。')
    const stringEntry = entryOf({ inputs: [inputOf()] })
    const listEntry = entryOf({ inputs: [inputOf({ name: 'names', kind: 'string-list' })] })
    expect(validateInput(stringEntry, { value: 1 })?.message).toContain('must be a string')
    expect(validateInput(listEntry, { names: 'a' })?.message).toContain('must be an array of strings')
    expect(validateInput(listEntry, { names: [1] })?.message).toContain('must be an array of strings')
  })

  it('pattern を持つ string の入力は、書式に合わない値を拒否する', async (context) => {
    await verifies(context, 'PT-COMMON-14')
    await explains('ツールの入力を検証する `validateInput` のテストです。書式を指定した `queue_url` で、`https://` で始まる値は通し、`http://` で始まる値は `invalid format` を含むエラーで拒否することを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 'queue_url', pattern: /^https:\/\// })] })

    expect(validateInput(entry, { queue_url: 'https://sqs.example/q' })).toBeUndefined()
    expect(validateInput(entry, { queue_url: 'http://sqs.example/q' })?.message).toContain('invalid format')
  })

  it('exclusive に指定した入力を同時に渡すと、拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`names` と `prefix` を排他にした場合は、片方だけなら通し、両方を指定すると `cannot be combined` を含むエラーを返すことを確認します。')
    const entry = entryOf({
      inputs: [inputOf({ name: 'names', kind: 'string-list' }), inputOf({ name: 'prefix' })],
      exclusive: [['names', 'prefix']],
    })

    expect(validateInput(entry, { names: ['a'] })).toBeUndefined()
    expect(validateInput(entry, { names: ['a'], prefix: 'p' })?.message).toContain('cannot be combined')
  })

  it('s3-list-uri の入力は、s3:// で始まる値だけを受け付ける', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`s3://bucket` と `s3://bucket/prefix/` は通し、ローカルパスの `/local/path` は `s3://` を含むエラーで拒否することを確認します。')
    const entry = entryOf({ inputs: [inputOf({ name: 's3_uri', kind: 's3-list-uri' })] })

    expect(validateInput(entry, { s3_uri: 's3://bucket' })).toBeUndefined()
    expect(validateInput(entry, { s3_uri: 's3://bucket/prefix/' })).toBeUndefined()
    expect(validateInput(entry, { s3_uri: '/local/path' })?.message).toContain('s3://')
  })

  it('shorthand の項目値に , = { } を含むときは、拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`database` などに `a,Catalog=x` や `x=y` のような区切り文字を含む値を渡した場合は、種類が `invalid-input` の失敗を返すことを確認します。')
    // 素通しすると `OutputLocation=s3://b/p,ExpectedBucketOwner=…` のように契約外のキーを
    // 足せる（実 awscli が受理することを確認済み）。
    const entry = shorthandEntry()

    expect(validateInput(entry, { database: 'analytics' })).toBeUndefined()
    expect(validateInput(entry, { database: 'a,Catalog=x' })?.message).toContain(', = { }')
    expect(validateInput(entry, { catalog: 'x=y' })?.kind).toBe('invalid-input')
    expect(validateInput(entry, { catalog: 'x{y}' })?.kind).toBe('invalid-input')
  })

  it('shorthand の入力名で直接値を指定しても、検証では読まない', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`query_execution_context` に `Database=a,Catalog=b` を直接渡した場合に、その値を検証の対象にせず、エラーを返さないことを確認します。')
    // 利用者が shorthand 名で値を送っても、見るのは項目の from だけ。検証と組み立ての両方で同じ。
    expect(validateInput(shorthandEntry(), { query_execution_context: 'Database=a,Catalog=b' }))
      .toBeUndefined()
  })

  it('values を持つ string-list の入力は、各要素が values の中にあるか検証する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`statistics` に `Sum` と `Average` を渡した場合は通し、`values` に含まれない `Bogus` を含む場合は、メッセージに `Bogus` を含むエラーを返すことを確認します。')
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

  it('shorthand-list の入力は、オブジェクトの配列だけを受け付ける', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`name` と `values` を持つオブジェクトの配列は通し、文字列、文字列の配列、配列の配列は、型が不正であることを示すエラーで拒否することを確認します。')
    const entry = shorthandListEntry()

    expect(validateInput(entry, { filters: [{ name: 'state', values: ['running'] }] })).toBeUndefined()
    expect(validateInput(entry, { filters: 'Name=state' })?.message).toContain('must be an array of objects')
    expect(validateInput(entry, { filters: ['Name=state'] })?.message).toContain('must be an object')
    expect(validateInput(entry, { filters: [['state']] })?.message).toContain('must be an object')
  })

  it('shorthand-list の要素は、項目の型が合わないときと values が空のときに拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`name` に数値、`values` に文字列を渡した場合は型のエラーを返し、`values` が空の配列の場合は `at least one value` を含むエラーを返すことを確認します。')
    const entry = shorthandListEntry()

    expect(validateInput(entry, { filters: [{ name: 7, values: ['a'] }] })?.message).toContain('must be a string')
    expect(validateInput(entry, { filters: [{ name: 'state', values: 'a' }] })?.message)
      .toContain('must be an array of strings')
    expect(validateInput(entry, { filters: [{ name: 'state', values: [] }] })?.message)
      .toContain('at least one value')
  })

  it('shorthand-list の要素の項目値が空文字のときは、拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`name` や `values` の要素に空文字を渡した場合に、`must not be empty` を含むエラーを返すことを確認します。')
    // 空文字は awscli が空値として解釈する。通常項目と list 項目の双方で弾く。
    const entry = shorthandListEntry()

    expect(validateInput(entry, { filters: [{ name: '' }] })?.message).toContain('must not be empty')
    expect(validateInput(entry, { filters: [{ name: 'state', values: [''] }] })?.message)
      .toContain('must not be empty')
  })

  it('shorthand-list の要素の項目値に , = { } を含んでいても、受け付ける', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`a,b`、`a=b`、`a{b}` のように区切り文字を含む値を渡した場合に、JSON として組み立てるためエラーを返さないことを確認します。')
    // JSON 組み立てでは区切り文字が構文へ漏れないので、`,` を含むタグ値も通す。
    const entry = shorthandListEntry()

    expect(validateInput(entry, { filters: [{ name: 'tag:Name', values: ['a,b'] }] })).toBeUndefined()
    expect(validateInput(entry, { filters: [{ name: 'a=b' }] })).toBeUndefined()
    expect(validateInput(entry, { filters: [{ name: 'a{b}' }] })).toBeUndefined()
  })

  it('制御文字を含む値は、string、string-list、shorthand-list のどの入力でも拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。NUL 文字を含む値を `string`、`string-list`、`shorthand-list` の入力へ渡した場合に、`control characters` を含むエラーを返すことを確認します。')
    // argv に NUL を載せると spawn が同期 throw し、ExecutionResult を伴わない応答になる。
    const stringEntry = entryOf({ inputs: [inputOf({ name: 'log_group_name' })] })
    const listEntry = entryOf({ inputs: [inputOf({ name: 'names', kind: 'string-list' })] })
    const listValue = shorthandListEntry()

    expect(validateInput(stringEntry, { log_group_name: `g${NUL}x` })?.message).toContain('control characters')
    expect(validateInput(listEntry, { names: [`a${NUL}b`] })?.kind).toBe('invalid-input')
    expect(validateInput(listValue, { filters: [{ name: `state${NUL}` }] })?.message)
      .toContain('control characters')
    expect(validateInput(listValue, { filters: [{ name: 'state', values: [`a${NUL}`] }] })?.message)
      .toContain('control characters')
  })

  it('shorthand-list の要素が空のオブジェクトのときは、拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`filters` に空のオブジェクトを渡した場合に、`name / values` の指定を求めるエラーを返すことを確認します。')
    // 空の要素を渡すと awscli が空の JSON オブジェクトを受け取り、意図しない絞り込みになる。
    expect(validateInput(shorthandListEntry(), { filters: [{}] })?.message).toContain('name / values')
  })

  it('TIMESTAMP_PATTERN は、タイムゾーンを含む ISO 8601 の日時だけを受け付ける', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`Z` や `+09:00` を含む日時は通し、タイムゾーンのない日時と epoch ミリ秒は `invalid format` を含むエラーで拒否することを確認します。')
    // タイムゾーンを欠いた形と epoch ミリ秒は description が示す書式の外にある。
    const entry = entryOf({ inputs: [inputOf({ name: 'start_time', pattern: TIMESTAMP_PATTERN })] })

    expect(validateInput(entry, { start_time: '2026-09-01T00:00:00Z' })).toBeUndefined()
    expect(validateInput(entry, { start_time: '2026-09-01T09:00:00+09:00' })).toBeUndefined()
    expect(validateInput(entry, { start_time: '2026-09-01T00:00:00' })?.message).toContain('invalid format')
    expect(validateInput(entry, { start_time: '1756684800000' })?.message).toContain('invalid format')
  })

  it('profile と region に不正な値を渡すと、入力の検証で拒否する', async () => {
    await explains('ツールの入力を検証する `validateInput` のテストです。`dev-1` は通し、空白を含む `profile` と、`tokyo` のような不正な `region` は、入力名を含むエラーで拒否することを確認します。')
    const entry = entryOf()

    expect(validateInput(entry, { profile: 'dev-1' })).toBeUndefined()
    expect(validateInput(entry, { profile: 'dev account' })?.message).toContain('profile')
    expect(validateInput(entry, { region: 'tokyo' })?.message).toContain('region')
  })
})

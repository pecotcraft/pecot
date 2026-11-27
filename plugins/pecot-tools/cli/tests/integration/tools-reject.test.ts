// 拒否（Athena の変更系 / 複文・`-` 始まりの値・排他など）が awscli を起動せずに失敗することを固定する（SC-002）。
// 応答が「-32602」「inputSchema 違反の text」「structuredContent の kind」のどの群に入るかも、ここで固定する。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetAwscliProbe } from '../../src/infra/awscli.js'
import { closeMcp, connectMcp, type ConnectedMcp } from '../../src/mcp/tests/_client.js'
import { allTools } from '../../src/mcp/tools/index.js'
import { useFakeAws } from '../_helpers/fake-aws.js'
import { isRecord } from '../_helpers/records.js'
import { explains } from '../../tests/_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'

/**
SDK が inputSchema 違反の text に載せる接頭辞。
*/
const INVALID_PARAMS_TEXT = 'Input validation error'

/**
JSON-RPC の Invalid params。SDK が未登録ツール名の tools/call に返すエラーコード。
*/
const INVALID_PARAMS_CODE = -32_602

const fakeAws = useFakeAws()
const mcp: { connected: ConnectedMcp | undefined } = { connected: undefined }
beforeEach(async () => {
  resetAwscliProbe()
  fakeAws.install()
  mcp.connected = await connectMcp(allTools())
})

afterEach(async () => {
  if (mcp.connected !== undefined) await closeMcp(mcp.connected)
  mcp.connected = undefined
})

function client(): ConnectedMcp['client'] {
  if (mcp.connected === undefined) throw new Error('サーバへ接続できていません')
  return mcp.connected.client
}

function callLog(): readonly (readonly string[])[] {
  return fakeAws.current().callLog()
}

/**
isError の応答を期待する呼び出し。structuredContent を返す。
*/
async function expectIsError(
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const result = await client().callTool({ name, arguments: { ...arguments_ } })
  const structured = result.structuredContent

  expect(result.isError, `${name} が isError にならなかった`).toBe(true)
  if (!isRecord(structured)) throw new Error(`${name} の structuredContent がありません`)
  expect(['not-allowed', 'invalid-input'], `${name} の kind`).toContain(structured['kind'])
  expect(typeof structured['detail']).toBe('string')
  expect(structured).not.toHaveProperty('reason')
  // awscli は起動しないので log は載らない。
  expect(structured).not.toHaveProperty('stderr')
  expect(structured).not.toHaveProperty('log')
  expect(callLog(), `${name} で awscli が起動した`).toEqual([])
  return structured
}

/**
ハンドラに到達しない違反を期待する呼び出し。content の text をつないで返す。
*/
async function expectSchemaError(
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string> {
  const result = await client().callTool({ name, arguments: { ...arguments_ } })

  expect(result.isError, `${name} が isError にならなかった`).toBe(true)
  // ハンドラが実行されていない証拠。実行されていれば ExecutionResult の structuredContent が付く。
  expect(result.structuredContent, `${name} でハンドラが実行された`).toBeUndefined()
  expect(callLog(), `${name} で awscli が起動した`).toEqual([])

  return result.content.map(part => (part.type === 'text' ? part.text : '')).join('\n')
}

describe('Athena の変更系・複文（research R6）', () => {
  const NOT_ALLOWED: readonly (readonly [string, string])[] = [
    ['DROP TABLE orders', 'PT-AWS-ATHENA-START-QUERY-EXECUTION-02'],
    ['INSERT INTO orders VALUES (1)', 'PT-AWS-ATHENA-START-QUERY-EXECUTION-02'],
    ['CREATE TABLE snapshot AS SELECT * FROM orders', 'PT-AWS-ATHENA-START-QUERY-EXECUTION-02'],
    ['UNLOAD (SELECT * FROM orders) TO \'s3://bucket/prefix/\'', 'PT-AWS-ATHENA-START-QUERY-EXECUTION-02'],
    ['EXPLAIN ANALYZE INSERT INTO orders VALUES (1)', 'PT-AWS-ATHENA-START-QUERY-EXECUTION-02'],
    ['SELECT 1; DROP TABLE orders', 'PT-AWS-ATHENA-START-QUERY-EXECUTION-03'],
  ]

  it.for(NOT_ALLOWED)('Athena のクエリ %j は、not-allowed として拒否し、awscli を起動しない', async ([query, id], context) => {
    await verifies(context, id)
    await explains('`aws_athena_start_query_execution` の入力検証のテストです。変更系の文（`DROP TABLE` や `INSERT` など）または複数の文を含むクエリを指定した場合に、失敗の種類が `not-allowed` になり、awscli が起動されないことを確認します。')
    const structured = await expectIsError('aws_athena_start_query_execution', { query_string: query })

    expect(structured['kind']).toBe('not-allowed')
  })

  it('参照だけの文でも複数含む場合は、not-allowed として拒否する', async (context) => {
    await verifies(context, 'PT-AWS-ATHENA-START-QUERY-EXECUTION-03')
    await explains('`aws_athena_start_query_execution` の入力検証のテストです。`SELECT 1; SELECT 2` のように参照だけの文を複数指定した場合に、失敗の種類が `not-allowed` で、詳細に `Multiple statements` が含まれることを確認します。')
    const structured = await expectIsError('aws_athena_start_query_execution', { query_string: 'SELECT 1; SELECT 2' })

    expect(structured['kind']).toBe('not-allowed')
    expect(structured['detail']).toContain('Multiple statements')
  })

  it('参照だけの単一のクエリは、拒否せずに実行する', async (context) => {
    await verifies(context, 'PT-AWS-ATHENA-START-QUERY-EXECUTION-01')
    await explains('`aws_athena_start_query_execution` の入力検証のテストです。`SELECT 1` を指定した場合は、拒否されずに実行されることを確認します。')
    const result = await client().callTool({
      name: 'aws_athena_start_query_execution',
      arguments: { query_string: 'SELECT 1' },
    })

    expect(result.isError).toBeUndefined()
  })

  it('shorthand 形式に使う項目の値に , を含む場合は、invalid-input として拒否する', async (context) => {
    await verifies(context, 'PT-AWS-ATHENA-START-QUERY-EXECUTION-05')
    await explains('`aws_athena_start_query_execution` の入力検証のテストです。`database` に `analytics,Catalog=injected` のように別のキーを継ぎ足せる値を指定した場合は、`invalid-input` で拒否されることを確認します。')
    // 素通しすると `Database=a,Catalog=x` のように契約外のキーを注入できる。
    const structured = await expectIsError('aws_athena_start_query_execution', {
      query_string: 'SELECT 1',
      database: 'analytics,Catalog=injected',
    })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain('database')
  })

  it.for([
    { name: 'database', char: '=', args: { database: 'a=b' } },
    { name: 'database', char: '{', args: { database: 'a{b' } },
    { name: 'database', char: '}', args: { database: 'a}b' } },
    { name: 'catalog', char: ',', args: { database: 'analytics', catalog: 'x,y' } },
    { name: 'output_location', char: '{', args: { output_location: 's3://b/p{x}' } },
  ])('$name の値に $char を含む場合は、invalid-input として拒否する', async (row, context) => {
    await verifies(context, 'PT-AWS-ATHENA-START-QUERY-EXECUTION-05')
    await explains(`\`aws_athena_start_query_execution\` の入力検証のテストです。\`${row.name}\` に構文として解釈される \`${row.char}\` を含む値を指定した場合は、\`invalid-input\` で拒否されることを確認します。`)
    const structured = await expectIsError('aws_athena_start_query_execution', {
      query_string: 'SELECT 1',
      ...row.args,
    })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain(row.name)
  })

  it('output_location に別のキーを継ぎ足す値を指定した場合は、invalid-input として拒否する', async (context) => {
    await verifies(context, 'PT-AWS-ATHENA-START-QUERY-EXECUTION-05')
    await explains('`aws_athena_start_query_execution` の入力検証のテストです。`output_location` に別のキーをカンマ区切りで追加した値を指定した場合は、`invalid-input` で拒否されることを確認します。')
    // --result-configuration に実際に注入される形。`OutputLocation=s3://b/p,ExpectedBucketOwner=…` を
    // 実 awscli は受理するため、組み立て前に項目側で落とす。
    const structured = await expectIsError('aws_athena_start_query_execution', {
      query_string: 'SELECT 1',
      output_location: 's3://b/p,ExpectedBucketOwner=123456789012',
    })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain('output_location')
  })

  it('database を指定せずに catalog だけを指定した場合は、invalid-input として拒否する', async (context) => {
    await verifies(context, 'PT-AWS-ATHENA-START-QUERY-EXECUTION-04')
    await explains('`aws_athena_start_query_execution` の入力検証のテストです。`catalog` だけを指定した場合に、失敗の種類が `invalid-input` で、詳細に `database` が含まれ、awscli が起動されないことを確認します。')
    // Database 無しの QueryExecutionContext を実 Athena API が受けるか未確認なので、組み立て前に拒否する。
    const structured = await expectIsError('aws_athena_start_query_execution', {
      query_string: 'SELECT 1',
      catalog: 'awsdatacatalog',
    })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain('database')
  })
})

describe('`-` 始まりの値（research R3）', () => {
  it('位置引数の値が - で始まる場合は、invalid-input として拒否する', async (context) => {
    await verifies(context, 'PT-COMMON-05')
    await explains('`aws_s3_ls` の入力検証のテストです。位置引数の `s3_uri` に `--endpoint-url` のように `-` で始まる値を指定した場合に、失敗の種類が `invalid-input` で、詳細に `-` が含まれることを確認します。')
    const structured = await expectIsError('aws_s3_ls', { s3_uri: '--endpoint-url' })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain('\'-\'')
  })

  it('配列の要素の値が - で始まる場合も、invalid-input として拒否する', async (context) => {
    await verifies(context, 'PT-COMMON-05')
    await explains('`aws_logs_filter_log_events` の入力検証のテストです。`log_stream_names` の要素に `--debug` のように `-` で始まる値を含めた場合に、詳細に `-` が含まれる失敗として拒否されることを確認します。')
    // string-list は nargs が貪欲で 1 トークン形へ畳めない。
    const structured = await expectIsError('aws_logs_filter_log_events', {
      log_group_name: 'g',
      log_stream_names: ['ok', '--debug'],
    })

    expect(structured['detail']).toContain('\'-\'')
  })

  it('フラグで渡す文字列の値が - で始まる場合は、拒否せず --flag=value の 1 つの引数にして実行する', async () => {
    await explains('`aws_logs_filter_log_events` の引数の組み立てのテストです。`filter_pattern` に除外を表す `-INFO` を指定した場合に、エラーにならず、awscli へ `--filter-pattern=-INFO` の 1 つの引数で渡されることを確認します。')
    // CloudWatch Logs の除外パターン（-INFO）。実 awscli 2.36.40 が受理することを確認している。
    const result = await client().callTool({
      name: 'aws_logs_filter_log_events',
      arguments: { log_group_name: 'g', filter_pattern: '-INFO' },
    })

    expect(result.isError).toBeUndefined()
    expect(callLog().filter(call => call[0] !== '--version')).toEqual([[
      'logs', 'filter-log-events',
      '--log-group-name', 'g',
      '--filter-pattern=-INFO',
      '--output', 'json', '--no-cli-pager',
    ]])
  })
})

describe('shorthand-list の項目値', () => {
  /**
  shorthand なら構文として解釈される 4 文字。JSON 組み立てではただの文字として載る。
  */
  const SYNTAX_CHARACTERS: readonly string[] = [',', '=', '{', '}']

  it.each(SYNTAX_CHARACTERS)('通常の項目の値に構文の文字 %j を含む場合も、拒否せず JSON にエスケープして実行する', async (character) => {
    await explains('`aws_ec2_describe_instances` の引数の組み立てのテストです。shorthand で構文として解釈される文字を `filters` の名前へ含めた場合は、JSON の文字列として awscli へ渡されることを確認します。')
    const result = await client().callTool({
      name: 'aws_ec2_describe_instances',
      arguments: { filters: [{ name: `instance-state-name${character}x`, values: ['running'] }] },
    })

    expect(result.isError).toBeUndefined()
    expect(callLog().filter(call => call[0] !== '--version')).toEqual([[
      'ec2', 'describe-instances',
      '--filters',
      JSON.stringify([{ Name: `instance-state-name${character}x`, Values: ['running'] }]),
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it.each(SYNTAX_CHARACTERS)('配列の項目の値に構文の文字 %j を含む場合も、拒否せず JSON にエスケープして実行する', async (character) => {
    await explains('`aws_ec2_describe_instances` の引数の組み立てのテストです。shorthand で構文として解釈される文字を `values` へ含めた場合は、JSON の文字列として awscli へ渡されることを確認します。')
    const result = await client().callTool({
      name: 'aws_ec2_describe_instances',
      arguments: { filters: [{ name: 'instance-state-name', values: [`running${character}x`] }] },
    })

    expect(result.isError).toBeUndefined()
    expect(callLog().filter(call => call[0] !== '--version')).toEqual([[
      'ec2', 'describe-instances',
      '--filters',
      JSON.stringify([{ Name: 'instance-state-name', Values: [`running${character}x`] }]),
      '--output', 'json', '--no-cli-pager',
    ]])
  })

  it('項目の値が空文字の場合は、invalid-input として拒否する', async () => {
    await explains('`aws_ec2_describe_instances` の入力検証のテストです。`filters` の名前に空文字を指定した場合に、失敗の種類が `invalid-input` で、詳細に空であってはならない旨（`must not be empty`）が含まれることを確認します。')
    // 空文字は awscli が空値として解釈する。通常項目と list 項目の双方で弾く。
    const normal = await expectIsError('aws_ec2_describe_instances', {
      filters: [{ name: '', values: ['running'] }],
    })

    expect(normal['kind']).toBe('invalid-input')
    expect(normal['detail']).toContain('must not be empty')
  })

  it('項目を 1 つも持たない要素を指定した場合は、invalid-input として拒否する', async () => {
    await explains('`aws_ecr_describe_images` の入力検証のテストです。`image_ids` に空のオブジェクトを指定した場合に、失敗の種類が `invalid-input` で、詳細に `image_ids` が含まれることを確認します。')
    // 空の要素を渡すと awscli が空トークンを受け取り、意図しない絞り込みになる。
    const structured = await expectIsError('aws_ecr_describe_images', {
      repository_name: 'order-api',
      image_ids: [{}],
    })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain('image_ids')
  })

  it('要素に宣言されていないキーを含む場合は、入力検証エラーになる', async () => {
    await explains('`aws_ec2_describe_instances` の入力検証のテストです。`filters` の要素に宣言されていない `Extra` を含めた場合に、ハンドラが実行される前に `Input validation error` で拒否され、awscli が起動されないことを確認します。')
    // 要素の型は z.strictObject で、JSON Schema の items.additionalProperties: false になる。
    // z.object だと余分なキーは削られるだけで、拒否の記録は残らない。
    expect(await expectSchemaError('aws_ec2_describe_instances', {
      filters: [{ name: 'instance-state-name', values: ['running'], Extra: 'x' }],
    })).toContain(INVALID_PARAMS_TEXT)
  })

  it('配列の項目が空の配列の場合は、入力検証エラーになる', async () => {
    await explains('`aws_ec2_describe_instances` の入力検証のテストです。`filters` の要素の `values` に空の配列を指定した場合に、ハンドラが実行される前に `Input validation error` で拒否され、awscli が起動されないことを確認します。')
    // 要素の中の values は zod の minItems で落ちる（配列そのものの空とは層が違う）。
    expect(await expectSchemaError('aws_ec2_describe_instances', {
      filters: [{ name: 'instance-state-name', values: [] }],
    })).toContain(INVALID_PARAMS_TEXT)
  })

  it('空の配列を指定した場合は、そのオプションを付けずに実行する', async () => {
    await explains('`aws_ec2_describe_instances` の引数の組み立てのテストです。`filters` に空の配列を指定した場合に、エラーにならず、awscli の引数に `--filters` が含まれないことを確認します。')
    const result = await client().callTool({
      name: 'aws_ec2_describe_instances',
      arguments: { filters: [] },
    })

    expect(result.isError).toBeUndefined()
    expect(callLog().filter(call => call[0] !== '--version')).toEqual([[
      'ec2', 'describe-instances', '--output', 'json', '--no-cli-pager',
    ]])
  })
})

describe('排他指定', () => {
  it('log_stream_names と log_stream_name_prefix を同時に指定した場合は、invalid-input として拒否する', async (context) => {
    await verifies(context, 'PT-AWS-LOGS-FILTER-LOG-EVENTS-02')
    await explains('`aws_logs_filter_log_events` の入力検証のテストです。排他の関係にある 2 つの入力を同時に指定した場合に、失敗の種類が `invalid-input` で、詳細に併用できない旨（`cannot be combined`）が含まれることを確認します。')
    const structured = await expectIsError('aws_logs_filter_log_events', {
      log_group_name: 'g',
      log_stream_names: ['a'],
      log_stream_name_prefix: 'p',
    })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain('cannot be combined')
  })

  it('image_ids と starting_token を同時に指定した場合は、invalid-input として拒否する', async (context) => {
    await verifies(context, 'PT-AWS-ECR-DESCRIBE-IMAGES-03')
    await explains('`aws_ecr_describe_images` の入力検証のテストです。ECR の API が受け付けない組み合わせを指定した場合に、失敗の種類が `invalid-input` で、詳細に併用できない旨（`cannot be combined`）が含まれることを確認します。')
    // ECR の API は imageIds 指定時に nextToken を受け付けない。
    const structured = await expectIsError('aws_ecr_describe_images', {
      repository_name: 'order-api',
      image_ids: [{ image_tag: 'latest' }],
      starting_token: 'token-1',
    })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain('cannot be combined')
  })

  it('start_time と duration を同時に指定した場合は、invalid-input として拒否する', async (context) => {
    await verifies(context, 'PT-AWS-RDS-DESCRIBE-EVENTS-02')
    await explains('`aws_rds_describe_events` の入力検証のテストです。意味が重なる 2 つの入力を同時に指定した場合に、失敗の種類が `invalid-input` で、詳細に併用できない旨（`cannot be combined`）が含まれることを確認します。')
    // duration は現在から遡る分数で、start_time / end_time と意味が重なる。
    const structured = await expectIsError('aws_rds_describe_events', {
      start_time: '2026-09-01T00:00:00Z',
      duration: 60,
    })

    expect(structured['kind']).toBe('invalid-input')
    expect(structured['detail']).toContain('cannot be combined')
  })
})

describe('inputSchema 段階で落ちる違反', () => {
  it.for(['ec2_terminate_instances', 'aws_sso_logout'])('許可リストに存在しないツール名 %s を指定した場合は、JSON-RPC のエラー -32602 になる', async (name, context) => {
    await verifies(context, 'PT-COMMON-04')
    await explains('許可リストに存在しないツール名の呼び出しのテストです。`ec2_terminate_instances` などを指定した場合は、`not-allowed` ではなく JSON-RPC のエラー `-32602` で失敗することを確認します。')
    // 許可リスト外は not-allowed ではなく「そのツールが無い」。ハンドラに到達しない。
    // 公開しているツールの近縁な名前 (aws_sso_logout) でも、載っていなければ同じ扱いになる。
    // client と server は別バンドルなので、エラー型は instanceof ではなく code で見る。
    await expect(client().callTool({ name, arguments: {} })).rejects.toMatchObject({ code: INVALID_PARAMS_CODE })
    expect(callLog(), `${name} で awscli が起動した`).toEqual([])
  })

  it('profile の形式が誤っている場合は、入力検証エラーになる', async (context) => {
    await verifies(context, 'PT-COMMON-01')
    await explains('`aws_sts_get_caller_identity` の入力検証のテストです。`profile` に空白を含む `dev account` を指定した場合に、`Input validation error` で拒否され、メッセージに `profile` が含まれることを確認します。')
    const text = await expectSchemaError('aws_sts_get_caller_identity', { profile: 'dev account' })

    expect(text).toContain(INVALID_PARAMS_TEXT)
    expect(text).toContain('profile')
  })

  it('region の形式が誤っている場合は、入力検証エラーになる', async (context) => {
    await verifies(context, 'PT-COMMON-01')
    await explains('`aws_sts_get_caller_identity` の入力検証のテストです。`region` に `tokyo` を指定した場合に、`Input validation error` で拒否され、メッセージに `region` が含まれることを確認します。')
    const text = await expectSchemaError('aws_sts_get_caller_identity', { region: 'tokyo' })

    expect(text).toContain(INVALID_PARAMS_TEXT)
    expect(text).toContain('region')
  })

  it('数値が許可する範囲の外にある場合は、入力検証エラーになる', async (context) => {
    await verifies(context, 'PT-COMMON-01')
    await explains('数値の入力検証のテストです。`max_items` に `0` を、`limit` に上限を超える値を指定した場合は、どちらも `Input validation error` で拒否されることを確認します。')
    expect(await expectSchemaError('aws_lambda_list_functions', { max_items: 0 }))
      .toContain(INVALID_PARAMS_TEXT)
    expect(await expectSchemaError('aws_logs_get_log_events', {
      log_group_name: 'g',
      log_stream_name: 's',
      limit: 10_001,
    })).toContain(INVALID_PARAMS_TEXT)
  })

  it('必須の入力を指定しない場合は、入力検証エラーになる', async (context) => {
    await verifies(context, 'PT-COMMON-01')
    await explains('`aws_lambda_get_function_configuration` の入力検証のテストです。必須の `function_name` を指定しない場合は、`Input validation error` で拒否されることを確認します。')
    expect(await expectSchemaError('aws_lambda_get_function_configuration', {}))
      .toContain(INVALID_PARAMS_TEXT)
  })

  it('選択肢にない値を指定した場合は、入力検証エラーになる', async (context) => {
    await verifies(context, 'PT-COMMON-01')
    await explains('`aws_logs_describe_log_streams` の入力検証のテストです。`order_by` へ選択肢にない `Other` を指定した場合は、`Input validation error` で拒否されることを確認します。')
    expect(await expectSchemaError('aws_logs_describe_log_streams', {
      log_group_name: 'g',
      order_by: 'Other',
    })).toContain(INVALID_PARAMS_TEXT)
  })

  it('not-allowed を返すのは Athena のクエリの判定だけで、ほかの拒否は invalid-input になる', async () => {
    await explains('失敗の種類の使い分けのテストです。Athena の変更系のクエリは `not-allowed`、`aws_s3_ls` の誤った `s3_uri` は `invalid-input` になることを確認します。')
    // 「許可リスト外 = not-allowed」ではない。許可リスト外はツールとして存在しないので
    // JSON-RPC エラー -32602 になり、not-allowed は公開済みツールの中で内容を見て拒否する場合にだけ出る。
    const notAllowed = await expectIsError('aws_athena_start_query_execution', {
      query_string: 'DROP TABLE orders',
    })
    const invalidInput = await expectIsError('aws_s3_ls', { s3_uri: '/var/data/' })

    expect(notAllowed['kind']).toBe('not-allowed')
    expect(invalidInput['kind']).toBe('invalid-input')
  })
})

describe('許可リストの書式の規則', () => {
  it.for([
    {
      name: 'cloudwatch の start_time がタイムゾーンの無い日時のとき',
      tool: 'aws_cloudwatch_get_metric_statistics',
      args: {
        namespace: 'AWS/SQS',
        metric_name: 'NumberOfMessagesSent',
        start_time: '2026-09-01T00:00:00',
        end_time: '2026-09-01T01:00:00Z',
        period: 300,
        statistics: ['Sum'],
      },
      ids: ['PT-COMMON-14', 'PT-AWS-CLOUDWATCH-GET-METRIC-STATISTICS-02'],
    },
    {
      name: 'rds の start_time がタイムゾーンの無い日時のとき',
      tool: 'aws_rds_describe_events',
      args: { start_time: '2026-09-01T00:00:00' },
      ids: ['PT-COMMON-14', 'PT-AWS-RDS-DESCRIBE-EVENTS-03'],
    },
    {
      name: 's3 ls の s3_uri が s3:// で始まらないとき',
      tool: 'aws_s3_ls',
      args: { s3_uri: 'example-bucket/logs/' },
      ids: ['PT-COMMON-14', 'PT-AWS-S3-LS-03'],
    },
  ])('$name、invalid-input として拒否し、awscli を起動しない', async (row, context) => {
    await explains(`許可リストが定める入力の書式のテストです。「${row.name}」の入力を指定した場合に、失敗の種類が \`invalid-input\` になり、awscli が起動されないことを確認します。`)
    for (const id of row.ids) await verifies(context, id)
    const structured = await expectIsError(row.tool, row.args)

    expect(structured['kind']).toBe('invalid-input')
  })

  it('値に制御文字を含む場合は、invalid-input として拒否し、awscli を起動しない', async (context) => {
    await verifies(context, 'PT-COMMON-06')
    await explains('`aws_lambda_get_function_configuration` の入力検証のテストです。`function_name` に制御文字 `U+0001` を含む値を指定した場合に、失敗の種類が `invalid-input` になり、awscli が起動されないことを確認します。')
    const structured = await expectIsError('aws_lambda_get_function_configuration', { function_name: 'a\u{1}b' })

    expect(structured['kind']).toBe('invalid-input')
  })
})

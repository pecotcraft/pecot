// 偽 awscli を PATH 先頭へ差し込み、executeAllowlisted の実行処理（成功 / 事前拒否 /
// 失敗種別 / 時間切れ / 未導入 / 切り詰め）を検証する。
//
// PATH を stub するため it.concurrent は使わない。ensureAwscli の memo は毎ケース捨てる。

/* eslint-disable security/detect-non-literal-fs-filename -- 扱うのは mkdtemp の戻り値だけ */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { AllowlistEntry, FailureKind } from '../../../domain/allowlist.js'
import { OUTPUT_LIMIT_BYTES, resetAwscliProbe } from '../../../infra/awscli.js'
import { toCallToolResult, type ExecutionResult } from '../../result.js'
import type { ToolDefinition } from '../../server.js'
import { closeMcp, connectMcp, outputJsonSchemaOf, outputSchemaIssues } from '../../tests/_client.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  COMMON_OUTPUT_SHAPE,
  executeAllowlisted,
  LIMIT_NEXT_TOKEN_PAGINATION_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  TOOL_TIMEOUT_MS,
} from '../_shared.js'
import { type FakeAws, useFakeAws } from '../../../../tests/_helpers/fake-aws.js'
import { verifies } from '../../../../tests/_helpers/verifies.js'

const IDENTITY_ENTRY: AllowlistEntry = {
  toolName: 'aws_sts_get_caller_identity',
  service: 'sts',
  subcommand: 'get-caller-identity',
  kind: 'read',
  jsonOutput: true,
  pagination: 'none',
  inputs: [],
}

const LIST_ENTRY: AllowlistEntry = {
  toolName: 'aws_lambda_list_functions',
  service: 'lambda',
  subcommand: 'list-functions',
  kind: 'read',
  jsonOutput: true,
  pagination: 'max-items',
  inputs: [{ name: 'max_items', kind: 'integer', required: false, awsFlag: '--max-items', min: 1 }],
}

const LS_ENTRY: AllowlistEntry = {
  toolName: 'aws_s3_ls',
  service: 's3',
  subcommand: 'ls',
  kind: 'read',
  jsonOutput: false,
  pagination: 'none',
  inputs: [],
}

const CONTEXT = { signal: new AbortController().signal }

const IDENTITY_RESPONSE_SHAPE = {
  UserId: z.string().describe('User ID'),
  Account: z.string().describe('Account ID'),
  Arn: z.string().describe('ARN'),
}

const IDENTITY_KEYS: ReadonlySet<string> = new Set(['UserId', 'Account', 'Arn'])

/**
list-functions 相当のツール定義。outputSchema を確かめるのに使う。
*/
const LIST_TOOL = allowlistedTool({
  entry: LIST_ENTRY,
  title: 'List functions',
  description: 'Lists functions',
  inputSchema: z.object(COMMON_INPUT_SHAPE),
  responseShape: { Functions: z.array(z.looseObject({})).describe('Functions') },
})

/**
list-functions 相当で、Functions を必ず返すと宣言したツール定義。anyOf の枝を確かめるのに使う。
*/
const REQUIRED_LIST_TOOL = allowlistedTool({
  entry: LIST_ENTRY,
  title: 'List functions',
  description: 'Lists functions',
  inputSchema: z.object(COMMON_INPUT_SHAPE),
  responseShape: { Functions: z.array(z.looseObject({})).describe('Functions') },
  responseRequired: ['Functions'],
})

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod 由来の型のため
function propertyNamesOf(tool: Readonly<ToolDefinition>): readonly string[] {
  const properties = outputJsonSchemaOf(tool)['properties']
  return properties instanceof Object ? Object.keys(properties) : []
}

/**
何も拒否しない reject。空の関数本体だと「拒否しないことを意図している」と読めない。
*/
const NO_REJECTION = (): undefined => undefined

/**
失敗の detail。成功が返ったらテストを落とす。
*/
function detailOf(result: Readonly<ExecutionResult>): string {
  if (result.ok) throw new Error('expected a failure')
  return result.detail
}

const fakeAws = useFakeAws()

beforeEach(() => {
  resetAwscliProbe()
})

/**
テストが生成する fixture の置き場。使い終わったら消す。
*/
async function withFixtureDirectory(use: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecot-tools-fixture-'))
  try {
    await use(directory)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
`--version` の確認呼び出しを除いた awscli 呼び出し。
*/
function commandCalls(instance: FakeAws): readonly (readonly string[])[] {
  return instance.callLog().filter(call => call[0] !== '--version')
}

describe('共通スキーマ', () => {
  it('全ツール共通の任意入力として profile / region を持つ', () => {
    expect(Object.keys(COMMON_INPUT_SHAPE)).toEqual(['profile', 'region'])
  })

  it('ページングの 2 方式それぞれに入力を用意する', () => {
    expect(Object.keys(MAX_ITEMS_PAGINATION_SHAPE)).toEqual(['max_items', 'starting_token'])
    expect(Object.keys(LIMIT_NEXT_TOKEN_PAGINATION_SHAPE)).toEqual(['limit', 'next_token', 'start_from_head'])
  })

  it('全ツールの outputSchema に並べる共通の項目は 4 つ', () => {
    expect(Object.keys(COMMON_OUTPUT_SHAPE)).toEqual(['kind', 'detail', 'log', 'warnings'])
  })

  it('既定の制限時間は 120 秒', async (context) => {
    await verifies(context, 'PT-COMMON-08')
    expect(TOOL_TIMEOUT_MS).toBe(120_000)
  })
})

describe('executeAllowlisted', () => {
  it('JSON 出力をそのまま data にして成功を返す', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(IDENTITY_ENTRY, { region: 'ap-northeast-1' }, CONTEXT)

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ Account: '123456789012' })
    expect(result.kind).toBeUndefined()
    expect(commandCalls(fake)).toEqual([
      ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager', '--region', 'ap-northeast-1'],
    ])
  })

  it('検証で弾いたときは awscli を起動しない', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(LIST_ENTRY, { max_items: 0 }, CONTEXT)

    expect(result).toMatchObject({ ok: false, kind: 'invalid-input' })
    expect(commandCalls(fake)).toEqual([])
  })

  it('AccessDenied を permission-denied にし、log に秘密を伏せた出力を入れる', async (context) => {
    await verifies(context, 'PT-COMMON-12')
    fakeAws.install({ fixture: 'access-denied' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({ ok: false, kind: 'permission-denied' })
    expect(detailOf(result)).toContain('permission-denied')
    const log = String(result.data['log'])
    expect(log).toContain('AccessDeniedException')
    expect(log).toContain('[redacted]')
    expect(log).not.toContain('IQoJb3JpZ2luX2VjEXAMPLETOKEN')
  })

  it('終了コード 252 を invalid-input にする', async () => {
    fakeAws.install({ fixture: 'invalid-input' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({ ok: false, kind: 'invalid-input' })
  })

  // 実 awscli 2.36.40（2026-09-07 採取）の stderr と終了コードをそのまま置いた fixture。
  // 分類器の単体テストとは別に、実出力が実行処理を通っても同じ種別になることを見る。
  const CAPTURED_FIXTURES: readonly {
    readonly fixture: string
    readonly kind: FailureKind
  }[] = [
    { fixture: 'no-credentials', kind: 'auth-missing' },
    { fixture: 's3-cp-no-credentials', kind: 'auth-missing' },
    { fixture: 'profile-not-found', kind: 'auth-missing' },
    { fixture: 'sso-token-expired', kind: 'auth-expired' },
    { fixture: 'invalid-token', kind: 'auth-expired' },
  ]

  it.each(CAPTURED_FIXTURES)('実採取 fixture $fixture を $kind にする', async (captured) => {
    fakeAws.install({ fixture: captured.fixture })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({
      ok: false,
      kind: captured.kind,
    })
  })

  it('時間切れは timeout にする', async (context) => {
    await verifies(context, 'PT-COMMON-08')
    fakeAws.install({ hang: true })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, { timeoutMs: 500 })

    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    expect(detailOf(result)).toContain('Narrow the range')
  })

  it('awscli 未導入は awscli-missing にする', async () => {
    fakeAws.withoutAws()

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({ ok: false, kind: 'awscli-missing' })
    expect(detailOf(result)).toContain('PATH')
  })

  it('NextToken を nextToken へ転記する', async () => {
    fakeAws.install({ fixture: 'paginated' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result.data).toMatchObject({ NextToken: 'eyJuZXh0IjogMX0=', nextToken: 'eyJuZXh0IjogMX0=' })
  })

  it('ページングを持たないツールは nextToken を作らない', async () => {
    fakeAws.install({ fixture: 'paginated' })

    const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

    expect(result.data).not.toHaveProperty('nextToken')
  })

  it('JSON 出力を持たないツールは行配列にする', async () => {
    fakeAws.install({ fixture: 's3-ls' })

    const result = await executeAllowlisted(LS_ENTRY, {}, CONTEXT)

    expect(result.data).toEqual({
      lines: ['2026-09-01 10:00:00       1024 report.json', '                           PRE logs/'],
    })
  })

  it('出力が空なら空の行配列にする', async () => {
    fakeAws.install({ fixture: 'no-such-fixture' })

    const result = await executeAllowlisted(LS_ENTRY, {}, CONTEXT)

    expect(result.data).toEqual({ lines: [] })
  })

  it('オブジェクトでない JSON は行配列へ落とす', async () => {
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'array.stdout'), '[1, 2]\n')
      fakeAws.install({ fixture: 'array', fixtureDir: directory })

      const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

      expect(result.data).toEqual({ lines: ['[1, 2]'] })
    })
  })

  it('JSON として読めない出力は行配列へ落とす', async () => {
    // jsonOutput のツールでも警告行だけが返ることがある（JSON.parse が失敗する場合）。
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'broken.stdout'), 'not json at all\n')
      fakeAws.install({ fixture: 'broken', fixtureDir: directory })

      const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

      expect(result.data).toEqual({ lines: ['not json at all'] })
    })
  })

  it('成功時の stdout も秘匿化する', async (context) => {
    await verifies(context, 'PT-COMMON-15')
    // SC-006 は応答全体が対象。log 側だけ固定すると、成功時の退行を見逃す。
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'leaky.stdout'), '{"AccessKeyId":"AKIAIOSFODNN7EXAMPLE"}\n')
      fakeAws.install({ fixture: 'leaky', fixtureDir: directory })

      const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

      expect(result.ok).toBe(true)
      expect(result.data).toEqual({ AccessKeyId: '[redacted]' })
    })
  })

  it('log が上限を超えたら切り詰めたことを detail に残す', async () => {
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'noisy.stderr'), 'y'.repeat(OUTPUT_LIMIT_BYTES + 1024))
      writeFileSync(path.join(directory, 'noisy.exit'), '254\n')
      fakeAws.install({ fixture: 'noisy', fixtureDir: directory })

      const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

      expect(result.ok).toBe(false)
      expect(Buffer.byteLength(String(result.data['log']), 'utf8')).toBe(OUTPUT_LIMIT_BYTES)
      expect(detailOf(result)).toContain('log exceeded the limit')
    })
  })

  it('失敗時の structuredContent も outputSchema に適合する', async () => {
    // SDK の validateToolOutput は isError が真なら検証を省くため、失敗時のずれは
    // プロトコル越しでは検出されない。ここで直接スキーマに掛ける。
    fakeAws.install({ fixture: 'access-denied' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)
    const content = toCallToolResult(result).structuredContent

    expect(await outputSchemaIssues(LIST_TOOL, content)).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, content)).toEqual([])
  })

  it('失敗のときは、最上位に kind と detail を置き、reason と stderr を載せない', async () => {
    fakeAws.install({ fixture: 'access-denied' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)
    const content = toCallToolResult(result).structuredContent

    expect(content).not.toHaveProperty('stderr')
    expect(content).toMatchObject({ kind: 'permission-denied', detail: detailOf(result) })
    expect(content).not.toHaveProperty('reason')
  })

  it('成功のときは、stderr・log・入れ物の項目を載せない', async () => {
    fakeAws.install()

    const content = toCallToolResult(await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)).structuredContent

    expect(content).not.toHaveProperty('stderr')
    expect(content).not.toHaveProperty('log')
    for (const key of ['ok', 'exitCode', 'data', 'artifacts', 'message']) expect(content).not.toHaveProperty(key)
  })

  it('必須を言えないツールの outputSchema は、宣言した項目を任意で通し、宣言に無い項目と型の違う項目を拒む', async () => {
    expect(await outputSchemaIssues(LIST_TOOL, {})).toEqual([])
    expect(await outputSchemaIssues(LIST_TOOL, { Functions: [], NextToken: 't', nextToken: 't' })).toEqual([])
    expect(await outputSchemaIssues(LIST_TOOL, { lines: [] })).toEqual([])
    expect(await outputSchemaIssues(LIST_TOOL, { Account: '1' })).not.toEqual([])
    expect(await outputSchemaIssues(LIST_TOOL, { log: 1 })).not.toEqual([])
  })

  it('必須を宣言したツールの outputSchema は、成功の形のどれか、または kind と detail を求める', async () => {
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { Functions: [] })).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { lines: [] })).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { output: 'x', truncated: true })).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { kind: 'timeout', detail: 'd' })).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, {})).not.toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { NextToken: 't', nextToken: 't' })).not.toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { output: 'x' })).not.toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { kind: 'timeout' })).not.toEqual([])
  })

  it('宣言したキーだけを残し、落としたキーの名前を warnings に 1 行で入れる', async () => {
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'extra.stdout'), '{"UserId":"u","Account":"1","Arn":"a","NewKey":1,"Other":{}}\n')
      fakeAws.install({ fixture: 'extra', fixtureDir: directory })

      const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT, { responseKeys: IDENTITY_KEYS })

      expect(result.data).toEqual({
        UserId: 'u',
        Account: '1',
        Arn: 'a',
        warnings: ['Dropped undeclared top-level keys: NewKey, Other'],
      })
    })
  })

  it('落とすキーが無ければ warnings を足さない', async () => {
    fakeAws.install()

    const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT, { responseKeys: IDENTITY_KEYS })

    expect(result.data).not.toHaveProperty('warnings')
    expect(Object.keys(result.data).every(key => IDENTITY_KEYS.has(key))).toBe(true)
  })

  it('宣言したキーで絞っても、NextToken を nextToken へ転記する', async () => {
    fakeAws.install({ fixture: 'paginated' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, { responseKeys: new Set(['Functions', 'NextToken']) })

    expect(result.data).toMatchObject({ NextToken: 'eyJuZXh0IjogMX0=', nextToken: 'eyJuZXh0IjogMX0=' })
    expect(result.data).not.toHaveProperty('warnings')
  })

  it('上限を超える出力は先頭を残して truncated を立てる', async (context) => {
    await verifies(context, 'PT-COMMON-11')
    await withFixtureDirectory(async (directory) => {
      const body = `{"Functions":["${'x'.repeat(OUTPUT_LIMIT_BYTES)}"]}`
      writeFileSync(path.join(directory, 'large.stdout'), body)
      fakeAws.install({ fixture: 'large', fixtureDir: directory })

      const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

      expect(result.ok).toBe(true)
      expect(result.data).toMatchObject({ truncated: true })
      const output = String(result.data['output'])
      expect(body.startsWith(output)).toBe(true)
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES)
      const [sentence] = toCallToolResult(result).content
      const text = sentence?.type === 'text' ? sentence.text : ''
      expect(text).toContain('max_items')
      expect(text).toContain('starting_token')
    })
  })

  it('キャンセルされたら子プロセスへ SIGTERM を伝える', async () => {
    const instance = fakeAws.install({ hang: true })
    const controller = new AbortController()

    const running = executeAllowlisted(LIST_ENTRY, {}, { signal: controller.signal }, { timeoutMs: 30_000 })
    // ensureAwscli の --version を先に通し、本体が起動してから abort する。
    await vi.waitFor(() => {
      expect(commandCalls(instance)).toHaveLength(1)
    })
    controller.abort()

    const result = await running
    expect(result.ok).toBe(false)
    expect(result.kind).not.toBe('timeout')
  })
})

/**
ツール 1 件を登録したサーバへ接続し、tools/call の結果を返す。
*/
async function callTool(
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- zod 由来の型のため
  tool: ToolDefinition,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const connected = await connectMcp([tool])
  try {
    return await connected.client.callTool({ name: tool.name, arguments: { ...arguments_ } })
  }
  finally {
    await closeMcp(connected)
  }
}

describe('実行前拒否 (reject)', () => {
  it('reject が理由を返したら、awscli を起動せず、その kind と文で失敗を返す', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, {
      reject: () => ({ kind: 'not-allowed', message: '変更系クエリは実行できません' }),
    })

    expect(result).toMatchObject({
      ok: false,
      kind: 'not-allowed',
      detail: '変更系クエリは実行できません',
    })
    expect(fake.callLog()).toEqual([])
  })

  it('reject は invalid-input も返せる', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, {
      reject: () => ({ kind: 'invalid-input', message: '書き出し先が既にあります' }),
    })

    expect(result).toMatchObject({ ok: false, kind: 'invalid-input' })
    expect(fake.callLog()).toEqual([])
  })

  it('reject が undefined を返せば通常どおり実行する', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT, { reject: NO_REJECTION })

    expect(result.ok).toBe(true)
    expect(commandCalls(fake)).toHaveLength(1)
  })

  it('reject は許可リストの検証より後・awscli の存在確認より前に働く', async () => {
    // 未導入の環境でも「拒否されるはずの呼び出し」が awscli-missing に化けない。
    fakeAws.withoutAws()

    const rejectedByValidation = await executeAllowlisted(LIST_ENTRY, { max_items: 0 }, CONTEXT, {
      reject: () => ({ kind: 'not-allowed', message: '拒否' }),
    })
    const rejectedByHook = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, {
      reject: () => ({ kind: 'not-allowed', message: '拒否' }),
    })

    expect(rejectedByValidation.kind).toBe('invalid-input')
    expect(rejectedByHook.kind).toBe('not-allowed')
  })
})

describe('allowlistedTool', () => {
  const BASE_SPEC = {
    title: '呼び出し元 ID の確認',
    description: '現在の認証情報が示すアカウントを返す',
    inputSchema: z.object(COMMON_INPUT_SHAPE),
  }
  const SPEC = { ...BASE_SPEC, responseShape: IDENTITY_RESPONSE_SHAPE }

  it('ツール名は許可リストのエントリ名を使う', () => {
    expect(allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }).name).toBe('aws_sts_get_caller_identity')
  })

  it('JSON を出すツールの outputSchema は、応答のキー・awscli の出力の項目・共通の 4 項目を並べる', () => {
    const tool = allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC })

    expect(propertyNamesOf(tool)).toEqual(['UserId', 'Account', 'Arn', 'lines', 'output', 'truncated', 'kind', 'detail', 'log', 'warnings'])
    expect(outputJsonSchemaOf(tool)['additionalProperties']).toBe(false)
  })

  it('JSON を出すツールは、responseRequired があるときだけ anyOf を置く', () => {
    expect(outputJsonSchemaOf(allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }))).not.toHaveProperty('anyOf')
    expect(outputJsonSchemaOf(REQUIRED_LIST_TOOL)['anyOf']).toEqual([
      { required: ['Functions'] },
      { required: ['lines'] },
      { required: ['output', 'truncated'] },
      { required: ['kind', 'detail'] },
    ])
  })

  it('JSON を出さないツールは、lines か output と truncated か kind と detail を anyOf で求める', () => {
    const listing = allowlistedTool({ entry: LS_ENTRY, ...BASE_SPEC })

    expect(outputJsonSchemaOf(listing)['anyOf']).toEqual([
      { required: ['lines'] },
      { required: ['output', 'truncated'] },
      { required: ['kind', 'detail'] },
    ])
  })

  it('responseRequired のキーが responseShape に無いと、定義を作らず例外を投げる', () => {
    expect(() => allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC, responseRequired: ['Missing'] }))
      .toThrow('responseRequired has keys not in responseShape: Missing')
  })

  it.for(['kind', 'detail', 'log', 'warnings'])('responseShape が共通の項目の名前 %s を持つと、定義を作らずに例外を投げる', (key) => {
    expect(() => allowlistedTool({ entry: IDENTITY_ENTRY, ...BASE_SPEC, responseShape: { ...IDENTITY_RESPONSE_SHAPE, [key]: z.string() } }))
      .toThrow(new TypeError(`aws_sts_get_caller_identity: output の ${key} は MCP の結果の共通の項目の予約名です`))
  })

  it.for(['lines', 'output', 'truncated'])('responseShape が pecot-tools の足す項目の名前 %s を持つと、定義を作らずに例外を投げる', (key) => {
    expect(() => allowlistedTool({ entry: IDENTITY_ENTRY, ...BASE_SPEC, responseShape: { ...IDENTITY_RESPONSE_SHAPE, [key]: z.string() } }))
      .toThrow(new TypeError(`aws_sts_get_caller_identity: output の ${key} は pecot-tools が足す項目と重なります`))
  })

  it('max-items のツールの responseShape が nextToken を持つと、定義を作らずに例外を投げる', () => {
    expect(() => allowlistedTool({
      entry: LIST_ENTRY,
      title: 'List functions',
      description: 'Lists functions',
      inputSchema: z.object(COMMON_INPUT_SHAPE),
      responseShape: { Functions: z.array(z.looseObject({})), nextToken: z.string() },
    })).toThrow(new TypeError('aws_lambda_list_functions: output の nextToken は pecot-tools が足す項目と重なります'))
  })

  it('max-items のツールは NextToken と nextToken を足す', () => {
    expect(propertyNamesOf(LIST_TOOL)).toEqual(['Functions', 'NextToken', 'lines', 'output', 'truncated', 'nextToken', 'kind', 'detail', 'log', 'warnings'])
  })

  it('JSON を出すツールに responseShape が無いと、定義を作らずに例外を投げる', () => {
    expect(() => allowlistedTool({ entry: IDENTITY_ENTRY, ...BASE_SPEC }))
      .toThrow('responseShape is required exactly when the command has JSON output')
  })

  it('JSON を出さないツールに responseShape があると、定義を作らずに例外を投げる', () => {
    expect(() => allowlistedTool({ entry: LS_ENTRY, ...SPEC }))
      .toThrow('responseShape is required exactly when the command has JSON output')
  })

  it('ハンドラが、宣言に無い最上位のキーを落として warnings に名前を出す', async () => {
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'extra.stdout'), '{"UserId":"u","Account":"1","Arn":"a","NewKey":1}\n')
      fakeAws.install({ fixture: 'extra', fixtureDir: directory })

      const result = await callTool(allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }), {})

      expect(result['isError']).toBeUndefined()
      expect(result['structuredContent']).toEqual({
        UserId: 'u',
        Account: '1',
        Arn: 'a',
        warnings: ['Dropped undeclared top-level keys: NewKey'],
      })
    })
  })

  const ANNOTATION_CASES: readonly {
    readonly kind: AllowlistEntry['kind']
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
  }[] = [
    { kind: 'read', readOnlyHint: true, destructiveHint: false },
    { kind: 'execute', readOnlyHint: false, destructiveHint: false },
    { kind: 'auth', readOnlyHint: false, destructiveHint: false },
  ]

  it.each(ANNOTATION_CASES)(
    'kind $kind の annotations は readOnlyHint $readOnlyHint / destructiveHint $destructiveHint',
    (expected) => {
      const tool = allowlistedTool({ entry: { ...IDENTITY_ENTRY, kind: expected.kind }, ...SPEC })

      expect(tool.config.annotations).toEqual({
        readOnlyHint: expected.readOnlyHint,
        destructiveHint: expected.destructiveHint,
        openWorldHint: true,
      })
    },
  )

  it('ハンドラが executeAllowlisted の結果を CallToolResult にする', async () => {
    const instance = fakeAws.install()

    const result = await callTool(
      allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }),
      { region: 'ap-northeast-1' },
    )

    expect(result['isError']).toBeUndefined()
    expect(result['structuredContent']).toHaveProperty('Account')
    expect(commandCalls(instance)).toEqual([
      ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager', '--region', 'ap-northeast-1'],
    ])
  })

  it('reject をハンドラへ通す', async () => {
    const instance = fakeAws.install()
    const tool = allowlistedTool({
      entry: IDENTITY_ENTRY,
      ...SPEC,
      reject: arguments_ => (arguments_['region'] === undefined
        ? { kind: 'invalid-input', message: 'region が要ります' }
        : undefined),
    })

    const rejected = await callTool(tool, {})

    expect(rejected['isError']).toBe(true)
    expect(rejected['structuredContent']).toMatchObject({ kind: 'invalid-input' })
    expect(commandCalls(instance)).toEqual([])
  })

  it('timeoutMs をハンドラへ通す', async () => {
    fakeAws.install({ hang: true })
    const tool = allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }, { timeoutMs: 500 })

    const result = await callTool(tool, {})

    // hang する偽 awscli が 500ms で打ち切られる = timeoutMs が届いている。
    expect(result['structuredContent']).toMatchObject({ kind: 'timeout' })
  })
})

describe('MCP サーバ経由の並行実行', () => {
  it('5 件同時に投入すると 5 件目は先行の完了後に起動する', async () => {
    // research R9: 上限 4 の実行器で「5 件目が 4 件のいずれかの完了後に開始する」ことを
    // 偽 awscli の遅延で固定する。
    const instance = fakeAws.install({ sleepSeconds: 1 })

    const tool: ToolDefinition = {
      name: 'aws_sts_get_caller_identity',
      config: { title: 'Test tool', description: '並行上限の検証', inputSchema: z.object({}) },
      handler: async (_arguments, call) => {
        const result = await executeAllowlisted(IDENTITY_ENTRY, {}, call)
        return { content: [{ type: 'text', text: String(result.ok) }] }
      },
    }

    const connected = await connectMcp([tool])
    try {
      const calls = Array.from({ length: 5 }, async () =>
        connected.client.callTool({ name: 'aws_sts_get_caller_identity', arguments: {} }))

      await vi.waitFor(() => {
        expect(commandCalls(instance)).toHaveLength(4)
      }, { timeout: 10_000 })
      // 遅延 1 秒に対して 200ms の観測。5 件目が枠を待たずに起動していれば 5 になる。
      await delay(200)
      expect(commandCalls(instance)).toHaveLength(4)

      await Promise.all(calls)
      expect(commandCalls(instance)).toHaveLength(5)
    }
    finally {
      await closeMcp(connected)
    }
  }, 30_000)
})

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
import { explains } from '../../../../tests/_helpers/explains.js'
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
  it('全ツール共通の任意の入力として、profile と region を持つ', async () => {
    await explains('全ツールに共通の入力と出力の定義のテストです。`COMMON_INPUT_SHAPE` のキーが、`profile` と `region` の 2 つであることを確認します。')
    expect(Object.keys(COMMON_INPUT_SHAPE)).toEqual(['profile', 'region'])
  })

  it('ページ分割の 2 つの方式に、それぞれ入力を用意する', async () => {
    await explains('全ツールに共通の入力と出力の定義のテストです。`max-items` 方式と `limit` 方式のそれぞれで、ページングの入力名が契約どおりであることを確認します。')
    expect(Object.keys(MAX_ITEMS_PAGINATION_SHAPE)).toEqual(['max_items', 'starting_token'])
    expect(Object.keys(LIMIT_NEXT_TOKEN_PAGINATION_SHAPE)).toEqual(['limit', 'next_token', 'start_from_head'])
  })

  it('全ツールの outputSchema に並べる共通の項目は、kind、detail、log、warnings の 4 つになる', async () => {
    await explains('全ツールに共通の入力と出力の定義のテストです。`COMMON_OUTPUT_SHAPE` のキーが、`kind`、`detail`、`log`、`warnings` の 4 つであることを確認します。')
    expect(Object.keys(COMMON_OUTPUT_SHAPE)).toEqual(['kind', 'detail', 'log', 'warnings'])
  })

  it('既定の制限時間は、120 秒になる', async (context) => {
    await verifies(context, 'PT-COMMON-08')
    await explains('全ツールに共通の入力と出力の定義のテストです。`TOOL_TIMEOUT_MS` が `120000` ミリ秒であることを確認します。')
    expect(TOOL_TIMEOUT_MS).toBe(120_000)
  })
})

describe('executeAllowlisted', () => {
  it('JSON の出力は、そのまま data にして成功を返す', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。`sts get-caller-identity` を実行した場合は、`ok` が真で、JSON の出力が `data` に入り、期待した引数で awscli が呼ばれることを確認します。')
    const fake = fakeAws.install()

    const result = await executeAllowlisted(IDENTITY_ENTRY, { region: 'ap-northeast-1' }, CONTEXT)

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ Account: '123456789012' })
    expect(result.kind).toBeUndefined()
    expect(commandCalls(fake)).toEqual([
      ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager', '--region', 'ap-northeast-1'],
    ])
  })

  it('入力の検証で拒否したときは、awscli を起動しない', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。`max_items` に `0` を渡した場合に、種類が `invalid-input` の失敗を返し、awscli のコマンドが 1 回も呼ばれないことを確認します。')
    const fake = fakeAws.install()

    const result = await executeAllowlisted(LIST_ENTRY, { max_items: 0 }, CONTEXT)

    expect(result).toMatchObject({ ok: false, kind: 'invalid-input' })
    expect(commandCalls(fake)).toEqual([])
  })

  it('AccessDenied は permission-denied と判定し、log には資格情報を伏せ字にした出力を入れる', async (context) => {
    await verifies(context, 'PT-COMMON-12')
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。`AccessDeniedException` を出力する awscli を実行した場合は、`permission-denied` の失敗になり、`log` が伏せられることを確認します。')
    fakeAws.install({ fixture: 'access-denied' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({ ok: false, kind: 'permission-denied' })
    expect(detailOf(result)).toContain('permission-denied')
    const log = String(result.data['log'])
    expect(log).toContain('AccessDeniedException')
    expect(log).toContain('[redacted]')
    expect(log).not.toContain('IQoJb3JpZ2luX2VjEXAMPLETOKEN')
  })

  it('終了コードが 252 のときは、invalid-input と判定する', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。終了コード `252` で終了する awscli を実行した場合に、種類が `invalid-input` の失敗を返すことを確認します。')
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

  it.each(CAPTURED_FIXTURES)('実際に採取した失敗のフィクスチャ $fixture は、$kind と判定する', async (captured) => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。実際の awscli から採取した stderr と終了コードを再現するフィクスチャを実行した場合は、`auth-missing` など期待した種類の失敗になることを確認します。')
    fakeAws.install({ fixture: captured.fixture })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({
      ok: false,
      kind: captured.kind,
    })
  })

  it('時間切れになったときは、timeout と判定する', async (context) => {
    await verifies(context, 'PT-COMMON-08')
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。終了しない awscli を 500 ミリ秒の制限時間で実行した場合に、種類が `timeout` の失敗を返し、`detail` に範囲を絞るよう促す文が含まれることを確認します。')
    fakeAws.install({ hang: true })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, { timeoutMs: 500 })

    expect(result).toMatchObject({ ok: false, kind: 'timeout' })
    expect(detailOf(result)).toContain('Narrow the range')
  })

  it('awscli が導入されていないときは、awscli-missing と判定する', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。PATH に awscli が存在しない場合は、種類が `awscli-missing` の失敗を返し、`detail` に `PATH` が含まれることを確認します。')
    fakeAws.withoutAws()

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({ ok: false, kind: 'awscli-missing' })
    expect(detailOf(result)).toContain('PATH')
  })

  it('出力の NextToken を、nextToken にも設定する', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。ページ分割された出力を返す awscli を実行した場合に、`data` に `NextToken` と同じ値の `nextToken` が含まれることを確認します。')
    fakeAws.install({ fixture: 'paginated' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result.data).toMatchObject({ NextToken: 'eyJuZXh0IjogMX0=', nextToken: 'eyJuZXh0IjogMX0=' })
  })

  it('ページ分割を持たないツールは、nextToken を作らない', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。ページ分割のないツールで、`NextToken` を含む出力を受け取った場合に、`data` に `nextToken` が含まれないことを確認します。')
    fakeAws.install({ fixture: 'paginated' })

    const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

    expect(result.data).not.toHaveProperty('nextToken')
  })

  it('JSON の出力を持たないツールは、出力を行の配列にして返す', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。`s3 ls` のように JSON を出力しないコマンドを実行した場合に、`data` が `lines` に出力の各行を入れたものになることを確認します。')
    fakeAws.install({ fixture: 's3-ls' })

    const result = await executeAllowlisted(LS_ENTRY, {}, CONTEXT)

    expect(result.data).toEqual({
      lines: ['2026-09-01 10:00:00       1024 report.json', '                           PRE logs/'],
    })
  })

  it('出力が空のときは、空の行の配列を返す', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。標準出力が空の場合は、`data` が空の配列を持つ `lines` になることを確認します。')
    fakeAws.install({ fixture: 'no-such-fixture' })

    const result = await executeAllowlisted(LS_ENTRY, {}, CONTEXT)

    expect(result.data).toEqual({ lines: [] })
  })

  it('出力がオブジェクトではない JSON のときは、行の配列として返す', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。出力が `[1, 2]` のような配列の JSON の場合に、`data` が元の文字列を 1 行とした `lines` になることを確認します。')
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'array.stdout'), '[1, 2]\n')
      fakeAws.install({ fixture: 'array', fixtureDir: directory })

      const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

      expect(result.data).toEqual({ lines: ['[1, 2]'] })
    })
  })

  it('出力が JSON として解析できないときは、行の配列として返す', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。JSON のコマンドが警告の文字列だけを出力した場合に、`data` がその行を含む `lines` になることを確認します。')
    // jsonOutput のツールでも警告行だけが返ることがある（JSON.parse が失敗する場合）。
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'broken.stdout'), 'not json at all\n')
      fakeAws.install({ fixture: 'broken', fixtureDir: directory })

      const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

      expect(result.data).toEqual({ lines: ['not json at all'] })
    })
  })

  it('成功したときの標準出力に含まれる資格情報も、伏せ字にする', async (context) => {
    await verifies(context, 'PT-COMMON-15')
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。成功の出力に `AKIA` で始まるアクセスキー ID が含まれる場合に、`data` の値が `[redacted]` に置き換わることを確認します。')
    // SC-006 は応答全体が対象。log 側だけ固定すると、成功時の退行を見逃す。
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'leaky.stdout'), '{"AccessKeyId":"AKIAIOSFODNN7EXAMPLE"}\n')
      fakeAws.install({ fixture: 'leaky', fixtureDir: directory })

      const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

      expect(result.ok).toBe(true)
      expect(result.data).toEqual({ AccessKeyId: '[redacted]' })
    })
  })

  it('log が上限を超えたときは、切り詰めたことを detail に残す', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。上限を超える標準エラー出力を出して失敗した場合に、`log` が上限のバイト数に収まり、`detail` に `log exceeded the limit` が含まれることを確認します。')
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

  it('失敗したときの structuredContent も、outputSchema に適合する', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。`AccessDenied` で失敗した結果を、必須項目の宣言がある場合とない場合の両方の出力スキーマで検証した場合に、問題が 0 件であることを確認します。')
    // SDK の validateToolOutput は isError が真なら検証を省くため、失敗時のずれは
    // プロトコル越しでは検出されない。ここで直接スキーマに掛ける。
    fakeAws.install({ fixture: 'access-denied' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)
    const content = toCallToolResult(result).structuredContent

    expect(await outputSchemaIssues(LIST_TOOL, content)).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, content)).toEqual([])
  })

  it('失敗したときは、最上位に kind と detail を置き、reason と stderr を含めない', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。`AccessDenied` で失敗した結果を変換した場合に、`structuredContent` に `kind` と `detail` が含まれ、`reason` と `stderr` が含まれないことを確認します。')
    fakeAws.install({ fixture: 'access-denied' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)
    const content = toCallToolResult(result).structuredContent

    expect(content).not.toHaveProperty('stderr')
    expect(content).toMatchObject({ kind: 'permission-denied', detail: detailOf(result) })
    expect(content).not.toHaveProperty('reason')
  })

  it('成功したときは、stderr、log、入れ物の項目を含めない', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。成功した結果を変換した場合に、`structuredContent` に `stderr`、`log`、`ok`、`exitCode`、`data`、`artifacts`、`message` が含まれないことを確認します。')
    fakeAws.install()

    const content = toCallToolResult(await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)).structuredContent

    expect(content).not.toHaveProperty('stderr')
    expect(content).not.toHaveProperty('log')
    for (const key of ['ok', 'exitCode', 'data', 'artifacts', 'message']) expect(content).not.toHaveProperty(key)
  })

  it('必須の項目を宣言しないツールの outputSchema は、宣言した項目を任意として受け付け、宣言にない項目や型が違う項目を拒否する', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。必須の宣言がないツールの出力スキーマで、空のオブジェクトや宣言した項目は問題がなく、宣言にない `Account` や型が違う `log` は問題として検出されることを確認します。')
    expect(await outputSchemaIssues(LIST_TOOL, {})).toEqual([])
    expect(await outputSchemaIssues(LIST_TOOL, { Functions: [], NextToken: 't', nextToken: 't' })).toEqual([])
    expect(await outputSchemaIssues(LIST_TOOL, { lines: [] })).toEqual([])
    expect(await outputSchemaIssues(LIST_TOOL, { Account: '1' })).not.toEqual([])
    expect(await outputSchemaIssues(LIST_TOOL, { log: 1 })).not.toEqual([])
  })

  it('必須の項目を宣言したツールの outputSchema は、成功の形のどれか、または kind と detail を求める', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。必須の項目を宣言したツールの出力スキーマで、`Functions` や `lines`、`kind` と `detail` のいずれかがあれば問題がなく、空のオブジェクトは問題として検出されることを確認します。')
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { Functions: [] })).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { lines: [] })).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { output: 'x', truncated: true })).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { kind: 'timeout', detail: 'd' })).toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, {})).not.toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { NextToken: 't', nextToken: 't' })).not.toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { output: 'x' })).not.toEqual([])
    expect(await outputSchemaIssues(REQUIRED_LIST_TOOL, { kind: 'timeout' })).not.toEqual([])
  })

  it('宣言したキーだけを残し、取り除いたキーの名前を warnings に 1 行で入れる', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。宣言にない `NewKey` と `Other` を含む出力を、宣言したキーで絞った場合に、宣言したキーだけが `data` に残り、`warnings` に取り除いたキーの名前が 1 行で入ることを確認します。')
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

  it('取り除くキーがないときは、warnings を追加しない', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。宣言したキーだけの出力を、宣言したキーで絞った場合に、`data` に `warnings` が含まれないことを確認します。')
    fakeAws.install()

    const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT, { responseKeys: IDENTITY_KEYS })

    expect(result.data).not.toHaveProperty('warnings')
    expect(Object.keys(result.data).every(key => IDENTITY_KEYS.has(key))).toBe(true)
  })

  it('宣言したキーで絞っても、NextToken を nextToken にも設定する', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。`Functions` と `NextToken` を宣言したキーで絞った場合に、`nextToken` に `NextToken` と同じ値が設定され、`warnings` が含まれないことを確認します。')
    fakeAws.install({ fixture: 'paginated' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, { responseKeys: new Set(['Functions', 'NextToken']) })

    expect(result.data).toMatchObject({ NextToken: 'eyJuZXh0IjogMX0=', nextToken: 'eyJuZXh0IjogMX0=' })
    expect(result.data).not.toHaveProperty('warnings')
  })

  it('出力が上限を超えたときは、先頭を残して切り詰め、truncated を真にする', async (context) => {
    await verifies(context, 'PT-COMMON-11')
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。上限を超える JSON の出力を受け取った場合は、`truncated` が真になり、`output` が上限のバイト数以内になり、`max_items` の案内が含まれることを確認します。')
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

  it('キャンセルされたときは、awscli のプロセスに SIGTERM を伝える', async () => {
    await explains('偽の awscli を PATH の先頭に置いて、許可リストのコマンドを実行する `executeAllowlisted` を呼び出すテストです。実行中に `AbortController` で中断した場合は、`ok` が偽の失敗を返し、種類が `timeout` ではないことを確認します。')
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
  it('reject が理由を返したときは、awscli を起動せず、その種類とメッセージで失敗を返す', async () => {
    await explains('実行前の拒否の仕組み（`reject`）のテストです。`reject` が `not-allowed` の理由を返した場合に、その種類と文で失敗を返し、awscli が 1 回も呼ばれないことを確認します。')
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

  it('reject が invalid-input を返したときも、awscli を起動せず失敗を返す', async () => {
    await explains('実行前の拒否の仕組み（`reject`）のテストです。`reject` が `invalid-input` の理由を返した場合に、種類が `invalid-input` の失敗を返し、awscli が 1 回も呼ばれないことを確認します。')
    const fake = fakeAws.install()

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, {
      reject: () => ({ kind: 'invalid-input', message: '書き出し先が既にあります' }),
    })

    expect(result).toMatchObject({ ok: false, kind: 'invalid-input' })
    expect(fake.callLog()).toEqual([])
  })

  it('reject が undefined を返したときは、通常どおり実行する', async () => {
    await explains('実行前の拒否の仕組み（`reject`）のテストです。`reject` が `undefined` を返した場合に、`ok` が真で、awscli が 1 回呼ばれることを確認します。')
    const fake = fakeAws.install()

    const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT, { reject: NO_REJECTION })

    expect(result.ok).toBe(true)
    expect(commandCalls(fake)).toHaveLength(1)
  })

  it('reject は、許可リストの入力の検証より後、awscli の存在確認より前に働く', async () => {
    await explains('実行前の拒否の仕組み（`reject`）のテストです。awscli が未導入でも、入力の検証に失敗した場合は `invalid-input`、`reject` が拒否した場合は `not-allowed` になることを確認します。')
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

  it('ツール名には、許可リストのエントリのツール名を使う', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。エントリからツール定義を作った場合に、ツール名が `aws_sts_get_caller_identity` になることを確認します。')
    expect(allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }).name).toBe('aws_sts_get_caller_identity')
  })

  it('JSON を出力するツールの outputSchema は、応答のキー、awscli の出力の項目、共通の 4 項目を並べる', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。JSON を出力するツールの出力スキーマで、プロパティが応答のキー・`lines`・`output`・`truncated`・共通の項目の順に並ぶことを確認します。')
    const tool = allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC })

    expect(propertyNamesOf(tool)).toEqual(['UserId', 'Account', 'Arn', 'lines', 'output', 'truncated', 'kind', 'detail', 'log', 'warnings'])
    expect(outputJsonSchemaOf(tool)['additionalProperties']).toBe(false)
  })

  it('JSON を出力するツールは、responseRequired を指定したときだけ anyOf を設定する', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。`responseRequired` がない場合は出力スキーマに `anyOf` がなく、ある場合は応答のキーと `lines` などを条件とする 4 つの枝になることを確認します。')
    expect(outputJsonSchemaOf(allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }))).not.toHaveProperty('anyOf')
    expect(outputJsonSchemaOf(REQUIRED_LIST_TOOL)['anyOf']).toEqual([
      { required: ['Functions'] },
      { required: ['lines'] },
      { required: ['output', 'truncated'] },
      { required: ['kind', 'detail'] },
    ])
  })

  it('JSON を出力しないツールは、lines、output と truncated、kind と detail のいずれかを anyOf で求める', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。JSON を出力しないツールの出力スキーマの `anyOf` が、`lines`、`output` と `truncated`、`kind` と `detail` の 3 つの条件になることを確認します。')
    const listing = allowlistedTool({ entry: LS_ENTRY, ...BASE_SPEC })

    expect(outputJsonSchemaOf(listing)['anyOf']).toEqual([
      { required: ['lines'] },
      { required: ['output', 'truncated'] },
      { required: ['kind', 'detail'] },
    ])
  })

  it('responseRequired のキーが responseShape に存在しないときは、定義を作らず例外を発生させる', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。`responseShape` が持たないキーを `responseRequired` へ指定した場合は、`has keys not in` を含む例外が発生することを確認します。')
    expect(() => allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC, responseRequired: ['Missing'] }))
      .toThrow('responseRequired has keys not in responseShape: Missing')
  })

  it.for(['kind', 'detail', 'log', 'warnings'])('responseShape が共通の項目の名前 %s を持つときは、定義を作らず例外を発生させる', async (key) => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。`responseShape` に `kind`、`detail`、`log`、`warnings` のいずれかのキーを含めた場合に、共通の項目と重複することを示す `TypeError` が発生することを確認します。')
    expect(() => allowlistedTool({ entry: IDENTITY_ENTRY, ...BASE_SPEC, responseShape: { ...IDENTITY_RESPONSE_SHAPE, [key]: z.string() } }))
      .toThrow(new TypeError(`aws_sts_get_caller_identity: output keys reserved for the common fields of the MCP result: ${key}`))
  })

  it.for(['lines', 'output', 'truncated'])('responseShape が pecot-tools の追加する項目の名前 %s を持つときは、定義を作らず例外を発生させる', async (key) => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。`responseShape` に `lines` などの pecot-tools が追加する項目を含めた場合は、重複を示す `TypeError` が発生することを確認します。')
    expect(() => allowlistedTool({ entry: IDENTITY_ENTRY, ...BASE_SPEC, responseShape: { ...IDENTITY_RESPONSE_SHAPE, [key]: z.string() } }))
      .toThrow(new TypeError(`aws_sts_get_caller_identity: output keys that overlap the fields pecot-tools adds: ${key}`))
  })

  it('max-items のツールの responseShape が nextToken を持つときは、定義を作らず例外を発生させる', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。`max-items` 方式のツールで `responseShape` に `nextToken` を含めた場合に、追加する項目と重複することを示す `TypeError` が発生することを確認します。')
    expect(() => allowlistedTool({
      entry: LIST_ENTRY,
      title: 'List functions',
      description: 'Lists functions',
      inputSchema: z.object(COMMON_INPUT_SHAPE),
      responseShape: { Functions: z.array(z.looseObject({})), nextToken: z.string() },
    })).toThrow(new TypeError('aws_lambda_list_functions: output keys that overlap the fields pecot-tools adds: nextToken'))
  })

  it('max-items のツールは、出力スキーマに NextToken と nextToken を追加する', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。`max-items` 方式のツールの出力スキーマのプロパティに、`NextToken` と `nextToken` が決まった順序で含まれることを確認します。')
    expect(propertyNamesOf(LIST_TOOL)).toEqual(['Functions', 'NextToken', 'lines', 'output', 'truncated', 'nextToken', 'kind', 'detail', 'log', 'warnings'])
  })

  it('JSON を出力するツールに responseShape がないときは、定義を作らず例外を発生させる', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。JSON を出力するエントリで `responseShape` を省略した場合は、`responseShape is required` を含む例外が発生することを確認します。')
    expect(() => allowlistedTool({ entry: IDENTITY_ENTRY, ...BASE_SPEC }))
      .toThrow('responseShape is required exactly when the command has JSON output')
  })

  it('JSON を出力しないツールに responseShape があるときは、定義を作らず例外を発生させる', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。JSON を出力しないエントリで `responseShape` を指定した場合は、`responseShape is required` を含む例外が発生することを確認します。')
    expect(() => allowlistedTool({ entry: LS_ENTRY, ...SPEC }))
      .toThrow('responseShape is required exactly when the command has JSON output')
  })

  it('ハンドラは、宣言にない最上位のキーを取り除き、warnings にそのキーの名前を入れる', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。宣言にない `NewKey` を含む出力を返す awscli を MCP 経由で呼び出した場合は、宣言したキーだけが残り、`warnings` に `NewKey` が入ることを確認します。')
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
    readonly expected: Readonly<Record<string, boolean>>
  }[] = [
    { kind: 'read', expected: { readOnlyHint: true, openWorldHint: true } },
    { kind: 'execute', expected: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  ]

  it.each(ANNOTATION_CASES)(
    '種類が $kind のツールの annotations は、$expected になる',
    async ({ kind, expected }) => {
      await explains('許可リストのエントリからツール定義を作る `allowlistedTool` の `annotations` のテストです。種類ごとに、読むだけか書き込むかに合ったヒントだけを持つことを確認します。')
      const tool = allowlistedTool({ entry: { ...IDENTITY_ENTRY, kind }, ...SPEC })

      expect(tool.config.annotations).toStrictEqual(expected)
    },
  )

  it('ハンドラは、executeAllowlisted の結果を CallToolResult に変換する', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。`region` を指定してツールを呼び出した場合は、`isError` が未設定で、`Account` が含まれ、`--region` 付きの引数で awscli が呼ばれることを確認します。')
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

  it('指定した reject を、ハンドラで有効にする', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。`region` が未指定のときに拒否する `reject` を指定してツールを呼び出した場合に、`isError` が真で種類が `invalid-input` になり、awscli が呼ばれないことを確認します。')
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

  it('指定した timeoutMs を、ハンドラで有効にする', async () => {
    await explains('許可リストのエントリからツール定義を作る `allowlistedTool` のテストです。制限時間を 500 ミリ秒にして、終了しない awscli を呼び出した場合に、`structuredContent` の種類が `timeout` になることを確認します。')
    fakeAws.install({ hang: true })
    const tool = allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }, { timeoutMs: 500 })

    const result = await callTool(tool, {})

    // hang する偽 awscli が 500ms で打ち切られる = timeoutMs が届いている。
    expect(result['structuredContent']).toMatchObject({ kind: 'timeout' })
  })
})

describe('MCP サーバ経由の並行実行', () => {
  it('5 件を同時に呼び出すと、5 件目は先行の呼び出しの完了後に起動する', async () => {
    await explains('MCP サーバ経由の並行実行のテストです。1 秒かかる偽の awscli を 5 件同時に呼び出した場合に、起動するのが 4 件までで、完了後に 5 件目が起動することを確認します。')
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

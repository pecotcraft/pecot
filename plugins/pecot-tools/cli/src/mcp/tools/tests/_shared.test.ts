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

import type { AllowlistEntry, FailureCategory } from '../../../domain/allowlist.js'
import { OUTPUT_LIMIT_BYTES, resetAwscliProbe } from '../../../infra/awscli.js'
import { toCallToolResult } from '../../result.js'
import type { ToolDefinition } from '../../server.js'
import { closeMcp, connectMcp } from '../../tests/_client.js'
import {
  allowlistedTool,
  COMMON_INPUT_SHAPE,
  executeAllowlisted,
  LIMIT_NEXT_TOKEN_PAGINATION_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  TOOL_OUTPUT_SCHEMA,
  TOOL_TIMEOUT_MS,
} from '../_shared.js'
import { type FakeAws, useFakeAws } from '../../../../tests/_helpers/fake-aws.js'

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

const FETCH_ENTRY: AllowlistEntry = {
  toolName: 'aws_s3_cp',
  service: 's3',
  subcommand: 'cp',
  kind: 'fetch',
  jsonOutput: false,
  pagination: 'none',
  inputs: [
    { name: 's3_uri', kind: 's3-uri', required: true, positional: 0 },
    { name: 'local_path', kind: 'abs-path', required: true, positional: 1 },
  ],
}

const CONTEXT = { signal: new AbortController().signal }

/**
何も拒否しない reject。空の関数本体だと「拒否しないことを意図している」と読めない。
*/
const NO_REJECTION = (): undefined => undefined

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

  it('outputSchema は ExecutionResult と同形', () => {
    expect(Object.keys(TOOL_OUTPUT_SCHEMA.shape))
      .toEqual(['ok', 'exitCode', 'category', 'data', 'artifacts', 'message', 'stderr'])
  })

  it('既定の制限時間は 120 秒', () => {
    expect(TOOL_TIMEOUT_MS).toBe(120_000)
  })
})

describe('executeAllowlisted', () => {
  it('JSON 出力をそのまま data にして成功を返す', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(IDENTITY_ENTRY, { region: 'ap-northeast-1' }, CONTEXT)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(result.data).toMatchObject({ Account: '123456789012' })
    expect(result.category).toBeUndefined()
    expect(commandCalls(fake)).toEqual([
      ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager', '--region', 'ap-northeast-1'],
    ])
  })

  it('検証で弾いたときは awscli を起動しない', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(LIST_ENTRY, { max_items: 0 }, CONTEXT)

    expect(result).toMatchObject({ ok: false, exitCode: 2, category: 'invalid-input' })
    expect(commandCalls(fake)).toEqual([])
  })

  it('AccessDenied を permission-denied にし、stderr の秘密を伏せる', async () => {
    fakeAws.install({ fixture: 'access-denied' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({ ok: false, exitCode: 254, category: 'permission-denied' })
    expect(result.message).toContain('permission-denied')
    expect(result.stderr).toContain('AccessDeniedException')
    expect(result.stderr).toContain('[redacted]')
    expect(result.stderr).not.toContain('IQoJb3JpZ2luX2VjEXAMPLETOKEN')
  })

  it('終了コード 252 を invalid-input にする', async () => {
    fakeAws.install({ fixture: 'invalid-input' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({ ok: false, exitCode: 252, category: 'invalid-input' })
  })

  // 実 awscli 2.36.40（2026-09-07 採取）の stderr と終了コードをそのまま置いた fixture。
  // 分類器の単体テストとは別に、実出力が実行処理を通っても同じ種別になることを見る。
  const CAPTURED_FIXTURES: readonly {
    readonly fixture: string
    readonly exitCode: number
    readonly category: FailureCategory
  }[] = [
    { fixture: 'no-credentials', exitCode: 253, category: 'auth-missing' },
    { fixture: 's3-cp-no-credentials', exitCode: 1, category: 'auth-missing' },
    { fixture: 'profile-not-found', exitCode: 255, category: 'auth-missing' },
    { fixture: 'sso-token-expired', exitCode: 255, category: 'auth-expired' },
    { fixture: 'invalid-token', exitCode: 254, category: 'auth-expired' },
  ]

  it.each(CAPTURED_FIXTURES)('実採取 fixture $fixture を $category にする', async (captured) => {
    fakeAws.install({ fixture: captured.fixture })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({
      ok: false,
      exitCode: captured.exitCode,
      category: captured.category,
    })
  })

  it('時間切れは exitCode 124 の timeout にする', async () => {
    fakeAws.install({ hang: true })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, { timeoutMs: 500 })

    expect(result).toMatchObject({ ok: false, exitCode: 124, category: 'timeout' })
    expect(result.message).toContain('取得範囲')
  })

  it('awscli 未導入は exitCode 127 の awscli-missing にする', async () => {
    fakeAws.withoutAws()

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

    expect(result).toMatchObject({ ok: false, exitCode: 127, category: 'awscli-missing' })
    expect(result.message).toContain('PATH')
  })

  it('NextToken を data.nextToken へ転記する', async () => {
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

  it('成功時の stdout も秘匿化する', async () => {
    // SC-006 は応答全体が対象。stderr 側だけ固定すると、成功時の退行を見逃す。
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'leaky.stdout'), '{"AccessKeyId":"AKIAIOSFODNN7EXAMPLE"}\n')
      fakeAws.install({ fixture: 'leaky', fixtureDir: directory })

      const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

      expect(result.ok).toBe(true)
      expect(result.data).toEqual({ AccessKeyId: '[redacted]' })
    })
  })

  it('stderr が上限を超えたら切り詰めたことを message に残す', async () => {
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'noisy.stderr'), 'y'.repeat(OUTPUT_LIMIT_BYTES + 1024))
      writeFileSync(path.join(directory, 'noisy.exit'), '254\n')
      fakeAws.install({ fixture: 'noisy', fixtureDir: directory })

      const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

      expect(result.ok).toBe(false)
      expect(Buffer.byteLength(result.stderr ?? '', 'utf8')).toBe(OUTPUT_LIMIT_BYTES)
      expect(result.message).toContain('stderr は上限')
    })
  })

  it('失敗時の structuredContent も outputSchema に適合する', async () => {
    // SDK の validateToolOutput は isError が真なら検証を省くため、失敗時のずれは
    // プロトコル越しでは検出されない。ここで直接スキーマに掛ける。
    fakeAws.install({ fixture: 'access-denied' })

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)
    const parsed = TOOL_OUTPUT_SCHEMA.safeParse(toCallToolResult(result).structuredContent)

    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  it('上限を超える出力は先頭を残して truncated を立てる', async () => {
    await withFixtureDirectory(async (directory) => {
      const body = `{"Functions":["${'x'.repeat(OUTPUT_LIMIT_BYTES)}"]}`
      writeFileSync(path.join(directory, 'large.stdout'), body)
      fakeAws.install({ fixture: 'large', fixtureDir: directory })

      const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT)

      expect(result.ok).toBe(true)
      expect(result.data).toMatchObject({ truncated: true })
      expect(result.message).toContain('max_items')
      expect(result.message).toContain('starting_token')
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
    expect(result.category).not.toBe('timeout')
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
  it('reject が理由を返したら awscli を起動せず exitCode 2 で返す', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, {
      reject: () => ({ category: 'not-allowed', message: '変更系クエリは実行できません' }),
    })

    expect(result).toMatchObject({
      ok: false,
      exitCode: 2,
      category: 'not-allowed',
      message: '変更系クエリは実行できません',
    })
    expect(fake.callLog()).toEqual([])
  })

  it('reject は invalid-input も返せる', async () => {
    const fake = fakeAws.install()

    const result = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, {
      reject: () => ({ category: 'invalid-input', message: '書き出し先が既にあります' }),
    })

    expect(result).toMatchObject({ ok: false, exitCode: 2, category: 'invalid-input' })
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
      reject: () => ({ category: 'not-allowed', message: '拒否' }),
    })
    const rejectedByHook = await executeAllowlisted(LIST_ENTRY, {}, CONTEXT, {
      reject: () => ({ category: 'not-allowed', message: '拒否' }),
    })

    expect(rejectedByValidation.category).toBe('invalid-input')
    expect(rejectedByHook.category).toBe('not-allowed')
  })
})

describe('artifacts', () => {
  it('成功時に artifactsOf の戻り値を載せる', async () => {
    fakeAws.install({ fixture: 's3-cp' })

    const result = await executeAllowlisted(
      FETCH_ENTRY,
      { s3_uri: 's3://bucket/report.json', local_path: '/var/data/report.json' },
      CONTEXT,
      { artifactsOf: arguments_ => [String(arguments_['local_path'])] },
    )

    expect(result.ok).toBe(true)
    expect(result.artifacts).toEqual(['/var/data/report.json'])
  })

  it('出力が切り詰められても artifacts は載せる', async () => {
    // 書き出しは awscli 側で終わっている。応答の切り詰めは出力が長いことしか意味しない。
    await withFixtureDirectory(async (directory) => {
      writeFileSync(path.join(directory, 'huge.stdout'), 'x'.repeat(OUTPUT_LIMIT_BYTES + 1024))
      fakeAws.install({ fixture: 'huge', fixtureDir: directory })

      const result = await executeAllowlisted(
        FETCH_ENTRY,
        { s3_uri: 's3://bucket/report.json', local_path: '/var/data/report.json' },
        CONTEXT,
        { artifactsOf: () => ['/var/data/report.json'] },
      )

      expect(result.data).toMatchObject({ truncated: true })
      expect(result.artifacts).toEqual(['/var/data/report.json'])
    })
  })

  it('artifactsOf が無ければ空配列', async () => {
    fakeAws.install()

    const result = await executeAllowlisted(IDENTITY_ENTRY, {}, CONTEXT)

    expect(result.artifacts).toEqual([])
  })

  it('失敗時は artifactsOf があっても載せない', async () => {
    fakeAws.install({ fixture: 's3-cp-no-credentials' })

    const result = await executeAllowlisted(
      FETCH_ENTRY,
      { s3_uri: 's3://bucket/report.json', local_path: '/var/data/report.json' },
      CONTEXT,
      { artifactsOf: () => ['/var/data/report.json'] },
    )

    expect(result.ok).toBe(false)
    expect(result.artifacts).toEqual([])
  })
})

describe('allowlistedTool', () => {
  const SPEC = {
    title: '呼び出し元 ID の確認',
    description: '現在の認証情報が示すアカウントを返す',
    inputSchema: z.object(COMMON_INPUT_SHAPE),
  }

  it('ツール名は許可リストのエントリ名を使う', () => {
    expect(allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }).name).toBe('aws_sts_get_caller_identity')
  })

  it('outputSchema は全ツールで共通', () => {
    expect(allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }).config.outputSchema)
      .toBe(TOOL_OUTPUT_SCHEMA)
  })

  const ANNOTATION_CASES: readonly {
    readonly kind: AllowlistEntry['kind']
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
  }[] = [
    { kind: 'read', readOnlyHint: true, destructiveHint: false },
    // fetch だけ destructiveHint が true。overwrite: true はローカルの既存ファイルを戻せない形で壊す。
    { kind: 'fetch', readOnlyHint: false, destructiveHint: true },
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
    expect(result['structuredContent']).toMatchObject({ ok: true, exitCode: 0 })
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
        ? { category: 'invalid-input', message: 'region が要ります' }
        : undefined),
    })

    const rejected = await callTool(tool, {})

    expect(rejected['isError']).toBe(true)
    expect(rejected['structuredContent']).toMatchObject({ exitCode: 2, category: 'invalid-input' })
    expect(commandCalls(instance)).toEqual([])
  })

  it('timeoutMs をハンドラへ通す', async () => {
    fakeAws.install({ hang: true })
    const tool = allowlistedTool({ entry: IDENTITY_ENTRY, ...SPEC }, { timeoutMs: 500 })

    const result = await callTool(tool, {})

    // hang する偽 awscli が 500ms で打ち切られる = timeoutMs が届いている。
    expect(result['structuredContent']).toMatchObject({ exitCode: 124, category: 'timeout' })
  })
})

describe('MCP サーバ経由の並行実行', () => {
  it('5 件同時に投入すると 5 件目は先行の完了後に起動する', async () => {
    // research R9: 上限 4 の実行器で「5 件目が 4 件のいずれかの完了後に開始する」ことを
    // 偽 awscli の遅延で固定する。
    const instance = fakeAws.install({ sleepSeconds: 1 })

    const tool: ToolDefinition = {
      name: 'aws_sts_get_caller_identity',
      config: { description: '並行上限の検証', inputSchema: z.object({}) },
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

// commands/evidence-xlsx/create.ts の unit test。
// fs は DI で差し替え、spec の読込・parse・検証の各失敗と --json ON/OFF の出力を pin する。
// commander 自身の usage エラー (--input 未指定) は process.argv を触る必要がある。
// そのため integration 側 (tests/integration/commands/evidence-create.test.ts) に置く。

import { describe, expect, it, vi } from 'vitest'

import type { EvidenceCreateDependencies } from '../../../src/commands/evidence-xlsx/create.js'
import {
  createEvidenceCreateCommand,
  EvidenceCreateError,
  evidenceCreateDefaultDependencies,
  runEvidenceCreate,
} from '../../../src/commands/evidence-xlsx/create.js'
import type { EvidenceWriteResult } from '../../../src/infra/evidence-xlsx/workbook-writer.js'
import { defaultLintText } from '../../../src/infra/text-lint.js'
import { EvidenceWorkbookError, writeEvidenceWorkbook } from '../../../src/infra/evidence-xlsx/workbook-writer.js'

interface CapturedStream {
  readonly chunks: string[]
  write: (data: string) => boolean
}

function makeStream(): CapturedStream {
  const chunks: string[] = []
  return {
    chunks,
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write を持つ stub
function asStream(captured: CapturedStream): NodeJS.WritableStream {
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return captured as unknown as NodeJS.WritableStream
}

// 違反文を literal で持たない。語を分けて組み立てる。
const HYPE_WORDS = ['ゲーム', 'チェンジャー'].join('')
const HYPE = [HYPE_WORDS, 'となる基盤です。'].join('')

const VALID_SPEC = {
  title: 'ログイン機能 動作確認エビデンス',
  createdDate: '2026-08-17',
  extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
  items: [{ imagePath: '/img/01-login.png' }],
}

function writeResult(overrides: Partial<EvidenceWriteResult> = {}): EvidenceWriteResult {
  return {
    outPath: '/abs/evidence.xlsx',
    items: 1,
    annotations: 0,
    skipped: [],
    ...overrides,
  }
}

function buildDependencies(overrides: Partial<EvidenceCreateDependencies> = {}): EvidenceCreateDependencies {
  return {
    stdout: overrides.stdout ?? asStream(makeStream()),
    stderr: overrides.stderr ?? asStream(makeStream()),
    readFile: overrides.readFile ?? (() => Promise.resolve(JSON.stringify(VALID_SPEC))),
    lintText: overrides.lintText ?? defaultLintText,
    writeWorkbook: overrides.writeWorkbook ?? (() => Promise.resolve(writeResult())),
  }
}

describe('runEvidenceCreate', () => {
  it('検証を通った spec と outPath で writeWorkbook を呼ぶ (caption は補完済み)', async () => {
    const writeWorkbook = vi.fn<EvidenceCreateDependencies['writeWorkbook']>(
      () => Promise.resolve(writeResult()),
    )
    const result = await runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ writeWorkbook }),
    )

    expect(result.outPath).toBe('/abs/evidence.xlsx')
    expect(writeWorkbook).toHaveBeenCalledTimes(1)
    expect(writeWorkbook.mock.calls[0]?.[0]).toStrictEqual({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      items: [{ imagePath: '/img/01-login.png', caption: '01-login', annotations: [] }],
    })
    expect(writeWorkbook.mock.calls[0]?.[1]).toBe('/abs/out.xlsx')
  })

  it('spec が読めないと input-not-found', async () => {
    await expect(runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ readFile: () => Promise.reject(new Error('ENOENT: no such file')) }),
    )).rejects.toMatchObject({ name: 'EvidenceCreateError', reason: 'input-not-found' })
  })

  it('JSON として破損していると invalid-json', async () => {
    await expect(runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ readFile: () => Promise.resolve('{ "title": ') }),
    )).rejects.toMatchObject({ name: 'EvidenceCreateError', reason: 'invalid-json' })
  })

  it('検証エラーは invalid-spec でパス付き全件をメッセージに載せる', async () => {
    const broken = {
      title: '',
      createdDate: '2026-02-31',
      items: [{
        imagePath: '/img/01.png',
        annotations: [{ type: 'callout', text: 'x', box: { x: 0.9, y: 0, w: 0.3, h: 0.1 }, anchor: { x: 0.5, y: 0.5 } }],
      }],
    }
    let caught: unknown
    try {
      await runEvidenceCreate(
        '/abs/spec.json',
        '/abs/out.xlsx',
        buildDependencies({ readFile: () => Promise.resolve(JSON.stringify(broken)) }),
      )
    }
    catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(EvidenceCreateError)
    expect(caught).toMatchObject({ reason: 'invalid-spec' })
    const message = caught instanceof Error ? caught.message : ''
    expect(message).toContain('- title: 空文字列は許可されていません')
    expect(message).toContain('- createdDate: 暦に存在しない日付です (値: 2026-02-31)')
    expect(message).toContain('- items[0].annotations[0].box.w: x + w が 1 を超えます')
  })

  it('ルート自身のエラーはパスを (root) と表示する', async () => {
    let caught: unknown
    try {
      await runEvidenceCreate(
        '/abs/spec.json',
        '/abs/out.xlsx',
        // spec が object ではない (配列) ケース。SpecValidationError.path は空文字になる。
        buildDependencies({ readFile: () => Promise.resolve('[]') }),
      )
    }
    catch (error: unknown) {
      caught = error
    }
    const message = caught instanceof Error ? caught.message : ''
    expect(message).toContain('- (root): EvidenceSpec は object である必要があります')
  })

  it('文面の違反は text-violation で全件を載せ、writeWorkbook を呼ばない', async () => {
    const writeWorkbook = vi.fn<EvidenceCreateDependencies['writeWorkbook']>(
      () => Promise.resolve(writeResult()),
    )
    const spec = { ...VALID_SPEC, title: HYPE, items: [{ imagePath: '/img/a.png', caption: HYPE }] }

    await expect(runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ readFile: () => Promise.resolve(JSON.stringify(spec)), writeWorkbook }),
    )).rejects.toMatchObject({
      name: 'EvidenceCreateError',
      reason: 'text-violation',
      violations: [
        { item: 'title', ruleId: 'no-ai-hype-expressions', text: HYPE },
        { item: 'items[0].caption', ruleId: 'no-ai-hype-expressions', text: HYPE },
      ],
    })
    await expect(runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ readFile: () => Promise.resolve(JSON.stringify(spec)), writeWorkbook }),
    )).rejects.toThrow('文面の違反 2 件')
    expect(writeWorkbook).not.toHaveBeenCalled()
  })

  it('省略した caption（ファイル名で補う分）は確認しない', async () => {
    // 拡張子を除いた basename が違反になる imagePath。補った caption も確認されるなら例外になる
    const imagePath = `/img/${HYPE_WORDS}.png`
    const writeWorkbook = vi.fn<EvidenceCreateDependencies['writeWorkbook']>(
      () => Promise.resolve(writeResult()),
    )
    const omitted = { ...VALID_SPEC, items: [{ imagePath }] }
    await runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ readFile: () => Promise.resolve(JSON.stringify(omitted)), writeWorkbook }),
    )
    expect(writeWorkbook).toHaveBeenCalledTimes(1)
    expect(writeWorkbook.mock.calls[0]?.[0].items[0]?.caption).toBe(HYPE_WORDS)

    // 対照: 同じ文言を利用者が caption へ書いたなら違反になる
    const written = { ...VALID_SPEC, items: [{ imagePath, caption: HYPE_WORDS }] }
    await expect(runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ readFile: () => Promise.resolve(JSON.stringify(written)), writeWorkbook }),
    )).rejects.toMatchObject({ reason: 'text-violation' })
    expect(writeWorkbook).toHaveBeenCalledTimes(1)
  })

  it('確認器が失敗したら text-lint-failed を投げ、writeWorkbook を呼ばない', async () => {
    const writeWorkbook = vi.fn<EvidenceCreateDependencies['writeWorkbook']>(
      () => Promise.resolve(writeResult()),
    )
    await expect(runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ lintText: () => Promise.reject(new Error('辞書を読めません')), writeWorkbook }),
    )).rejects.toMatchObject({
      reason: 'text-lint-failed',
      violations: undefined,
    })
    await expect(runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({ lintText: () => Promise.reject(new Error('辞書を読めません')), writeWorkbook }),
    )).rejects.toThrow('辞書を読めません')
    expect(writeWorkbook).not.toHaveBeenCalled()
  })

  it('writeWorkbook の EvidenceWorkbookError はそのまま伝播する', async () => {
    await expect(runEvidenceCreate(
      '/abs/spec.json',
      '/abs/out.xlsx',
      buildDependencies({
        writeWorkbook: () => Promise.reject(new EvidenceWorkbookError('全滅', 'no-valid-images')),
      }),
    )).rejects.toBeInstanceOf(EvidenceWorkbookError)
  })
})

describe('createEvidenceCreateCommand — 成功時の出力', () => {
  it('--json なしは絶対パス・項目数・注記数を stdout に出す', async () => {
    const stdout = makeStream()
    const command = createEvidenceCreateCommand(() => buildDependencies({ stdout: asStream(stdout) }))
    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await command.parseAsync(['--input', 'spec.json'], { from: 'user' })
      expect(stdout.chunks.join('')).toBe(
        '生成しました: /abs/evidence.xlsx\n項目数: 1 / 注記数: 0\n',
      )
      // 成功時は exitCode を触らない。
      expect(process.exitCode).toBe(undefined)
    }
    finally {
      process.exitCode = previousExit
    }
  })

  it('--json なしの注記数は writeWorkbook の戻り値をそのまま出す', async () => {
    const stdout = makeStream()
    const command = createEvidenceCreateCommand(() => buildDependencies({
      stdout: asStream(stdout),
      writeWorkbook: () => Promise.resolve(writeResult({ items: 2, annotations: 5 })),
    }))
    await command.parseAsync(['--input', 'spec.json'], { from: 'user' })

    expect(stdout.chunks.join('')).toBe(
      '生成しました: /abs/evidence.xlsx\n項目数: 2 / 注記数: 5\n',
    )
  })

  it('--json なしで除外があると理由付きの一覧も出す', async () => {
    const stdout = makeStream()
    const command = createEvidenceCreateCommand(() => buildDependencies({
      stdout: asStream(stdout),
      writeWorkbook: () => Promise.resolve(writeResult({
        skipped: [
          { path: '/img/missing.png', reason: 'not-found' },
          { path: '/img/note.png', reason: 'unsupported-format' },
        ],
      })),
    }))
    await command.parseAsync(['--input', 'spec.json'], { from: 'user' })

    expect(stdout.chunks.join('')).toBe(
      '生成しました: /abs/evidence.xlsx\n'
      + '項目数: 1 / 注記数: 0\n'
      + '除外: 2 件\n'
      + '  - /img/missing.png (not-found)\n'
      + '  - /img/note.png (unsupported-format)\n',
    )
  })

  it('--json は result イベントを 1 行 JSON で出す', async () => {
    const stdout = makeStream()
    const command = createEvidenceCreateCommand(() => buildDependencies({
      stdout: asStream(stdout),
      writeWorkbook: () => Promise.resolve(writeResult({
        items: 3,
        skipped: [{ path: '/img/broken.png', reason: 'unreadable' }],
      })),
    }))
    await command.parseAsync(['--input', 'spec.json', '--json'], { from: 'user' })

    const written = stdout.chunks.join('')
    expect(written.split('\n').filter(line => line.length > 0)).toHaveLength(1)
    expect(written).toBe(
      `${JSON.stringify({
        event: 'result',
        outPath: '/abs/evidence.xlsx',
        items: 3,
        annotations: 0,
        skipped: [{ path: '/img/broken.png', reason: 'unreadable' }],
      })}\n`,
    )
  })

  it('--out 未指定でも既定の ./evidence.xlsx が絶対パスで writeWorkbook に渡る', async () => {
    const writeWorkbook = vi.fn<EvidenceCreateDependencies['writeWorkbook']>(
      () => Promise.resolve(writeResult()),
    )
    const command = createEvidenceCreateCommand(() => buildDependencies({ writeWorkbook }))
    await command.parseAsync(['--input', 'spec.json'], { from: 'user' })

    expect(writeWorkbook.mock.calls[0]?.[1]).toBe(`${process.cwd()}/evidence.xlsx`)
  })
})

describe('createEvidenceCreateCommand — 失敗時の出力', () => {
  it('--json なしは stderr にメッセージ + exit 1', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createEvidenceCreateCommand(() => buildDependencies({
      stdout: asStream(stdout),
      stderr: asStream(stderr),
      writeWorkbook: () => Promise.reject(
        new EvidenceWorkbookError('配置できる画像がありません (2 件すべて除外)', 'no-valid-images'),
      ),
    }))
    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await command.parseAsync(['--input', 'spec.json'], { from: 'user' })
      expect(stderr.chunks.join('')).toBe(
        'pecotv evidence create: 配置できる画像がありません (2 件すべて除外)\n',
      )
      expect(stdout.chunks.join('')).toBe('')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
    }
  })

  it('--json は evidence.create.error を stdout に出す + exit 1', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createEvidenceCreateCommand(() => buildDependencies({
      stdout: asStream(stdout),
      stderr: asStream(stderr),
      readFile: () => Promise.reject(new Error('ENOENT: no such file')),
    }))
    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await command.parseAsync(['--input', 'spec.json', '--json'], { from: 'user' })
      const last = stdout.chunks.join('').trim()
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りを narrowing
      const parsed = JSON.parse(last) as { event: string, reason: string, detail: string }
      expect(parsed.event).toBe('evidence.create.error')
      expect(parsed.reason).toBe('input-not-found')
      expect(parsed.detail).toContain('spec JSON が読めません')
      expect(stderr.chunks).toHaveLength(0)
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
    }
  })

  it('--json で検証エラーは reason invalid-spec + detail に全件', async () => {
    const stdout = makeStream()
    const command = createEvidenceCreateCommand(() => buildDependencies({
      stdout: asStream(stdout),
      readFile: () => Promise.resolve(JSON.stringify({ title: 'T', createdDate: '2026-08-17', items: [] })),
    }))
    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await command.parseAsync(['--input', 'spec.json', '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りを narrowing
      const parsed = JSON.parse(stdout.chunks.join('').trim()) as { reason: string, detail: string }
      expect(parsed.reason).toBe('invalid-spec')
      expect(parsed.detail).toContain('- items: 1 件以上必要です')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
    }
  })
})

describe('createEvidenceCreateCommand — 文面の違反', () => {
  it('--json は text-violation と violations の全件を出す + exit 1', async () => {
    const stdout = makeStream()
    const command = createEvidenceCreateCommand(() => buildDependencies({
      stdout: asStream(stdout),
      readFile: () => Promise.resolve(JSON.stringify({ ...VALID_SPEC, title: HYPE })),
    }))
    const previousExit = process.exitCode
    process.exitCode = undefined
    try {
      await command.parseAsync(['--input', 'spec.json', '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りを narrowing
      const parsed = JSON.parse(stdout.chunks.join('').trim()) as { event: string, reason: string, violations: { item: string }[] }
      expect(parsed.event).toBe('evidence.create.error')
      expect(parsed.reason).toBe('text-violation')
      expect(parsed.violations.map(v => v.item)).toStrictEqual(['title'])
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExit
    }
  })
})

describe('evidenceCreateDefaultDependencies', () => {
  it('stdout / stderr / readFile / writeWorkbook が実体に接続される', async () => {
    const dependencies = evidenceCreateDefaultDependencies()

    expect(dependencies.stdout).toBe(process.stdout)
    expect(dependencies.stderr).toBe(process.stderr)
    expect(dependencies.writeWorkbook).toBe(writeEvidenceWorkbook)
    expect(dependencies.lintText).toBe(defaultLintText)
    await expect(dependencies.readFile('/no/such/spec.json')).rejects.toThrow()
  })
})

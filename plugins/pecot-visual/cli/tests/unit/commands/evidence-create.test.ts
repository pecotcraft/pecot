// commands/evidence-xlsx/create.ts の unit test。
// fs は DI で差し替え、spec の読込・parse・検証の各失敗と成功時の結果を pin する。

import { describe, expect, it, vi } from 'vitest'

import type { EvidenceCreateDependencies } from '../../../src/commands/evidence-xlsx/create.js'
import {
  errorData,
  EvidenceCreateError,
  executeEvidenceCreate,
  evidenceCreateDefaultDependencies,
  runEvidenceCreate,
} from '../../../src/commands/evidence-xlsx/create.js'
import { rejectionOf } from '../../_helpers/rejection.js'
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
    expect(message).toContain('- title: must not be empty')
    expect(message).toContain('- createdDate: not a valid calendar date: 2026-02-31')
    expect(message).toContain('- items[0].annotations[0].box.w: x + w exceeds 1')
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
    expect(message).toContain('- (root): EvidenceSpec must be an object')
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
    )).rejects.toThrow('2 text violation(s)')
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

describe('executeEvidenceCreate — 成功時の結果', () => {
  it('result イベントに絶対パス・項目数・注記数・除外の一覧を載せる', async () => {
    const execution = await executeEvidenceCreate(
      { input: 'spec.json', out: 'out.xlsx' },
      buildDependencies({
        writeWorkbook: () => Promise.resolve(writeResult({
          items: 3,
          annotations: 5,
          skipped: [{ path: '/img/broken.png', reason: 'unreadable' }],
        })),
      }),
    )

    expect(execution).toStrictEqual({
      event: 'result',
      outPath: '/abs/evidence.xlsx',
      items: 3,
      annotations: 5,
      skipped: [{ path: '/img/broken.png', reason: 'unreadable' }],
    })
  })

  it('相対の out は cwd 基準の絶対パスで writeWorkbook に渡る', async () => {
    const writeWorkbook = vi.fn<EvidenceCreateDependencies['writeWorkbook']>(
      () => Promise.resolve(writeResult()),
    )
    await executeEvidenceCreate({ input: 'spec.json', out: 'evidence.xlsx' }, buildDependencies({ writeWorkbook }))

    expect(writeWorkbook.mock.calls[0]?.[1]).toBe(`${process.cwd()}/evidence.xlsx`)
  })
})

describe('errorData — 失敗時の data', () => {
  it('xlsx に置ける画像が無いときは no-valid-images と detail を返す', async () => {
    const error = await rejectionOf(executeEvidenceCreate(
      { input: 'spec.json', out: 'out.xlsx' },
      buildDependencies({
        writeWorkbook: () => Promise.reject(
          new EvidenceWorkbookError('no images can be placed (all 2 items excluded)', 'no-valid-images'),
        ),
      }),
    ))

    expect(errorData(error)).toStrictEqual({
      event: 'evidence.create.error',
      reason: 'no-valid-images',
      detail: 'no images can be placed (all 2 items excluded)',
    })
  })

  it('spec を読めないときは input-not-found を返す', async () => {
    const error = await rejectionOf(executeEvidenceCreate(
      { input: 'spec.json', out: 'out.xlsx' },
      buildDependencies({ readFile: () => Promise.reject(new Error('ENOENT: no such file')) }),
    ))

    const data = errorData(error)
    expect(data['reason']).toBe('input-not-found')
    expect(data['detail']).toContain('cannot read spec JSON')
  })

  it('検証エラーは invalid-spec と detail に全件を返す', async () => {
    const error = await rejectionOf(executeEvidenceCreate(
      { input: 'spec.json', out: 'out.xlsx' },
      buildDependencies({
        readFile: () => Promise.resolve(JSON.stringify({ title: 'T', createdDate: '2026-08-17', items: [] })),
      }),
    ))

    const data = errorData(error)
    expect(data['reason']).toBe('invalid-spec')
    expect(data['detail']).toContain('- items: must have at least one item')
  })

  it('文面の違反は text-violation と violations の全件を返す', async () => {
    const error = await rejectionOf(executeEvidenceCreate(
      { input: 'spec.json', out: 'out.xlsx' },
      buildDependencies({
        readFile: () => Promise.resolve(JSON.stringify({ ...VALID_SPEC, title: HYPE })),
      }),
    ))

    const data = errorData(error)
    expect(data['reason']).toBe('text-violation')
    // eslint-disable-next-line no-restricted-syntax -- violations の要素を検証用に narrowing
    expect((data['violations'] as { item: string }[]).map(v => v.item)).toStrictEqual(['title'])
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

// commands/slidev-project/theme.ts の unit test。
// fixture テーマを node_modules/<name> に symlink した一時 talk-dir で、`slide theme` の出力を固定する。
// I/O 境界（ファイル読み取り）は実装を通し、モックしない。ネットワークには出ない。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てのみ */
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createSlideThemeCommand,
  errorToReason,
  executeSlideTheme,
  slideThemeDefaultDependencies,
} from '../../../src/commands/slidev-project/theme.js'
import type { SlideThemeDependencies } from '../../../src/commands/slidev-project/theme.js'
import { isRecord } from '../../../src/domain/_shared/json.js'
import { NodeThemeFiles } from '../../../src/infra/slidev-theme/fs.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

const THEMES = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'themes')
const WITH_DECLARATION = path.join(THEMES, 'with-declaration')
const WITHOUT_DECLARATION = path.join(THEMES, 'without-declaration')
const WITH_DECLARATION_NAME = 'slidev-theme-pecotv-test-declared'

const temporaryRoot = useTemporaryDirectory('pecotv-slide-theme-unit-', { resolveRealPath: true })

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

interface Captured {
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
}

// write を持つ stub をそのまま使う。
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
function asStream(chunks: string[]): NodeJS.WritableStream {
  const stub = {
    write(data: string): boolean {
      chunks.push(data)
      return true
    },
  }
  // eslint-disable-next-line no-restricted-syntax -- test 内 stub を NodeJS.WritableStream に narrowing
  return stub as unknown as NodeJS.WritableStream
}

function makeDependencies(currentDirectory = temporaryRoot()): { dependencies: SlideThemeDependencies, captured: Captured } {
  const stdout: string[] = []
  const stderr: string[] = []
  const dependencies: SlideThemeDependencies = {
    files: new NodeThemeFiles(),
    currentDirectory,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
  }
  return { dependencies, captured: { stdout, stderr } }
}

interface TalkOptions {
  readonly themeRoot?: string
  readonly themeName?: string
  readonly themeField?: string
  readonly link?: boolean
}

// themeRoot を node_modules/<name> に symlink した talk-dir を作る。
function makeTalk(options: Readonly<TalkOptions> = {}): string {
  const { themeRoot = WITH_DECLARATION, themeName = WITH_DECLARATION_NAME, themeField = themeName, link = true } = options
  const talk = temporaryRoot('talk')
  mkdirSync(talk, { recursive: true })
  writeFileSync(path.join(talk, 'slides.md'), `---\ntheme: ${themeField}\ntitle: テスト\n---\n\n# 表紙\n`)
  writeFileSync(
    path.join(talk, 'package.json'),
    JSON.stringify({ name: 'talk', dependencies: { [themeName]: `file:${themeRoot}` } }),
  )
  if (link) {
    mkdirSync(path.join(talk, 'node_modules'), { recursive: true })
    symlinkSync(themeRoot, path.join(talk, 'node_modules', themeName))
  }
  return talk
}

function dataOf(captured: Readonly<Captured>): Record<string, unknown> {
  const parsed: unknown = JSON.parse(captured.stdout.join(''))
  if (!isRecord(parsed)) throw new TypeError('stdout が JSON のオブジェクトではありません')
  return parsed
}

async function runCommand(
  argv: readonly string[],
  // 出力先の stream は write で mutate する。
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  dependencies: SlideThemeDependencies,
): Promise<number | string | undefined> {
  const previous = process.exitCode
  process.exitCode = undefined
  try {
    await createSlideThemeCommand(() => dependencies).parseAsync([...argv], { from: 'user' })
    return process.exitCode
  }
  finally {
    process.exitCode = previous
  }
}

describe('executeSlideTheme（宣言のあるテーマ）', () => {
  it('theme・declaration・layouts・categories・lint・warnings を返す', async () => {
    const talk = makeTalk()
    const themeRoot = path.join(talk, 'node_modules', WITH_DECLARATION_NAME)
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)

    expect(data.event).toBe('slide.theme.done')
    expect(data.theme).toEqual({
      name: WITH_DECLARATION_NAME,
      spec: `file:${WITH_DECLARATION}`,
      declared: true,
      directory: themeRoot,
      linked: true,
    })
    expect(data.declaration).toMatchObject({
      schema: 1,
      fonts: { body: ['Test Sans'], heading: ['Test Sans'], eastAsian: 'Test Sans JP' },
      pptx: { eastAsianFont: 'Test Sans JP', linkColor: '0A7F3F' },
    })
    expect(data.categories).toEqual([
      { id: 'text', label: '文章', question: '文章で見せる' },
      { id: 'figure', label: '図', question: '図で見せる' },
    ])
    expect(data.layouts).toEqual([
      { layout: 'cover', description: '資料の表紙。タイトルと副題だけを置く。', category: 'text', deprecated: false, filename: 'cover.yaml' },
      { layout: 'end', description: '資料の最後に置く。結びの言葉だけを置く。', category: 'text', deprecated: false, filename: 'end.yaml' },
      { layout: 'link', description: '見出しと、リンク付きのカードを縦に並べる。参考資料や関連 URL をまとめる場面に使う。', category: 'text', deprecated: false, filename: 'link.yaml' },
      { layout: 'plain', description: '見出しと本文だけを置く最小のレイアウト。文章で伝える場面に使う。', category: 'text', deprecated: false, filename: 'plain.yaml' },
      { layout: 'section', description: '章の区切りに置く。見出しと一言の説明に、装飾の線を添える。', category: 'text', deprecated: false, filename: 'section.yaml' },
      { layout: 'marked', description: '見出しと印のセルを置く枠を持つレイアウト。図に印を付ける場面に使う。', category: 'figure', deprecated: false, filename: 'marked.yaml' },
      { layout: 'panel', description: '見出しと画像の枠を置くレイアウト。図を 1 つ見せる場面に使う。', category: 'figure', deprecated: false, filename: 'panel.yaml' },
      { layout: 'legacy-panel', description: '【非推奨】品質が水準に達していないため選ばない、見出しだけの枠。', category: 'figure', deprecated: true, filename: 'legacy-panel.yaml' },
    ])
    expect(data.lint).toEqual({
      referencesDirectories: [path.join(talk, 'references'), path.join(themeRoot, 'references')],
      panels: { panel: { width: 400, height: 300 } },
      markerLayouts: ['marked'],
      rules: {
        'slidev-pages-lint/no-unknown-props': 'error',
        'slidev-pages-lint/no-missing-page': 'error',
        'text-constraints/max-chars': 'error',
      },
    })
    expect(data.warnings).toEqual([])
  })

  it('theme: が短い名前でも、解決した完全な名前を返す', async () => {
    const talk = makeTalk({ themeField: 'pecotv-test-declared' })
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)
    expect(data.theme).toMatchObject({ name: WITH_DECLARATION_NAME })
  })

  it('talk-dir の references/ の宣言が、テーマの同名の宣言に勝つ', async () => {
    const talk = makeTalk()
    mkdirSync(path.join(talk, 'references'))
    writeFileSync(
      path.join(talk, 'references', 'plain.yaml'),
      `layout: 'plain'\ndescription: 'talk-dir の説明'\ncategory: 'text'\nstatus: deprecated\n`,
    )
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)
    expect(data.layouts).toContainEqual({
      layout: 'plain',
      description: 'talk-dir の説明',
      category: 'text',
      deprecated: true,
      filename: 'plain.yaml',
    })
  })

  it('pptx.linkColor が無い宣言では、リンクは変換されない旨を warnings に載せる', async () => {
    const themeRoot = temporaryRoot('theme-without-link-color')
    cpSync(WITH_DECLARATION, themeRoot, { recursive: true })
    writeFileSync(
      path.join(themeRoot, 'pecot-theme.json'),
      JSON.stringify({ schema: 1, pptx: { eastAsianFont: 'Test Sans JP' } }),
    )
    const talk = makeTalk({ themeRoot })
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)
    expect(data.warnings).toEqual([
      'pptx.linkColor を省いたため、PPTX ではリンクは変換されません（ハイパーリンクが付きません）。リンクを変換するには pecot-theme.json の pptx.linkColor に 6 桁の 16 進で書いてください',
    ])
  })

  it('宣言の警告は warnings の先頭に来る', async () => {
    const themeRoot = temporaryRoot('theme-future-schema')
    cpSync(WITH_DECLARATION, themeRoot, { recursive: true })
    writeFileSync(path.join(themeRoot, 'pecot-theme.json'), JSON.stringify({ schema: 2 }))
    const talk = makeTalk({ themeRoot })
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)
    const { warnings } = data
    expect(warnings[0]).toContain('schema 2')
    expect(warnings).toHaveLength(2)
  })
})

describe('executeSlideTheme（宣言の無いテーマ）', () => {
  it('declared: false で、既定値と vue 由来の一覧を返し、警告を積む', async () => {
    const talk = makeTalk({ themeRoot: WITHOUT_DECLARATION, themeName: 'slidev-theme-pecotv-test-bare' })
    const { dependencies } = makeDependencies()
    const { data } = await executeSlideTheme({ dir: talk }, dependencies)

    expect(data.theme).toMatchObject({ name: 'slidev-theme-pecotv-test-bare', declared: false })
    expect(data.layouts).toEqual([
      { layout: 'one', description: '', category: 'uncategorized', deprecated: false, filename: 'one.vue' },
      { layout: 'two', description: '', category: 'uncategorized', deprecated: false, filename: 'two.vue' },
    ])
    expect(data.categories).toEqual([
      expect.objectContaining({ id: 'uncategorized', label: '未分類' }),
    ])
    const { warnings } = data
    expect(warnings[0]).toContain('pecot-theme.json の宣言が無い')
    expect(warnings.some(warning => warning.includes('見せ方の分類を読み取れませんでした'))).toBe(true)
    expect(warnings.some(warning => warning.includes('pptx.linkColor'))).toBe(true)
  })
})

describe('executeSlideTheme（pecot-theme.json を持つ dir）', () => {
  it('theme: none で dir 自身に pecot-theme.json があっても、テーマとして読まず theme-none で止める', async () => {
    const talk = temporaryRoot('theme-root')
    cpSync(WITH_DECLARATION, talk, { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n\n# 見本\n')
    const { dependencies } = makeDependencies()

    await expect(executeSlideTheme({ dir: talk }, dependencies)).rejects.toMatchObject({ reason: 'theme-none' })
  })
})

describe('executeSlideTheme の失敗', () => {
  it('テーマを張っていなければ theme-unlinked の例外を投げる', async () => {
    const talk = makeTalk({ link: false })
    const { dependencies } = makeDependencies()
    await expect(executeSlideTheme({ dir: talk }, dependencies)).rejects.toMatchObject({ reason: 'theme-unlinked' })
  })

  it('宣言の形が誤っていれば invalid-shape の例外を投げる', async () => {
    const themeRoot = temporaryRoot('theme-broken')
    cpSync(WITH_DECLARATION, themeRoot, { recursive: true })
    writeFileSync(path.join(themeRoot, 'pecot-theme.json'), JSON.stringify({ schema: 1, slide: { width: -1, height: 1 } }))
    const talk = makeTalk({ themeRoot })
    const { dependencies } = makeDependencies()
    await expect(executeSlideTheme({ dir: talk }, dependencies)).rejects.toMatchObject({ reason: 'invalid-shape' })
  })
})

describe('createSlideThemeCommand', () => {
  it('--json で data を 1 行の JSON にして stdout に出す。exit code は 0', async () => {
    const talk = makeTalk()
    const { dependencies, captured } = makeDependencies()
    expect(await runCommand(['--dir', talk, '--json'], dependencies)).toBeUndefined()
    expect(captured.stdout).toHaveLength(1)
    expect(captured.stdout[0]?.endsWith('\n')).toBe(true)
    expect(dataOf(captured)['event']).toBe('slide.theme.done')
    expect(captured.stderr).toEqual([])
  })

  it('--dir を省くとカレントの talk-dir を読む', async () => {
    const talk = makeTalk()
    const { dependencies, captured } = makeDependencies(talk)
    await runCommand(['--json'], dependencies)
    expect(dataOf(captured)['theme']).toMatchObject({ name: WITH_DECLARATION_NAME })
  })

  it('--json が無ければ、人間向けに名前・レイアウト・警告を出す', async () => {
    const talk = makeTalk({ themeRoot: WITHOUT_DECLARATION, themeName: 'slidev-theme-pecotv-test-bare' })
    const { dependencies, captured } = makeDependencies()
    await runCommand(['--dir', talk], dependencies)
    const text = captured.stdout.join('')
    expect(text).toContain('slide theme: slidev-theme-pecotv-test-bare')
    expect(text).toContain('宣言: なし')
    expect(text).toContain('one')
    // 警告は結果と分けて stderr に出る
    expect(text).not.toContain('[warn]')
    expect(captured.stderr.join('')).toContain('[warn] ')
  })

  it('theme-unlinked では exit 1 で、--json は reason と detail を出す', async () => {
    const talk = makeTalk({ link: false })
    const { dependencies, captured } = makeDependencies()
    expect(await runCommand(['--dir', talk, '--json'], dependencies)).toBe(1)
    const data = dataOf(captured)
    expect(data['event']).toBe('slide.theme.error')
    expect(data['reason']).toBe('theme-unlinked')
    expect(data['detail']).toEqual(expect.stringContaining('--node-modules-only'))
  })

  it('theme-none では exit 1 で、slide sync --theme を案内する', async () => {
    const talk = temporaryRoot('legacy')
    mkdirSync(talk, { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n')
    const { dependencies, captured } = makeDependencies()
    expect(await runCommand(['--dir', talk, '--json'], dependencies)).toBe(1)
    const data = dataOf(captured)
    expect(data['reason']).toBe('theme-none')
    expect(data['detail']).toEqual(expect.stringContaining('slide sync --theme <theme-spec>'))
  })

  it('宣言の誤りは reason を theme-<reason> にする', async () => {
    const themeRoot = temporaryRoot('theme-unknown-rule')
    cpSync(WITH_DECLARATION, themeRoot, { recursive: true })
    writeFileSync(
      path.join(themeRoot, 'pecot-theme.json'),
      JSON.stringify({ schema: 1, lint: { rules: { 'no-such/rule': 'error' } } }),
    )
    const talk = makeTalk({ themeRoot })
    const { dependencies, captured } = makeDependencies()
    expect(await runCommand(['--dir', talk, '--json'], dependencies)).toBe(1)
    const data = dataOf(captured)
    expect(data['reason']).toBe('theme-unknown-rule')
    expect(data['detail']).toEqual(expect.stringContaining('no-such/rule'))
  })

  it('--json が無い失敗は stderr に 1 行出す', async () => {
    const talk = makeTalk({ link: false })
    const { dependencies, captured } = makeDependencies()
    expect(await runCommand(['--dir', talk], dependencies)).toBe(1)
    expect(captured.stdout).toEqual([])
    expect(captured.stderr.join('')).toContain('pecotv slide theme 失敗:')
  })

  it('未知のオプションは exit 2 の usage error。--json なら invalid-option を stdout に出す', async () => {
    const { dependencies, captured } = makeDependencies()
    const previousArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'theme', '--nope', '--json']
    try {
      await expect(runCommand(['--nope', '--json'], dependencies)).rejects.toThrow()
    }
    finally {
      process.argv = previousArgv
    }
    const data = dataOf(captured)
    expect(data['event']).toBe('slide.theme.error')
    expect(data['reason']).toBe('invalid-option')
  })
})

describe('errorToReason', () => {
  it('解決・宣言以外の例外は unknown', () => {
    expect(errorToReason(new Error('x'))).toBe('unknown')
  })
})

describe('createSlideThemeCommand の usage error', () => {
  it('--json が無ければ、commander の英文を stderr に出す', async () => {
    const { dependencies, captured } = makeDependencies()
    const previousArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'theme', '--nope']
    try {
      await expect(runCommand(['--nope'], dependencies)).rejects.toThrow()
    }
    finally {
      process.argv = previousArgv
    }
    expect(captured.stderr.join('')).toContain('unknown option')
    expect(captured.stdout).toEqual([])
  })
})

describe('slideThemeDefaultDependencies', () => {
  it('実 fs の port と process の入出力を返す', () => {
    const dependencies = slideThemeDefaultDependencies()
    expect(dependencies.files).toBeInstanceOf(NodeThemeFiles)
    expect(dependencies.currentDirectory).toBe(process.cwd())
    expect(dependencies.stdout).toBe(process.stdout)
    expect(dependencies.stderr).toBe(process.stderr)
  })
})

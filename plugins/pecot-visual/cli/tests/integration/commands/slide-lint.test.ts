// commands/slidev-project/lint.ts の integration test。
// 本体の assets/slidev 同梱の eslint を子プロセスで起動するため、
// eslint plugin が build 済みであることを冒頭で確認する。
//
// talk-dir は tmp 配下に組み立てる。fixture テーマ（with-declaration）の複製を node_modules/<name> に symlink する。
// 複製は pecot-theme.json の lint を省いて、宣言の無い規則の既定値（9 本）で動かす。
// 宣言した規則（fixture のまま）で動かすケースは、fixture 自体を symlink して別に確かめる。

/* eslint-disable security/detect-non-literal-fs-filename */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EslintRunner } from '../../../src/domain/slidev-project/lint.js'
import { createSlideCreateCommand, executeSlideCreate } from '../../../src/commands/slidev-project/create.js'
import {
  autoDeckLintJsonField,
  createSlideLintCommand,
  runAutoDeckLint,
  runSlideLintFromCli,
  slideLintDefaultDependencies,
  writeAutoDeckLintReport,
} from '../../../src/commands/slidev-project/lint.js'
import { createSlideSyncCommand } from '../../../src/commands/slidev-project/sync.js'
import { seedDependencyRoot } from '../../_helpers/dependency-probes.js'
import { verifies } from '../../_helpers/verifies.js'
import {
  asStream,
  assertTemplatePluginsBuilt,
  type CapturedStream,
  copyThemeForTalk,
  makeStream,
  PLUGIN_ROOT,
} from '../../_helpers/talk-directory.js'

beforeAll(assertTemplatePluginsBuilt)

const state = { temporaryRoot: '' }

beforeEach(() => {
  // tmpdir 自体が symlink になる環境がある（macOS の /var → /private/var 等）。
  // その環境では、eslint が返す realpath 解決済みの filePath を論理パスから相対化できない。
  // すると violations[].file が絶対パスになる。物理パスへ正規化して assert を安定させる。
  const created = mkdtempSync(path.join(tmpdir(), 'pecotv-slide-lint-'))
  state.temporaryRoot = realpathSync(created)
})

afterEach(() => {
  rmSync(state.temporaryRoot, { recursive: true, force: true })
})

const THEME_FIXTURE = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'themes', 'with-declaration')
const THEME_NAME = 'slidev-theme-pecotv-test-declared'
const INITIAL_PAGES: readonly (readonly [string, string])[] = [
  ['cover', '---\nlayout: cover\nheading: 発表タイトル\nsubtitle: 副題\n---\n'],
  ['agenda', '---\nlayout: plain\nheading: アジェンダ\nbody: 本日の流れ\n---\n'],
  ['section', '---\nlayout: plain\nheading: 章の見出し\n---\n'],
  ['end', '---\nlayout: plain\nheading: ご清聴ありがとうございました\n---\n'],
]

interface TalkOptions {
  // 宣言した規則（fixture のまま）で動かす。省くと pecot-theme.json の lint を外した複製を使う。
  readonly declaredRules?: boolean
}

// 初期ページ 4 枚と slides.md を持つ talk-dir を作る。テーマは node_modules/<name> に symlink する。
// eslint-disable-next-line @typescript-eslint/require-await -- 呼び出し側が await する既存の形に合わせる
async function setupTalkDirectory(name = 'demo', options: Readonly<TalkOptions> = {}): Promise<string> {
  const talk = path.join(state.temporaryRoot, name)
  mkdirSync(path.join(talk, 'pages'), { recursive: true })
  let themeRoot = THEME_FIXTURE
  if (options.declaredRules !== true) {
    themeRoot = path.join(state.temporaryRoot, `theme-${name}`)
    cpSync(THEME_FIXTURE, themeRoot, { recursive: true })
    writeFileSync(path.join(themeRoot, 'pecot-theme.json'), JSON.stringify({ schema: 1 }), 'utf8')
  }
  mkdirSync(path.join(talk, 'node_modules'), { recursive: true })
  symlinkSync(themeRoot, path.join(talk, 'node_modules', THEME_NAME), 'dir')
  writeFileSync(
    path.join(talk, 'package.json'),
    JSON.stringify({ name, dependencies: { [THEME_NAME]: `file:${themeRoot}` } }),
    'utf8',
  )
  const entries = INITIAL_PAGES.map(([page]) => `---\nsrc: ./pages/${page}.md\n---\n`).join('\n')
  writeFileSync(path.join(talk, 'slides.md'), `---\ntheme: ${THEME_NAME}\ntitle: ${name}\n---\n\n${entries}`, 'utf8')
  for (const [page, text] of INITIAL_PAGES) {
    writeFileSync(path.join(talk, 'pages', `${page}.md`), text, 'utf8')
  }
  return talk
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- write を持つ stub
function lintDependencies(stdout: CapturedStream, stderr: CapturedStream): {
  pluginRoot: string
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
} {
  return {
    pluginRoot: PLUGIN_ROOT,
    stdout: asStream(stdout),
    stderr: asStream(stderr),
  }
}

/**
sync の依存。テーマの取得と張り直しの port は、talk-dir の node_modules に張られた fixture テーマをそのまま返す。
fixture は依存を持ち node_modules が無いため、実の取得（install を要求する）には通せない。
取得・印の比較・張り直しそのものは unit test (linked-theme.test.ts) とここ以外の sync の integration が見る。
*/
function syncDependencies(
  talk: string,
  // write を持つ stub
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stdout: CapturedStream,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
  stderr: CapturedStream,
  pluginRoot = PLUGIN_ROOT,
): ReturnType<typeof lintDependencies> & { ensureThemeLinked: () => Promise<{ relinked: boolean, regenerated: boolean, theme: { name: string, spec: string, directory: string }, nodeModulesTarget: undefined }> } {
  return {
    ...lintDependencies(stdout, stderr),
    pluginRoot,
    ensureThemeLinked: () => Promise.resolve({
      relinked: false, regenerated: false,
      theme: { name: THEME_NAME, spec: 'file:fixture', directory: realpathSync(path.join(talk, 'node_modules', THEME_NAME)) },
      nodeModulesTarget: undefined,
    }),
  }
}

describe('runSlideLintFromCli (実 eslint)', () => {
  it('create 直後の talk-dir は lint 対象 5 件・エラー 0 件で clean', async () => {
    const talk = await setupTalkDirectory()
    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.outcome).toBe('clean')
    // 初期 page 4 枚 + slides.md
    expect(summary.lintedFileCount).toBe(5)
    expect(summary.errorCount).toBe(0)
    expect(summary.violations).toStrictEqual([])
  })

  it('連番プレフィックスの page は no-numeric-filename-prefix を列挙する', async () => {
    const talk = await setupTalkDirectory()
    // slides.md からも参照して require-slides-entry / no-missing-page を成立させる。
    writeFileSync(
      path.join(talk, 'pages', '01-intro.md'),
      '---\nlayout: plain\nheading: イントロ\n---\n',
      'utf8',
    )
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/01-intro.md\n---\n', 'utf8')

    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.outcome).toBe('violations')
    expect(summary.errorCount).toBeGreaterThan(0)
    const rules = summary.violations.map(v => v.rule)
    expect(rules).toContain('slidev-pages-lint/no-numeric-filename-prefix')
    const offending = summary.violations.find(
      v => v.rule === 'slidev-pages-lint/no-numeric-filename-prefix',
    )
    expect(offending?.file).toBe(path.join('pages', '01-intro.md'))
  })

  it('slides.md の幽霊 src: は no-missing-page を列挙する', async () => {
    const talk = await setupTalkDirectory()
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')

    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.outcome).toBe('violations')
    const ghost = summary.violations.find(
      v => v.rule === 'slidev-pages-lint/no-missing-page',
    )
    expect(ghost?.file).toBe('slides.md')
    expect(ghost?.message).toContain('__ghost.md')
  })

  it('本文とノートの文面違反を、ファイル行付きで textlint-body として列挙する', async () => {
    const talk = await setupTalkDirectory()
    addBodyNotePage(talk)

    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.outcome).toBe('violations')
    const body = summary.violations.filter(v => v.rule === 'text-constraints/textlint-body')
    expect(body.map(v => ({ file: v.file, line: v.line }))).toStrictEqual([
      { file: path.join('pages', 'body-note.md'), line: 6 },
      { file: path.join('pages', 'body-note.md'), line: 9 },
    ])
    expect(body[0]?.message).toMatch(/^body L6: .+ \(no-ai-hype-expressions\)$/)
    expect(body[1]?.message).toMatch(/^speaker notes L9: .+ \(no-ai-hype-expressions\)$/)
  })

  it('pages/*.md を全削除しても eslint は exit 2 で失敗せず、slides.md を lint し続ける', async () => {
    const talk = await setupTalkDirectory()
    const entries = readdirSync(path.join(talk, 'pages'))
    for (const entry of entries) {
      rmSync(path.join(talk, 'pages', entry), { recursive: true, force: true })
    }

    // slides.md は talk-dir マーカーなので残る。--no-error-on-unmatched-pattern により
    // pages が 0 件でも異常終了せず、残った slides.md の違反が報告される。
    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.lintedFileCount).toBe(1)
    expect(summary.outcome).toBe('violations')
    expect(summary.violations.every(v => v.file === 'slides.md')).toBe(true)
  })
})

// symlink 経由の talk-dir 指定に対する回帰テスト。
// 本番で起きた構成は 2 つある。
// 1 つ目は、worktree の `.pecot/work` が base リポへの symlink になっている構成。
// その配下に置いた talk-dir を `--dir` に渡すケース（トポロジ B）が当たる。
// 2 つ目は、talk-dir 自体は物理パスで、`pages/<subdir>` が symlink になっているケース（トポロジ E）。
//
// トポロジ A（`pages/` 自体が symlink）と D（ページファイル自体が symlink）は、
// 現状の eslint では取りこぼしが起きない「免疫」ケース。
// ただし免疫が成り立つのは eslint の内部仕様に依存する。
// 内部仕様とは、glob の起点が symlink なら辿ることと、`filePath` を realpath でなく論理パスで返すこと。
// そのため caret bump での退行を検知する目的で、lint される側を固定する。
describe('symlink 経由の talk-dir', () => {
  it('pages/ 自体が talk-dir 外への symlink でも配下が lint される（トポロジ A）', async () => {
    const talk = await setupTalkDirectory('topo-a')
    // pages/ の実体を talk-dir 外へ出し、同じ位置に symlink を張り直す。
    const external = path.join(state.temporaryRoot, 'topo-a-external')
    renameSync(path.join(talk, 'pages'), external)
    symlinkSync(external, path.join(talk, 'pages'), 'dir')
    writeFileSync(
      path.join(external, '01-hidden.md'),
      '---\nlayout: plain\nheading: 隠れページ\n---\n',
      'utf8',
    )
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/01-hidden.md\n---\n', 'utf8')

    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    // 初期 page 4 枚 + 01-hidden.md + slides.md。symlink 越しの page が抜ければ減る。
    expect(summary.lintedFileCount).toBe(6)
    const offending = summary.violations.find(
      v => v.rule === 'slidev-pages-lint/no-numeric-filename-prefix',
    )
    expect(offending?.file).toBe(path.join('pages', '01-hidden.md'))
    // 検出器は `pages/` 自体の symlink を見ないため、過剰警告もしない。
    expect(summary.skippedSymlinkDirectories).toStrictEqual([])
  })

  it('ページファイル自体が talk-dir 外への symlink でも lint される（トポロジ D）', async () => {
    const talk = await setupTalkDirectory('topo-d')
    const external = path.join(state.temporaryRoot, 'topo-d-external')
    mkdirSync(external)
    writeFileSync(
      path.join(external, '01-linked.md'),
      '---\nlayout: plain\nheading: リンクページ\n---\n',
      'utf8',
    )
    symlinkSync(
      path.join(external, '01-linked.md'),
      path.join(talk, 'pages', '01-linked.md'),
      'file',
    )
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/01-linked.md\n---\n', 'utf8')

    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.lintedFileCount).toBe(6)
    const offending = summary.violations.find(
      v => v.rule === 'slidev-pages-lint/no-numeric-filename-prefix',
    )
    expect(offending?.file).toBe(path.join('pages', '01-linked.md'))
    // 検出器側（symlink→ファイルは報告しない）は integration/infra/fs.test.ts が固定する。
    expect(summary.skippedSymlinkDirectories).toStrictEqual([])
  })

  it('talk-dir 自体が symlink でも物理パス実行と同じ集計になる（トポロジ B）', async () => {
    const talk = await setupTalkDirectory('topo-b')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')
    const aliasTalk = path.join(state.temporaryRoot, 'topo-b-alias')
    symlinkSync(talk, aliasTalk, 'dir')

    const physical = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    const viaSymlink = await runSlideLintFromCli(aliasTalk, lintDependencies(makeStream(), makeStream()))

    expect(viaSymlink.outcome).toBe(physical.outcome)
    expect(viaSymlink.lintedFileCount).toBe(physical.lintedFileCount)
    expect(viaSymlink.errorCount).toBe(physical.errorCount)
    expect(new Set(viaSymlink.violations.map(v => v.rule)))
      .toStrictEqual(new Set(physical.violations.map(v => v.rule)))
    // symlink 経由では eslint の filePath（物理 cwd 基準）が論理 talk-dir の外に出る。
    // そのため toRelativePath は絶対パスを返す設計になっている。
    // 完全一致は環境に依存するので、絶対パスであることと、区切り込みのサフィックスで形の drift を検知する。
    const ghost = viaSymlink.violations.find(v => v.rule === 'slidev-pages-lint/no-missing-page')
    expect(ghost).toBeDefined()
    expect(path.isAbsolute(ghost?.file ?? '')).toBe(true)
    expect(ghost?.file.endsWith(path.join('topo-b', 'slides.md'))).toBe(true)
  })

  it('pages/<subdir> が symlink の場合は通知なしにスキップせず警告する（トポロジ E）', async () => {
    const talk = await setupTalkDirectory('topo-e')
    // talk-dir 外の実体。eslint の glob walk は dirent.isDirectory() で再帰先を決める。
    // symlink dir を辿らず、配下の違反は 1 件も報告されないまま clean で通過する。
    const external = path.join(state.temporaryRoot, 'topo-e-external')
    mkdirSync(external)
    writeFileSync(
      path.join(external, '01-hidden.md'),
      '---\nlayout: plain\nheading: 隠れページ\n---\n',
      'utf8',
    )
    symlinkSync(external, path.join(talk, 'pages', 'sub'), 'dir')

    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.skippedSymlinkDirectories).toStrictEqual([path.join('pages', 'sub')])
    // symlink 配下の 01-hidden.md は lint されない。件数と outcome は変わらない。
    expect(summary.lintedFileCount).toBe(5)
    expect(summary.outcome).toBe('clean')
  })

  it('警告行は stderr に出る（トポロジ E）', async () => {
    const talk = await setupTalkDirectory('topo-e-cli')
    const external = path.join(state.temporaryRoot, 'topo-e-cli-external')
    mkdirSync(external)
    symlinkSync(external, path.join(talk, 'pages', 'sub'), 'dir')

    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideLintCommand(() => lintDependencies(stdout, stderr))
    await command.parseAsync(['--dir', talk], { from: 'user' })
    // 文言も lock する。symlink 先が talk-dir 内実体・空 dir・md 非対象のケースでは、
    // 「lint されていない」と言い切ると誤りになる。可能性を示す表現から後退させない。
    expect(stderr.chunks.join('')).toContain(
      `warning: ${path.join('pages', 'sub')} is a symlink and is not scanned by eslint`
      + ' (files under it may not be linted)',
    )
    expect(stdout.chunks.join('')).not.toContain('symlink')
    expect(stdout.chunks.join('')).toContain('linted 5 files')
  })

  it('lint 対象 0 件でも symlink 警告を出す（警告ループの位置ロック）', () => {
    // no-target と symlink 警告が同時に成り立つ状況は、実 pipeline では作れない。
    // slides.md は、assertTalkDirectory が必須とするマーカー。
    // eslint に 0 件を返させるには、slides.md を md を含まないディレクトリにするしかない。
    // それではテストが検知すべき eslint の引数展開仕様を、前提に使ってしまう。
    // そこで summary を直接組んで、警告が no-target の早期 return より前にあることを固定する。
    const stdout = makeStream()
    const stderr = makeStream()
    writeAutoDeckLintReport(
      {
        summary: {
          directory: '/talk',
          lintedFileCount: 0,
          errorCount: 0,
          warningCount: 0,
          violations: [],
          outcome: 'no-target',
          skippedSymlinkDirectories: [path.join('pages', 'sub')],
        },
        failure: undefined,
      },
      '/talk',
      lintDependencies(stdout, stderr),
    )

    expect(stderr.chunks.join('')).toContain(`warning: ${path.join('pages', 'sub')} is a symlink and is not scanned by eslint`)
    expect(stdout.chunks.join('')).toContain('linted 0 files')
  })

  it('--json は skippedSymlinkDirectories を載せる（トポロジ E）', async () => {
    const talk = await setupTalkDirectory('topo-e-json')
    const external = path.join(state.temporaryRoot, 'topo-e-json-external')
    mkdirSync(external)
    symlinkSync(external, path.join(talk, 'pages', 'sub'), 'dir')

    const stdout = makeStream()
    const command = createSlideLintCommand(() => lintDependencies(stdout, makeStream()))
    await command.parseAsync(['--dir', talk, '--json'], { from: 'user' })
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as {
      event: string
      outcome: string
      skippedSymlinkDirectories: string[]
    }
    expect(parsed.event).toBe('slide.lint.done')
    expect(parsed.outcome).toBe('clean')
    expect(parsed.skippedSymlinkDirectories).toStrictEqual([path.join('pages', 'sub')])
  })

  it('create / sync の自動 deck lint にも警告が乗る（トポロジ E）', async () => {
    const talk = await setupTalkDirectory('topo-e-auto')
    const external = path.join(state.temporaryRoot, 'topo-e-auto-external')
    mkdirSync(external)
    symlinkSync(external, path.join(talk, 'pages', 'sub'), 'dir')

    const stderr = makeStream()
    const dependencies = lintDependencies(makeStream(), stderr)
    const report = await runAutoDeckLint(talk, dependencies)
    writeAutoDeckLintReport(report, talk, dependencies)

    expect(stderr.chunks.join('')).toContain(`warning: ${path.join('pages', 'sub')} is a symlink and is not scanned by eslint`)
    expect(autoDeckLintJsonField(report))
      .toMatchObject({ skippedSymlinkDirectories: [path.join('pages', 'sub')] })
  })
})

describe('テーマの宣言で動く lint (実 eslint)', () => {
  it('宣言した規則（max-chars）で、references の text_constraints を超えた見出しを報告する', async () => {
    const talk = await setupTalkDirectory('declared', { declaredRules: true })
    // fixture の plain.yaml は heading の max_chars が 20
    writeFileSync(
      path.join(talk, 'pages', 'section.md'),
      '---\nlayout: plain\nheading: 二十文字を超える見出しの例をここに置いています\n---\n',
      'utf8',
    )
    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.outcome).toBe('violations')
    const maxChars = summary.violations.filter(v => v.rule === 'text-constraints/max-chars')
    expect(maxChars.map(v => v.file)).toStrictEqual([path.join('pages', 'section.md')])
  })

  it('宣言した規則に無い規則（連番プレフィックス）は、同じ違反があっても報告しない', async () => {
    const talk = await setupTalkDirectory('declared-only', { declaredRules: true })
    writeFileSync(path.join(talk, 'pages', '01-intro.md'), '---\nlayout: plain\nheading: イントロ\n---\n', 'utf8')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/01-intro.md\n---\n', 'utf8')
    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.violations.map(v => v.rule)).not.toContain('slidev-pages-lint/no-numeric-filename-prefix')
    expect(summary.outcome).toBe('clean')
  })

  it('宣言した references に無いプロパティは no-unknown-props で報告する', async () => {
    const talk = await setupTalkDirectory('declared-props', { declaredRules: true })
    writeFileSync(
      path.join(talk, 'pages', 'section.md'),
      '---\nlayout: plain\nheading: 見出し\nnot_a_prop: x\n---\n',
      'utf8',
    )
    const summary = await runSlideLintFromCli(talk, lintDependencies(makeStream(), makeStream()))
    expect(summary.violations.map(v => v.rule)).toContain('slidev-pages-lint/no-unknown-props')
  })

  it('テーマを張っていない talk-dir は theme-unlinked の失敗になる', async () => {
    const talk = await setupTalkDirectory('unlinked')
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideLintCommand(() => lintDependencies(stdout, makeStream()))
      await command.parseAsync(['--dir', talk, '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as { event: string, reason: string, detail: string }
      expect(parsed.event).toBe('slide.lint.error')
      expect(parsed.reason).toBe('theme-unlinked')
      expect(parsed.detail).toContain('--node-modules-only')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('theme: none で宣言も無い talk-dir は theme-none の失敗になり、slide sync --theme を案内する', async (context) => {
    await verifies(context, 'PV-SLIDE-LINT-06')
    const talk = await setupTalkDirectory('legacy')
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n', 'utf8')
    const stderr = makeStream()
    const previousExitCode = process.exitCode
    try {
      const eslint = countingEslint()
      const command = createSlideLintCommand(() => ({ ...lintDependencies(makeStream(), stderr), eslint: eslint.runner }))
      await command.parseAsync(['--dir', talk], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('slide sync --theme <theme-spec>')
      expect(process.exitCode).toBe(1)
      const stdout = makeStream()
      const jsonCommand = createSlideLintCommand(() => ({ ...lintDependencies(stdout, makeStream()), eslint: eslint.runner }))
      await jsonCommand.parseAsync(['--dir', talk, '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as { event: string, reason: string }
      expect(parsed).toMatchObject({ event: 'slide.lint.error', reason: 'theme-none' })
      expect(eslint.calls()).toBe(0)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('theme: none で dir 自身に pecot-theme.json があれば、テーマの dir だと伝えて止まる', async () => {
    const talk = path.join(state.temporaryRoot, 'self')
    cpSync(THEME_FIXTURE, talk, { recursive: true })
    mkdirSync(path.join(talk, 'pages'), { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n\n---\nsrc: ./pages/cover.md\n---\n', 'utf8')
    writeFileSync(path.join(talk, 'pages', 'cover.md'), INITIAL_PAGES[0]?.[1] ?? '', 'utf8')
    const dependencies = lintDependencies(makeStream(), makeStream())
    await expect(runSlideLintFromCli(talk, dependencies)).rejects.toThrow('it is a theme dir')
  })
})

describe('createSlideLintCommand', () => {
  it('clean な talk-dir は人間向けに件数を出し exit code を変えない', async () => {
    const talk = await setupTalkDirectory()
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideLintCommand(() => lintDependencies(stdout, makeStream()))
      await command.parseAsync(['--dir', talk], { from: 'user' })
      const written = stdout.chunks.join('')
      expect(written.split('\n', 1)[0]).toBe(`slide lint: success (${talk})`)
      expect(written).toContain('linted 5 files')
      expect(written).toContain('0 errors')
      expect(process.exitCode).toBe(previousExitCode)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('違反ありは違反一覧を出して exit 1', async () => {
    const talk = await setupTalkDirectory()
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideLintCommand(() => lintDependencies(stdout, makeStream()))
      await command.parseAsync(['--dir', talk], { from: 'user' })
      const written = stdout.chunks.join('')
      expect(written.split('\n', 1)[0]).toBe(`slide lint: violations (${talk})`)
      expect(written).toContain('slidev-pages-lint/no-missing-page')
      expect(written).toContain('slides.md:')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json 違反ありは slide.lint.violations を出す', async (context) => {
    await verifies(context, 'PV-SLIDE-LINT-01')
    await verifies(context, 'PV-SLIDE-LINT-04')
    const talk = await setupTalkDirectory()
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')
    writeFileSync(path.join(talk, 'pages', '01-prefixed.md'), '---\nlayout: plain\nheading: 見出し\n---\n', 'utf8')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/01-prefixed.md\n---\n', 'utf8')
    const before = snapshotFiles(talk)
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideLintCommand(() => lintDependencies(stdout, makeStream()))
      await command.parseAsync(['--dir', talk, '--json'], { from: 'user' })
      expect(snapshotFiles(talk)).toStrictEqual(before)
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as {
        event: string
        outcome: string
        lintedFileCount: number
        violations: { rule: string }[]
      }
      expect(parsed.event).toBe('slide.lint.violations')
      expect(parsed.outcome).toBe('violations')
      expect(parsed.lintedFileCount).toBe(6)
      expect(parsed.violations.map(v => v.rule)).toContain('slidev-pages-lint/no-missing-page')
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json は本文とノートの違反をファイル行付きで slide.lint.violations に載せる', async () => {
    const talk = await setupTalkDirectory()
    addBodyNotePage(talk)
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideLintCommand(() => lintDependencies(stdout, makeStream()))
      await command.parseAsync(['--dir', talk, '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as {
        event: string
        violations: { rule: string, line: number, message: string }[]
      }
      expect(parsed.event).toBe('slide.lint.violations')
      const body = parsed.violations.filter(v => v.rule === 'text-constraints/textlint-body')
      expect(body.map(v => v.line)).toStrictEqual([6, 9])
      expect(body[0]?.message).toMatch(/^body L6: /)
      expect(body[1]?.message).toMatch(/^speaker notes L9: /)
      expect(process.exitCode).toBe(1)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--json clean は slide.lint.done を出す', async () => {
    const talk = await setupTalkDirectory()
    const stdout = makeStream()
    const command = createSlideLintCommand(() => lintDependencies(stdout, makeStream()))
    await command.parseAsync(['--dir', talk, '--json'], { from: 'user' })
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as { event: string, outcome: string }
    expect(parsed.event).toBe('slide.lint.done')
    expect(parsed.outcome).toBe('clean')
  })

  it('相対 --dir は slide.lint.error(relative-dir) + exit 2', async () => {
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideLintCommand(() => lintDependencies(stdout, makeStream()))
      await command.parseAsync(['--dir', 'relative/talk', '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as { event: string, reason: string }
      expect(parsed.event).toBe('slide.lint.error')
      expect(parsed.reason).toBe('relative-dir')
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('相対 --dir + --json なしは stderr に "error: slide lint 失敗:" が出る（exit 2 は据え置き）', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideLintCommand(() => lintDependencies(stdout, stderr))
      await command.parseAsync(['--dir', 'relative/talk'], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('error: slide lint failed:')
      expect(stdout.chunks.length).toBe(0)
      expect(process.exitCode).toBe(2)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('slides.md が無い dir は slide.lint.error(not-talk-dir) + exit 1', async (context) => {
    await verifies(context, 'PV-SLIDE-LINT-05')
    const stdout = makeStream()
    const stderr = makeStream()
    const previousExitCode = process.exitCode
    try {
      const eslint = countingEslint()
      const command = createSlideLintCommand(() => ({ ...lintDependencies(stdout, stderr), eslint: eslint.runner }))
      await command.parseAsync(['--dir', state.temporaryRoot], { from: 'user' })
      expect(stderr.chunks.join('')).toContain('error: slide lint failed:')
      expect(stderr.chunks.join('')).toContain('slides.md')
      expect(process.exitCode).toBe(1)
      const jsonOut = makeStream()
      const jsonCommand = createSlideLintCommand(() => ({ ...lintDependencies(jsonOut, makeStream()), eslint: eslint.runner }))
      await jsonCommand.parseAsync(['--dir', state.temporaryRoot, '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastJsonLine(jsonOut.chunks)) as { event: string, reason: string }
      expect(parsed).toMatchObject({ event: 'slide.lint.error', reason: 'not-talk-dir' })
      expect(eslint.calls()).toBe(0)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('--dir 未指定 + --json は commander が slide.lint.error(invalid-option) を stdout に出す', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideLintCommand(() => lintDependencies(stdout, stderr))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'lint', '--json']
    try {
      await expect(command.parseAsync(['--json'], { from: 'user' })).rejects.toThrow()
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(stdout.chunks.join('').trim()) as { event: string, reason: string }
      expect(parsed.event).toBe('slide.lint.error')
      expect(parsed.reason).toBe('invalid-option')
      expect(stderr.chunks.length).toBe(0)
    }
    finally {
      process.argv = originalArgv
    }
  })

  it('--dir 未指定 + --json なしは commander が stderr に英文を出す', async () => {
    const stdout = makeStream()
    const stderr = makeStream()
    const command = createSlideLintCommand(() => lintDependencies(stdout, stderr))
    const originalArgv = process.argv
    process.argv = ['node', 'cli.js', 'slide', 'lint']
    try {
      await expect(command.parseAsync([], { from: 'user' })).rejects.toThrow()
      expect(stderr.chunks.join('')).toContain('required option')
      expect(stdout.chunks.length).toBe(0)
    }
    finally {
      process.argv = originalArgv
    }
  })
})

describe('create / sync 末尾の自動 deck lint', () => {
  it('slide create は deck lint 要約を stdout に出す', async () => {
    const projectDirectory = path.join(state.temporaryRoot, 'auto-create')
    const stdout = makeStream()
    const command = createSlideCreateCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      now: () => 0,
    }))
    await command.parseAsync([projectDirectory, '--theme', copyThemeForTalk(state.temporaryRoot, 'theme-src').spec], { from: 'user' })
    const written = stdout.chunks.join('')
    expect(written).toContain('deck lint:')
    expect(written).toContain('linted 4 files')
  })

  it('slide create の成功行は deck lint 要約より先に出る', async () => {
    const projectDirectory = path.join(state.temporaryRoot, 'auto-create-order')
    const stdout = makeStream()
    const command = createSlideCreateCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      now: () => 0,
    }))
    await command.parseAsync([projectDirectory, '--theme', copyThemeForTalk(state.temporaryRoot, 'theme-src').spec], { from: 'user' })
    const written = stdout.chunks.join('')
    // lint がスキップされると deck lint 要約は stderr へ回るため、順序比較の前に
    // 両方が stdout に出ていることを確かめる。
    expect(written).toContain('slide create: success')
    expect(written).toContain('deck lint:')
    const successIndex = written.indexOf('slide create: success')
    const countIndex = written.indexOf('linted ')
    expect(countIndex).toBeGreaterThan(successIndex)
  })

  it('slide create --json は slide.create.done に lint 要約を載せる', async (context) => {
    await verifies(context, 'PV-SLIDE-CREATE-03')
    const projectDirectory = path.join(state.temporaryRoot, 'auto-create-json')
    const stdout = makeStream()
    const command = createSlideCreateCommand(() => ({
      pluginRoot: PLUGIN_ROOT,
      stdout: asStream(stdout),
      stderr: asStream(makeStream()),
      now: () => 0,
    }))
    await command.parseAsync([projectDirectory, '--theme', copyThemeForTalk(state.temporaryRoot, 'theme-src').spec, '--json'], { from: 'user' })
    // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
    const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as {
      event: string
      lint: { skipped: boolean, outcome: string, lintedFileCount: number }
    }
    expect(parsed.event).toBe('slide.create.done')
    expect(parsed.lint.skipped).toBe(false)
    expect(parsed.lint.outcome).toBe('clean')
    expect(parsed.lint.lintedFileCount).toBe(4)
  })

  it('slide create は生成直後の lint が違反を見つけても成功を返し、data.lint に違反を載せる', async (context) => {
    await verifies(context, 'PV-SLIDE-CREATE-04')
    const projectDirectory = path.join(state.temporaryRoot, 'auto-create-violations')
    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: copyThemeForTalk(state.temporaryRoot, 'theme-src').spec, force: false, emitCatalog: false },
      { ...lintDependencies(makeStream(), makeStream()), now: () => 0 },
      (summary) => { appendFileSync(slidesPathOf(summary.projectDirectory), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8') },
    )
    // eslint-disable-next-line no-restricted-syntax -- data の narrowing
    const { event, lint } = data as { event: string, lint: { skipped: boolean, outcome: string, violations: { rule: string }[] } }
    expect(event).toBe('slide.create.done')
    expect(lint.skipped).toBe(false)
    expect(lint.outcome).toBe('violations')
    expect(lint.violations.map(v => v.rule)).toContain('slidev-pages-lint/no-missing-page')
    expect(existsSync(path.join(projectDirectory, 'slides.md'))).toBe(true)
  })

  it('slide sync --json は同期の後の deck lint の結果を data.lint に載せる', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-06')
    const talk = await setupTalkDirectory('auto-sync-json')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideSyncCommand(() => syncDependencies(talk, stdout, makeStream()))
      await command.parseAsync(['--dir', talk, '--node-modules-only', '--json'], { from: 'user' })
      // eslint-disable-next-line no-restricted-syntax -- JSON.parse 戻りの narrowing
      const parsed = JSON.parse(lastJsonLine(stdout.chunks)) as {
        event: string
        lint: { skipped: boolean, outcome: string, lintedFileCount: number, violations: { rule: string }[] }
      }
      expect(parsed.event).toBe('slide.sync.done')
      expect(parsed.lint.skipped).toBe(false)
      expect(parsed.lint.outcome).toBe('violations')
      expect(parsed.lint.lintedFileCount).toBe(5)
      expect(parsed.lint.violations.map(v => v.rule)).toContain('slidev-pages-lint/no-missing-page')
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('slide sync は違反があっても exit code を変えず deck lint 一覧と再確認コマンドを出す', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-06')
    const talk = await setupTalkDirectory('auto-sync')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')
    const stdout = makeStream()
    const previousExitCode = process.exitCode
    try {
      // ensureThemeLinked を差し替えているため、張り直しだけの --node-modules-only で自動 lint を確かめる。
      const command = createSlideSyncCommand(() => syncDependencies(talk, stdout, makeStream()))
      await command.parseAsync(['--dir', talk, '--node-modules-only'], { from: 'user' })
      const written = stdout.chunks.join('')
      // 違反一覧が続いても、sync の成否は先頭行で読める。
      expect(written.split('\n', 1)[0]).toBe(`slide sync (node_modules only): success (${talk})`)
      expect(written).toContain('deck lint:')
      expect(written).toContain('slidev-pages-lint/no-missing-page')
      expect(written).toContain(`pecotv slide lint --dir ${talk}`)
      // 成否行 → 件数行 → 違反行の順序を固定する。
      const successIndex = written.indexOf('slide sync (node_modules only): success')
      const countIndex = written.indexOf('linted ')
      const violationIndex = written.indexOf('slidev-pages-lint/no-missing-page')
      expect(successIndex).toBeGreaterThanOrEqual(0)
      expect(countIndex).toBeGreaterThan(successIndex)
      expect(violationIndex).toBeGreaterThan(countIndex)
      // 自動 lint の違反は sync の成否に影響しない
      expect(process.exitCode).toBe(previousExitCode)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('slide sync --node-modules-only でも deck lint 要約を出す', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-06')
    const talk = await setupTalkDirectory('auto-sync-nm')
    const stdout = makeStream()
    const command = createSlideSyncCommand(() => syncDependencies(talk, stdout, makeStream()))
    await command.parseAsync(['--dir', talk, '--node-modules-only'], { from: 'user' })
    const written = stdout.chunks.join('')
    expect(written.split('\n', 1)[0]).toBe(`slide sync (node_modules only): success (${talk})`)
    expect(written).toContain('deck lint:')
  })

  it('deck lint が実行できなくても sync の成功行は stdout に残る', async () => {
    const talk = await setupTalkDirectory('auto-sync-lint-broken')
    // eslint 資材を持たない plugin root。node_modules だけ用意して symlink の張り替えは通し、
    // deck lint 側だけ失敗する状況にする。
    // --node-modules-only は template をコピーしないため、この plugin root でも sync 自体は成功する。
    const brokenRoot = path.join(state.temporaryRoot, 'broken-plugin-root')
    seedDependencyRoot(brokenRoot)
    const stdout = makeStream()
    const stderr = makeStream()
    const previousExitCode = process.exitCode
    try {
      const command = createSlideSyncCommand(() => syncDependencies(talk, stdout, stderr, brokenRoot))
      await command.parseAsync(['--dir', talk, '--node-modules-only'], { from: 'user' })
      expect(stdout.chunks.join('').split('\n', 1)[0])
        .toBe(`slide sync (node_modules only): success (${talk})`)
      expect(stderr.chunks.join('')).toContain('deck lint skipped')
      expect(process.exitCode).toBe(previousExitCode)
    }
    finally {
      process.exitCode = previousExitCode
    }
  })

  it('template が解決できない場合は警告に留め、呼び出し元を失敗させない', async () => {
    const talk = await setupTalkDirectory('auto-lint-skip')
    const stderr = makeStream()
    // eslint 資材を持たない plugin root を渡し、自動 lint だけが失敗する状況を作る。
    const brokenDependencies = {
      pluginRoot: path.join(state.temporaryRoot, 'no-such-plugin-root'),
      stdout: asStream(makeStream()),
      stderr: asStream(stderr),
    }
    const report = await runAutoDeckLint(talk, brokenDependencies)
    expect(report.summary).toBeUndefined()
    expect(report.failure).toBeTruthy()

    writeAutoDeckLintReport(report, talk, brokenDependencies)
    expect(stderr.chunks.join('')).toContain('deck lint skipped')
    expect(autoDeckLintJsonField(report)).toMatchObject({ skipped: true })
  })
})

describe('slideLintDefaultDependencies', () => {
  it('PECOTV_RUNTIME_DIR があれば runtimeDirectory に入れる（runtime/current は使わない）。pluginRoot は CLAUDE_PLUGIN_ROOT のまま', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/tmp/x')
    vi.stubEnv('PECOTV_RUNTIME_DIR', '/data/runtime/abc-def')
    vi.stubEnv('PECOTV_DEPENDENCY_ROOT', '/data/runtime/current')
    try {
      const dependencies = slideLintDefaultDependencies()
      expect(dependencies.pluginRoot).toBe('/tmp/x')
      expect(dependencies.runtimeDirectory).toBe('/data/runtime/abc-def')
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it('CLAUDE_PLUGIN_ROOT を読んで pluginRoot を構築する', () => {
    const previous = process.env['CLAUDE_PLUGIN_ROOT']
    process.env['CLAUDE_PLUGIN_ROOT'] = '/tmp/x'
    try {
      expect(slideLintDefaultDependencies().pluginRoot).toBe('/tmp/x')
    }
    finally {
      if (previous === undefined) {
        delete process.env['CLAUDE_PLUGIN_ROOT']
      }
      else {
        process.env['CLAUDE_PLUGIN_ROOT'] = previous
      }
    }
  })
})

// 本文（6 行目）とノート（9 行目）に違反文を置いたページを足す。違反文は語を分けて組み立てる。
function addBodyNotePage(talk: string): void {
  const hype = ['ゲーム', 'チェンジャー', 'となる基盤です。'].join('')
  writeFileSync(
    path.join(talk, 'pages', 'body-note.md'),
    ['---', 'layout: plain', 'heading: 基盤', '---', '', hype, '', '<!--', hype, '-->', ''].join('\n'),
    'utf8',
  )
  appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/body-note.md\n---\n', 'utf8')
}

function countingEslint(): { readonly runner: EslintRunner, readonly calls: () => number } {
  let count = 0
  const runner: EslintRunner = {
    run: () => {
      count += 1
      return Promise.reject(new Error('eslint は起動されない想定'))
    },
  }
  return { runner, calls: () => count }
}

function snapshotFiles(directory: string): Map<string, string> {
  const entries = new Map<string, string>()
  const walk = (current: string): void => {
    const children = readdirSync(current, { withFileTypes: true })
    for (const entry of children) {
      const target = path.join(current, entry.name)
      if (entry.name === 'node_modules') continue
      if (entry.isDirectory()) walk(target)
      else entries.set(path.relative(directory, target), readFileSync(target, 'utf8'))
    }
  }
  walk(directory)
  return entries
}

function slidesPathOf(talkDirectory: string): string {
  return path.join(talkDirectory, 'slides.md')
}

function lastJsonLine(chunks: readonly string[]): string {
  return chunks.join('').trim().split('\n').findLast(line => line.trimStart().startsWith('{')) ?? ''
}

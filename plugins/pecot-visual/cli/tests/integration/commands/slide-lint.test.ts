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
import { executeSlideCreate } from '../../../src/commands/slidev-project/create.js'
import {
  autoDeckLintJsonField,
  errorToReason as slideLintErrorToReason,
  executeSlideLint,
  runAutoDeckLint,
  runSlideLintDirectly,
  slideLintDefaultDependencies,
} from '../../../src/commands/slidev-project/lint.js'
import { executeSlideSync } from '../../../src/commands/slidev-project/sync.js'
import { resolvePluginRoot } from '../../../src/infra/_shared/plugin-root.js'
import { seedDependencyRoot } from '../../_helpers/dependency-probes.js'
import { rejectionOf } from '../../_helpers/rejection.js'
import { verifies } from '../../_helpers/verifies.js'
import {
  asStream,
  assertTemplatePluginsBuilt,
  type CapturedStream,
  copyThemeForTalk,
  makeStream,
  PLUGIN_ROOT,
} from '../../_helpers/talk-directory.js'
import { explains } from '../../_helpers/explains.js'

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

function quietDependencies(): ReturnType<typeof lintDependencies> {
  return lintDependencies(makeStream(), makeStream())
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

describe('runSlideLintDirectly (実 eslint)', () => {
  it('slide create 直後の talk-dir を lint すると、対象は 5 件で、エラーはなく clean になる', async () => {
    await explains('`runSlideLintFromCli` を、生成直後の talk-dir に実行するテストです。初期ページ 4 枚と `slides.md` の計 5 件が対象になり、エラーと違反がなく `clean` になることを確認します。')
    const talk = await setupTalkDirectory()
    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.outcome).toBe('clean')
    // 初期 page 4 枚 + slides.md
    expect(summary.lintedFileCount).toBe(5)
    expect(summary.errorCount).toBe(0)
    expect(summary.violations).toStrictEqual([])
  })

  it('連番の接頭辞を持つページがあると、no-numeric-filename-prefix の違反を報告する', async () => {
    await explains('ページ名のチェックのテストです。`01-intro.md` のように連番で始まるページを参照した場合に、`no-numeric-filename-prefix` の違反が、そのページのパスとともに報告されることを確認します。')
    const talk = await setupTalkDirectory()
    // slides.md からも参照して require-slides-entry / no-missing-page を成立させる。
    writeFileSync(
      path.join(talk, 'pages', '01-intro.md'),
      '---\nlayout: plain\nheading: イントロ\n---\n',
      'utf8',
    )
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/01-intro.md\n---\n', 'utf8')

    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.outcome).toBe('violations')
    expect(summary.errorCount).toBeGreaterThan(0)
    const rules = summary.violations.map(v => v.rule)
    expect(rules).toContain('slidev-pages-lint/no-numeric-filename-prefix')
    const offending = summary.violations.find(
      v => v.rule === 'slidev-pages-lint/no-numeric-filename-prefix',
    )
    expect(offending?.file).toBe(path.join('pages', '01-intro.md'))
  })

  it('slides.md が存在しないページを src で参照していると、no-missing-page の違反を報告する', async () => {
    await explains('`slides.md` の参照のチェックのテストです。存在しない `./pages/__ghost.md` を参照した場合に、`no-missing-page` の違反が報告され、メッセージにそのファイル名が含まれることを確認します。')
    const talk = await setupTalkDirectory()
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')

    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.outcome).toBe('violations')
    const ghost = summary.violations.find(
      v => v.rule === 'slidev-pages-lint/no-missing-page',
    )
    expect(ghost?.file).toBe('slides.md')
    expect(ghost?.message).toContain('__ghost.md')
  })

  it('本文とノートに文面の違反があると、textlint-body として行番号付きで報告する', async () => {
    await explains('本文とスピーカーノートの文面のチェックのテストです。禁止された表現を本文の 6 行目とノートの 9 行目へ置いた場合に、`textlint-body` の違反が、ファイルと行番号付きで 2 件報告されることを確認します。')
    const talk = await setupTalkDirectory()
    addBodyNotePage(talk)

    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.outcome).toBe('violations')
    const body = summary.violations.filter(v => v.rule === 'text-constraints/textlint-body')
    expect(body.map(v => ({ file: v.file, line: v.line }))).toStrictEqual([
      { file: path.join('pages', 'body-note.md'), line: 6 },
      { file: path.join('pages', 'body-note.md'), line: 9 },
    ])
    expect(body[0]?.message).toMatch(/^body L6: .+ \(no-ai-hype-expressions\)$/)
    expect(body[1]?.message).toMatch(/^speaker notes L9: .+ \(no-ai-hype-expressions\)$/)
  })

  it('pages のページをすべて削除しても、eslint は異常終了せず、slides.md の lint を続ける', async () => {
    await explains('ページが 1 つもない talk-dir を lint するテストです。`pages` のファイルをすべて削除した場合に、eslint が終了コード 2 で失敗せず、残った `slides.md` だけが対象の 1 件になり、その違反が報告されることを確認します。')
    const talk = await setupTalkDirectory()
    const entries = readdirSync(path.join(talk, 'pages'))
    for (const entry of entries) {
      rmSync(path.join(talk, 'pages', entry), { recursive: true, force: true })
    }

    // slides.md は talk-dir マーカーなので残る。--no-error-on-unmatched-pattern により
    // pages が 0 件でも異常終了せず、残った slides.md の違反が報告される。
    const summary = await runSlideLintDirectly(talk, quietDependencies())
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
  it('pages がディレクトリ外への symlink でも、配下のページを lint する', async () => {
    await explains('`pages` ディレクトリ自体が、talk-dir の外への symlink である場合の、lint のテストです。symlink の先に置いたページを含む 6 件が対象になり、そのページの違反が報告され、symlink の警告は出ないことを確認します。')
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

    const summary = await runSlideLintDirectly(talk, quietDependencies())
    // 初期 page 4 枚 + 01-hidden.md + slides.md。symlink 越しの page が抜ければ減る。
    expect(summary.lintedFileCount).toBe(6)
    const offending = summary.violations.find(
      v => v.rule === 'slidev-pages-lint/no-numeric-filename-prefix',
    )
    expect(offending?.file).toBe(path.join('pages', '01-hidden.md'))
    // 検出器は `pages/` 自体の symlink を見ないため、過剰警告もしない。
    expect(summary.skippedSymlinkDirectories).toStrictEqual([])
  })

  it('ページのファイルがディレクトリ外への symlink でも、そのページを lint する', async () => {
    await explains('ページのファイル自体が、talk-dir の外への symlink である場合の、lint のテストです。symlink の先のページを含む 6 件が対象になり、そのページの `no-numeric-filename-prefix` の違反が報告されることを確認します。')
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

    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.lintedFileCount).toBe(6)
    const offending = summary.violations.find(
      v => v.rule === 'slidev-pages-lint/no-numeric-filename-prefix',
    )
    expect(offending?.file).toBe(path.join('pages', '01-linked.md'))
    // 検出器側（symlink→ファイルは報告しない）は integration/infra/fs.test.ts が固定する。
    expect(summary.skippedSymlinkDirectories).toStrictEqual([])
  })

  it('talk-dir 自体が symlink でも、実際のパスで実行した場合と同じ結果を集計する', async () => {
    await explains('talk-dir への symlink を `--dir` に指定した場合の、lint のテストです。実際のパスで実行した場合と、結果・対象の件数・エラー数・違反の規則が一致し、違反のファイルが絶対パスで報告されることを確認します。')
    const talk = await setupTalkDirectory('topo-b')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')
    const aliasTalk = path.join(state.temporaryRoot, 'topo-b-alias')
    symlinkSync(talk, aliasTalk, 'dir')

    const physical = await runSlideLintDirectly(talk, quietDependencies())
    const viaSymlink = await runSlideLintDirectly(aliasTalk, quietDependencies())

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

  it('pages 配下のサブディレクトリが symlink の場合は、無通知でスキップせず、警告の対象にする', async () => {
    await explains('`pages` 配下のサブディレクトリが symlink である場合の、lint のテストです。eslint が symlink を辿らないため、`skippedSymlinkDirectories` にそのパスが含まれ、対象の件数 5 件と `clean` の結果は変わらないことを確認します。')
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

    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.skippedSymlinkDirectories).toStrictEqual([path.join('pages', 'sub')])
    // symlink 配下の 01-hidden.md は lint されない。件数と outcome は変わらない。
    expect(summary.lintedFileCount).toBe(5)
    expect(summary.outcome).toBe('clean')
  })

  it('slide_lint の data は skippedSymlinkDirectories を載せる（トポロジ E）', async () => {
    await explains('`executeSlideLint` のシンボリックリンクのテストです。`pages` の下に外部へのシンボリックリンクのディレクトリがある場合に、`slide.lint.done` のイベントへ除外したディレクトリが含まれることを確認します。')
    const talk = await setupTalkDirectory('topo-e-json')
    const external = path.join(state.temporaryRoot, 'topo-e-json-external')
    mkdirSync(external)
    symlinkSync(external, path.join(talk, 'pages', 'sub'), 'dir')

    const { data } = await executeSlideLint({ dir: talk }, quietDependencies())

    expect(data).toMatchObject({
      event: 'slide.lint.done',
      outcome: 'clean',
      skippedSymlinkDirectories: [path.join('pages', 'sub')],
    })
  })

  it('create / sync の自動 deck lint の data にも symlink の除外が載る（トポロジ E）', async () => {
    await explains('`runAutoDeckLint` のシンボリックリンクのテストです。`pages` の下へ外部を指すシンボリックリンクがある場合は、`slide_create` と `slide_sync` の自動の lint の結果へ除外したディレクトリが含まれることを確認します。')
    const talk = await setupTalkDirectory('topo-e-auto')
    const external = path.join(state.temporaryRoot, 'topo-e-auto-external')
    mkdirSync(external)
    symlinkSync(external, path.join(talk, 'pages', 'sub'), 'dir')

    const report = await runAutoDeckLint(talk, quietDependencies())

    expect(autoDeckLintJsonField(report))
      .toMatchObject({ skippedSymlinkDirectories: [path.join('pages', 'sub')] })
  })
})

describe('テーマの宣言で動く lint (実 eslint)', () => {
  it('テーマが宣言した max-chars の規則で、references の text_constraints を超えた見出しを報告する', async () => {
    await explains('テーマの宣言に従う lint のテストです。fixture のテーマが宣言した見出しの最大文字数を超えた場合に、`text-constraints/max-chars` の違反が、そのページに対して報告されることを確認します。')
    const talk = await setupTalkDirectory('declared', { declaredRules: true })
    // fixture の plain.yaml は heading の max_chars が 20
    writeFileSync(
      path.join(talk, 'pages', 'section.md'),
      '---\nlayout: plain\nheading: 二十文字を超える見出しの例をここに置いています\n---\n',
      'utf8',
    )
    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.outcome).toBe('violations')
    const maxChars = summary.violations.filter(v => v.rule === 'text-constraints/max-chars')
    expect(maxChars.map(v => v.file)).toStrictEqual([path.join('pages', 'section.md')])
  })

  it('テーマが宣言していない規則は、同じ違反があっても報告しない', async () => {
    await explains('テーマの宣言に従う lint のテストです。連番で始まるページを置いても、テーマが `no-numeric-filename-prefix` を宣言していなければ、その違反が報告されず `clean` になることを確認します。')
    const talk = await setupTalkDirectory('declared-only', { declaredRules: true })
    writeFileSync(path.join(talk, 'pages', '01-intro.md'), '---\nlayout: plain\nheading: イントロ\n---\n', 'utf8')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/01-intro.md\n---\n', 'utf8')
    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.violations.map(v => v.rule)).not.toContain('slidev-pages-lint/no-numeric-filename-prefix')
    expect(summary.outcome).toBe('clean')
  })

  it('references に宣言されていないプロパティがあると、no-unknown-props の違反を報告する', async () => {
    await explains('テーマの宣言に従う lint のテストです。`references` に宣言のないプロパティ `not_a_prop` をページへ置いた場合に、`no-unknown-props` の違反が報告されることを確認します。')
    const talk = await setupTalkDirectory('declared-props', { declaredRules: true })
    writeFileSync(
      path.join(talk, 'pages', 'section.md'),
      '---\nlayout: plain\nheading: 見出し\nnot_a_prop: x\n---\n',
      'utf8',
    )
    const summary = await runSlideLintDirectly(talk, quietDependencies())
    expect(summary.violations.map(v => v.rule)).toContain('slidev-pages-lint/no-unknown-props')
  })

  it('テーマがリンクされていない talk-dir を lint すると、theme-unlinked のエラーになる', async () => {
    await explains('テーマがリンクされていない talk-dir に対する、`slide lint --json` のテストです。`node_modules` を削除した場合に、理由 `theme-unlinked` と `--node-modules-only` の案内を含むイベントが出力され、終了コードが 1 になることを確認します。')
    const talk = await setupTalkDirectory('unlinked')
    rmSync(path.join(talk, 'node_modules'), { recursive: true, force: true })

    const error = await rejectionOf(executeSlideLint({ dir: talk }, quietDependencies()))

    expect(slideLintErrorToReason(error)).toBe('theme-unlinked')
    expect(error instanceof Error ? error.message : '').toContain('node_modules_only')
  })

  it('theme: none で宣言も無い talk-dir は theme-none の失敗になり、slide_sync の theme を案内する', async (context) => {
    await verifies(context, 'PV-SLIDE-LINT-06')
    await explains('`executeSlideLint` のテーマの検証のテストです。`theme` が `none` で宣言もない talk-dir の場合は、理由が `theme-none` の例外が発生し、`slide_sync` の `theme` を案内することを確認します。')
    const talk = await setupTalkDirectory('legacy')
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n', 'utf8')
    const eslint = countingEslint()

    const error = await rejectionOf(executeSlideLint(
      { dir: talk },
      { ...quietDependencies(), eslint: eslint.runner },
    ))

    expect(slideLintErrorToReason(error)).toBe('theme-none')
    expect(error instanceof Error ? error.message : '').toContain('slide_sync with theme: <theme-spec>')
    expect(eslint.calls()).toBe(0)
  })

  it('theme が none で、ディレクトリ自身に pecot-theme.json がある場合は、テーマのディレクトリだと伝えて止まる', async () => {
    await explains('テーマのディレクトリ自体を、talk-dir として lint した場合のテストです。`theme: none` で、同じディレクトリに `pecot-theme.json` がある場合に、`it is a theme dir` を含む例外が発生することを確認します。')
    const talk = path.join(state.temporaryRoot, 'self')
    cpSync(THEME_FIXTURE, talk, { recursive: true })
    mkdirSync(path.join(talk, 'pages'), { recursive: true })
    writeFileSync(path.join(talk, 'slides.md'), '---\ntheme: none\n---\n\n---\nsrc: ./pages/cover.md\n---\n', 'utf8')
    writeFileSync(path.join(talk, 'pages', 'cover.md'), INITIAL_PAGES[0]?.[1] ?? '', 'utf8')
    const dependencies = quietDependencies()
    await expect(runSlideLintDirectly(talk, dependencies)).rejects.toThrow('it is a theme dir')
  })
})

describe('executeSlideLint', () => {
  it('clean な talk-dir は slide.lint.done に件数を載せる', async () => {
    await explains('`executeSlideLint` の成功時の結果のテストです。違反のない talk-dir の場合は、`slide.lint.done` のイベントへ lint したファイルの数が含まれ、エラーが 0 件であることを確認します。')
    const talk = await setupTalkDirectory()

    const { data } = await executeSlideLint({ dir: talk }, quietDependencies())

    expect(data).toMatchObject({ event: 'slide.lint.done', dir: talk, outcome: 'clean', lintedFileCount: 5, errorCount: 0 })
  })

  it('違反ありは slide.lint.violations に違反の一覧を載せる', async (context) => {
    await verifies(context, 'PV-SLIDE-LINT-01')
    await explains('`executeSlideLint` の違反の報告のテストです。存在しないページの参照と、番号つきのページ名を含む talk-dir の場合に、`slide.lint.violations` のイベントへ違反の一覧を出力し、ファイルは変更しないことを確認します。')
    await verifies(context, 'PV-SLIDE-LINT-04')
    const talk = await setupTalkDirectory()
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')
    writeFileSync(path.join(talk, 'pages', '01-prefixed.md'), '---\nlayout: plain\nheading: 見出し\n---\n', 'utf8')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/01-prefixed.md\n---\n', 'utf8')
    const before = snapshotFiles(talk)

    const { data } = await executeSlideLint({ dir: talk }, quietDependencies())

    expect(snapshotFiles(talk)).toStrictEqual(before)
    // eslint-disable-next-line no-restricted-syntax -- data の violations を検証用に narrowing
    const violations = data['violations'] as readonly { rule: string, file: string }[]
    expect(data).toMatchObject({ event: 'slide.lint.violations', outcome: 'violations', lintedFileCount: 6 })
    expect(violations.map(v => v.rule)).toContain('slidev-pages-lint/no-missing-page')
    expect(violations.find(v => v.rule === 'slidev-pages-lint/no-missing-page')?.file).toBe('slides.md')
  })

  it('本文とノートの違反をファイル行付きで slide.lint.violations に載せる', async () => {
    await explains('`executeSlideLint` の本文とノートの検証のテストです。本文とスピーカーノートに文面の規則へ違反する文がある場合は、`slide.lint.violations` のイベントへファイルの行番号つきで違反を出力することを確認します。')
    const talk = await setupTalkDirectory()
    addBodyNotePage(talk)

    const { data } = await executeSlideLint({ dir: talk }, quietDependencies())

    // eslint-disable-next-line no-restricted-syntax -- data の violations を検証用に narrowing
    const violations = data['violations'] as readonly { rule: string, line: number, message: string }[]
    expect(data['event']).toBe('slide.lint.violations')
    const body = violations.filter(v => v.rule === 'text-constraints/textlint-body')
    expect(body.map(v => v.line)).toStrictEqual([6, 9])
    expect(body[0]?.message).toMatch(/^body L6: /)
    expect(body[1]?.message).toMatch(/^speaker notes L9: /)
  })

  it('相対の dir は relative-dir の失敗になる', async () => {
    await explains('`executeSlideLint` の `dir` の検証のテストです。相対パスの `dir` を指定した場合に、例外が発生し、理由が `relative-dir` になることを確認します。')
    const error = await rejectionOf(executeSlideLint(
      { dir: 'relative/talk' },
      quietDependencies(),
    ))

    expect(slideLintErrorToReason(error)).toBe('relative-dir')
  })

  it('slides.md が無い dir は not-talk-dir の失敗になり、eslint を起動しない', async (context) => {
    await verifies(context, 'PV-SLIDE-LINT-05')
    await explains('`executeSlideLint` の `dir` の検証のテストです。`slides.md` が存在しないディレクトリを指定した場合に、理由が `not-talk-dir` の例外が発生し、eslint を起動しないことを確認します。')
    const eslint = countingEslint()

    const error = await rejectionOf(executeSlideLint(
      { dir: state.temporaryRoot },
      { ...quietDependencies(), eslint: eslint.runner },
    ))

    expect(slideLintErrorToReason(error)).toBe('not-talk-dir')
    expect(error instanceof Error ? error.message : '').toContain('slides.md')
    expect(eslint.calls()).toBe(0)
  })
})

describe('create / sync 末尾の自動 deck lint', () => {
  it('slide_create は slide.create.done に lint 要約を載せる', async (context) => {
    await verifies(context, 'PV-SLIDE-CREATE-03')
    await explains('`executeSlideCreate` の自動の lint のテストです。生成が成功した場合は、`slide.create.done` のイベントの `lint` へ、lint を実行した結果の要約が含まれることを確認します。')
    const projectDirectory = path.join(state.temporaryRoot, 'auto-create-json')

    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: copyThemeForTalk(state.temporaryRoot, 'theme-src').spec, force: false },
      { ...quietDependencies(), now: () => 0 },
    )

    expect(data['event']).toBe('slide.create.done')
    expect(data['lint']).toMatchObject({ skipped: false, outcome: 'clean', lintedFileCount: 4 })
  })

  it('slide_create は生成直後の lint が違反を見つけても成功を返し、data.lint に違反を載せる', async (context) => {
    await verifies(context, 'PV-SLIDE-CREATE-04')
    await explains('`executeSlideCreate` の自動の lint の違反のテストです。生成直後の lint が違反を検出した場合でも、生成は成功し、`data.lint` へ違反が含まれることを確認します。')
    const projectDirectory = path.join(state.temporaryRoot, 'auto-create-violations')
    const theme = copyThemeForTalk(state.temporaryRoot, 'theme-violating')
    // 初期ページの元の example へ、references の外のプロパティを足す。
    const coverReference = path.join(theme.directory, 'references', 'cover.yaml')
    writeFileSync(
      coverReference,
      readFileSync(coverReference, 'utf8').replace('heading: 発表タイトル', 'heading: 発表タイトル\n      not_a_prop: x'),
      'utf8',
    )

    const { data } = await executeSlideCreate(
      projectDirectory,
      { theme: theme.spec, force: false },
      { ...quietDependencies(), now: () => 0 },
    )

    // eslint-disable-next-line no-restricted-syntax -- data の narrowing
    const { event, lint } = data as { event: string, lint: { skipped: boolean, outcome: string, violations: { rule: string }[] } }
    expect(event).toBe('slide.create.done')
    expect(lint.skipped).toBe(false)
    expect(lint.outcome).toBe('violations')
    expect(lint.violations.map(v => v.rule)).toContain('slidev-pages-lint/no-unknown-props')
    expect(existsSync(path.join(projectDirectory, 'slides.md'))).toBe(true)
  })

  it('slide_sync は同期の後の deck lint の結果を data.lint に載せ、違反があっても成功する', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-06')
    await explains('`executeSlideSync` の自動の lint のテストです。同期の後の lint が違反を検出した場合でも、同期は成功し、`data.lint` へ違反を含む結果が出力されることを確認します。')
    const talk = await setupTalkDirectory('auto-sync-json')
    appendFileSync(slidesPathOf(talk), '\n---\nsrc: ./pages/__ghost.md\n---\n', 'utf8')

    // ensureThemeLinked を差し替えているため、張り直しだけの nodeModulesOnly で自動 lint を確かめる。
    const { data } = await executeSlideSync({ dir: talk, nodeModulesOnly: true }, syncDependencies(talk, makeStream(), makeStream()))

    // eslint-disable-next-line no-restricted-syntax -- data の narrowing
    const { event, lint } = data as {
      event: string
      lint: { skipped: boolean, outcome: string, lintedFileCount: number, violations: { rule: string }[] }
    }
    expect(event).toBe('slide.sync.done')
    expect(lint.skipped).toBe(false)
    expect(lint.outcome).toBe('violations')
    expect(lint.lintedFileCount).toBe(5)
    expect(lint.violations.map(v => v.rule)).toContain('slidev-pages-lint/no-missing-page')
  })

  it('slide_sync の nodeModulesOnly でも deck lint の要約を載せる', async (context) => {
    await verifies(context, 'PV-SLIDE-SYNC-06')
    await explains('`executeSlideSync` の自動の lint のテストです。`nodeModulesOnly` を指定した場合でも、`data.lint` へ lint の要約が含まれることを確認します。')
    const talk = await setupTalkDirectory('auto-sync-nm')

    const { data } = await executeSlideSync({ dir: talk, nodeModulesOnly: true }, syncDependencies(talk, makeStream(), makeStream()))

    expect(data['lint']).toMatchObject({ skipped: false, outcome: 'clean' })
  })

  it('deck lint が実行できなくても sync は成功し、data.lint は skipped になる', async () => {
    await explains('`executeSlideSync` の自動の lint の失敗のテストです。lint を実行できない場合でも、同期は成功し、`data.lint` が `skipped` になることを確認します。')
    const talk = await setupTalkDirectory('auto-sync-lint-broken')
    // eslint 資材を持たない plugin root。node_modules だけ用意して symlink の張り替えは通し、
    // deck lint 側だけ失敗する状況にする。
    const brokenRoot = path.join(state.temporaryRoot, 'broken-plugin-root')
    seedDependencyRoot(brokenRoot)

    const { data } = await executeSlideSync(
      { dir: talk, nodeModulesOnly: true },
      syncDependencies(talk, makeStream(), makeStream(), brokenRoot),
    )

    expect(data['event']).toBe('slide.sync.done')
    expect(data['lint']).toMatchObject({ skipped: true })
  })

  it('template が解決できない場合は例外を投げず、report に失敗を畳む', async () => {
    await explains('`runAutoDeckLint` の失敗のテストです。lint の資材を解決できない場合に、例外が発生せず、結果に失敗が含まれ、`skipped` が `true` になることを確認します。')
    const talk = await setupTalkDirectory('auto-lint-skip')
    // eslint 資材を持たない plugin root を渡し、自動 lint だけが失敗する状況を作る。
    const brokenDependencies = quietDependencies()
    const report = await runAutoDeckLint(talk, { ...brokenDependencies, pluginRoot: path.join(state.temporaryRoot, 'no-such-plugin-root') })

    expect(report.summary).toBeUndefined()
    expect(report.failure).toBeTruthy()
    expect(autoDeckLintJsonField(report)).toMatchObject({ skipped: true })
  })
})

describe('slideLintDefaultDependencies', () => {
  it('CLAUDE_PLUGIN_ROOT があっても読まず、pluginRoot をサーバ自身の置き場所から求める', async () => {
    await explains('`slideLintDefaultDependencies` の `pluginRoot` のテストです。環境変数 `CLAUDE_PLUGIN_ROOT` を設定していても、`pluginRoot` はサーバ自身の置き場所から求めた値になることを確認します。')
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/plugins/installed/pecot-visual')
    try {
      expect(slideLintDefaultDependencies().pluginRoot).toBe(resolvePluginRoot())
    }
    finally {
      vi.unstubAllEnvs()
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

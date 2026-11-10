// slide-create / slide-sync コマンドで使う filesystem 操作。
// create が使うのは、public/slides の初期化、node_modules の組み立て、vite.config.ts と start.mjs の生成。
// sync が使うのは、移行で消すテンプレート由来の名前 (removeTemplateEntries) と、同じ node_modules の組み立てと生成ファイル。
//
// CLI 引数由来の path を扱うため、本ファイル全体で security/detect-non-literal-fs-filename を disable する。
// 同コマンドが出力ディレクトリを生成する責務を持つ。
/* eslint-disable security/detect-non-literal-fs-filename */

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { isRecord } from '../../domain/_shared/json.js'
import { START_SCRIPT_SOURCE, viteConfigSource } from '../../domain/slidev-project/generated-files.js'
import type { ViteConfigOptions } from '../../domain/slidev-project/generated-files.js'
import type { NodeModulesThemeLink } from '../../domain/slidev-project/sync.js'
import { SlideCreateRuntimeError } from '../../domain/slidev-project/errors.js'
import { DEPENDENCY_RECOVERY_HINT, resolveTalkDirectoryNodeModules } from '../_shared/dependency-root.js'

/**
destinationDirectory 直下に `public/slides/{images,diagrams,html}` を作る。
`public/assets` は作らない。テーマの assets は、テーマのパッケージから配る。
*/
export async function setupPublicSlides(destinationDirectory: string): Promise<void> {
  const slidesDirectory = path.join(destinationDirectory, 'public', 'slides')
  await mkdir(slidesDirectory, { recursive: true })
  await mkdir(path.join(slidesDirectory, 'images'), { recursive: true })
  await mkdir(path.join(slidesDirectory, 'diagrams'), { recursive: true })
  await mkdir(path.join(slidesDirectory, 'html'), { recursive: true })
}

/**
項目の張り元になる node_modules。どの依存ルートにも無ければ理由付きで中止する。

以前は `pluginRoot/node_modules` を直に `realpath` していた。
そのため実体が無い単体配布では、ENOENT がそのまま伝播して、「何を取得すればよいか」が分からなかった。
*/
function requireDependencyNodeModules(dependencyRoot: string): string {
  const resolved = resolveTalkDirectoryNodeModules(dependencyRoot)
  if (resolved === undefined) {
    throw new SlideCreateRuntimeError(
      `runtime dependencies node_modules not found (searched: ${dependencyRoot}); ${DEPENDENCY_RECOVERY_HINT}`,
      'symlink-failed',
    )
  }
  return resolved
}

/**
依存ルートに node_modules の実体があることを確かめる。無ければ理由付きで中止する。
生成先に触れる前の確認に使う。後ろに置くと、既存の生成先を外した後で失敗する。
*/
export function assertDependencyRootAvailable(dependencyRoot: string): void {
  requireDependencyNodeModules(dependencyRoot)
}

/**
symlink の張り先にする node_modules の物理パス。

通常は `realpath` で解決する。
依存ルートが symlink（`${データ置き場}/runtime/current`）のときは、その親（`runtime`）までを解決する。
`current/node_modules` は、そのまま残す。
`current` はハッシュ別ディレクトリへ向き直る。
ハッシュ名まで解決して埋め込むと、世代削除（直近 2 世代だけを残す）でデッキの node_modules が切れる。
*/
async function physicalNodeModulesTarget(nodeModules: string): Promise<string> {
  const dependencyRoot = path.dirname(nodeModules)
  const rootStat = await lstat(dependencyRoot)
  if (!rootStat.isSymbolicLink()) return await realpath(nodeModules)
  const physicalParent = await realpath(path.dirname(dependencyRoot))
  return path.join(physicalParent, path.basename(dependencyRoot), path.basename(nodeModules))
}

/**
移行で消す、テンプレート由来の名前。talk-dir からの相対パスで、`/` 区切り。
- root のディレクトリと設定ファイル、整形の設定と lock。
- `pages/_references`（レイアウトの参照）と `public/assets`（テーマが配る assets の写し）。
残すのは、作品（`slides.md`・`pages/*.md`・`public/slides/`）、生成物（`pptx/` など）、`.gitignore`、`node_modules`。
create は `.gitignore` を書かないので、消すと node_modules と pptx が利用者の git に出る。
*/
const TEMPLATE_ENTRIES: readonly string[] = [
  'components',
  'composables',
  'layouts',
  'setup',
  'styles',
  'utils',
  'scripts',
  'patches',
  'html-base',
  '.vite',
  'global-bottom.vue',
  'eslint.config.js',
  'deck-lint.config.js',
  '.npmrc',
  '.prettierrc.json',
  '.prettierignore',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pages/_references',
  'public/assets',
]

/**
`TEMPLATE_ENTRIES` のうち talk-dir にあるものを消し、消した名前を返す。
入れ子の名前は、親が talk-dir の中の実ディレクトリのときだけ消す。
親が symlink だと、talk-dir の外のファイルを消しかねない。
名前そのものが symlink なら、リンクだけを消す。向き先は消さない。
*/
export async function removeTemplateEntries(talkDirectory: string): Promise<readonly string[]> {
  const removed: string[] = []
  for (const entry of TEMPLATE_ENTRIES) {
    const segments = entry.split('/')
    const parent = path.join(talkDirectory, ...segments.slice(0, -1))
    if (segments.length > 1) {
      const parentStat = await lstatIfExists(parent)
      if (!parentStat?.isDirectory()) continue
    }
    const target = path.join(talkDirectory, ...segments)
    if (await lstatIfExists(target) === undefined) continue
    await rm(target, { recursive: true, force: true })
    removed.push(entry)
  }
  return removed
}

/**
`talkDirectory/vite.config.ts` と `start.mjs` を本体の生成物で書く。
テンプレートからは複写しない（`GENERATED_FILES`）。create は組み立て中の dir に書く。
移行済みの talk-dir は `syncGeneratedFiles` で、違うときだけ書き直す。
`start.mjs` は、テンプレートのときと同じく実行権限を付ける。
*/
export async function writeGeneratedFiles(
  talkDirectory: string,
  options: Readonly<ViteConfigOptions>,
): Promise<void> {
  await writeFile(path.join(talkDirectory, 'vite.config.ts'), viteConfigSource(options), 'utf8')
  const startScript = path.join(talkDirectory, 'start.mjs')
  await writeFile(startScript, START_SCRIPT_SOURCE, 'utf8')
  await chmod(startScript, 0o755)
}

/**
`vite.config.ts` と `start.mjs` を本体の今の内容にそろえる。違うファイルだけを書き直し、書いたファイル名を返す。
同じ内容なら書かない。Slidev は `vite.config.ts` の変更で dev サーバを再起動するため、無用な書き直しは再起動を起こす。
比べる前に CRLF を LF にそろえる。書くときは一時ファイルに書いて rename し、読み手に書きかけを見せない。
`start.mjs` には、書くたびに実行権限を付ける。
*/
export async function syncGeneratedFiles(
  talkDirectory: string,
  options: Readonly<ViteConfigOptions>,
): Promise<readonly string[]> {
  const expected: readonly (readonly [string, string, number | undefined])[] = [
    ['vite.config.ts', viteConfigSource(options), undefined],
    ['start.mjs', START_SCRIPT_SOURCE, 0o755],
  ]
  const written: string[] = []
  for (const [name, source, mode] of expected) {
    const target = path.join(talkDirectory, name)
    let current: string | undefined
    try {
      const text = await readFile(target, 'utf8')
      current = text.replaceAll('\r\n', '\n')
    }
    catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
    if (current === source) continue
    const temporary = `${target}.tmp-${randomSuffix()}`
    try {
      await writeFile(temporary, source, 'utf8')
      if (mode !== undefined) await chmod(temporary, mode)
      await rename(temporary, target)
    }
    catch (error: unknown) {
      await rm(temporary, { force: true })
      throw error
    }
    written.push(name)
  }
  return written
}

// 張り直しの印。世代交代やテーマの変更を、後から比べるために書く。
const LINK_MARK_FILE = '.pecotv-link.json'
const NODE_MODULES_NAME = 'node_modules'
// 組み立て中と入れ替え前の名前の接頭辞。talk-dir 直下に置く。
const TEMPORARY_INFIX = '.tmp-'
const OLD_INFIX = '.old-'

export interface LinkedRuntime {
  readonly kind: 'generation' | 'path'
  readonly value: string
}

export interface NodeModulesLinkResult {
  /**
  項目の張り元になった依存ルートの node_modules。`runtime/current` は解決せずに残す。
  */
  readonly nodeModulesTarget: string
  /**
  talk-dir の node_modules 直下に並んだ項目の数。印のファイルは数えない。
  */
  readonly entries: number
}

/**
talkDirectory の node_modules を、実ディレクトリと項目ごとの相対 symlink で組み立てる。

依存ルートの `node_modules` の各項目を、そのまま 1 本ずつ張る。
`@scope` と `.bin` も 1 本で張る。
`.` 始まりの項目は `.bin` だけ張る（`.pnpm`、`.modules.yaml`、`.vite` は張らない）。
テーマは `name` の項目を `directory` へ張り、依存ルートの同名の項目より優先する。
scope 付きの名前は、その scope だけ実ディレクトリにして、配下を 1 本ずつ張る。

張り先は物理パス基準にする。
依存ルートが `runtime/current` のときだけ、`current` を解決せずに残す（`physicalNodeModulesTarget`）。
ハッシュ名まで解決すると、世代削除でリンクが切れる。
絶対パスを埋め込むと、container 内パスが host 側では dangling になる。必ず相対パスで張る。

既存の node_modules は、組み立てを終えてから入れ替える。
組み立ては talk-dir 直下の `node_modules.tmp-<乱数>` で行い、印まで書く。
入れ替えは、既存を `node_modules.old-<乱数>` へ移し、組み立てたものを `node_modules` へ移す順で行う。
そのため、実行中の dev サーバから見て node_modules が無い時間は、移す 2 回の間だけになる。
組み立てに失敗したら、組み立て中のものだけを消し、既存の node_modules を残す。
入れ替えで外した旧い node_modules は、symlink なら張り先を消さずに外し、実ディレクトリなら中身ごと消す。
前回の異常終了で残った `node_modules.tmp-*` と `node_modules.old-*` は、次の張り直しの最初に消す。
旧形（symlink 1 本）からの移行にも、繰り返しの実行にも使える。
*/
export async function linkNodeModules(
  talkDirectory: string,
  dependencyRoot: string,
  themes: readonly NodeModulesThemeLink[],
): Promise<NodeModulesLinkResult> {
  const dependencyNodeModules = requireDependencyNodeModules(dependencyRoot)
  const physicalNodeModules = await physicalNodeModulesTarget(dependencyNodeModules)
  const links = await plannedLinks(physicalNodeModules, themes)
  const runtime = await linkedRuntime(path.dirname(dependencyNodeModules), physicalNodeModules)

  const physicalTalk = await realpath(talkDirectory)
  const nodeModules = path.join(physicalTalk, NODE_MODULES_NAME)
  await removeLeftovers(physicalTalk)
  const assembling = await mkdtemp(path.join(physicalTalk, `${NODE_MODULES_NAME}${TEMPORARY_INFIX}`))
  try {
    await assembleNodeModules(assembling, nodeModules, links, runtime, themes)
  }
  catch (error: unknown) {
    await rm(assembling, { recursive: true, force: true })
    throw error
  }
  await swapNodeModules(assembling, nodeModules)

  const topLevelNames = new Set<string>()
  for (const name of links.keys()) topLevelNames.add(name.split('/', 1)[0] ?? name)
  return { nodeModulesTarget: physicalNodeModules, entries: topLevelNames.size }
}

/**
`assembling` の中に、項目ごとの symlink と印を作る。
相対 symlink の基準は、最終の置き場所（`nodeModules`）の位置にする。
`assembling` と `nodeModules` は同じ親の直下で、深さが同じになる。
*/
async function assembleNodeModules(
  assembling: string,
  nodeModules: string,
  links: ReadonlyMap<string, string>,
  runtime: LinkedRuntime,
  themes: readonly NodeModulesThemeLink[],
): Promise<void> {
  for (const [name, target] of links) {
    const linkPath = path.join(assembling, name)
    const finalDirectory = path.dirname(path.join(nodeModules, name))
    await mkdir(path.dirname(linkPath), { recursive: true })
    await symlink(path.relative(finalDirectory, target), linkPath, 'dir')
  }
  const mark = {
    runtime,
    themes: themes.map(theme => ({ name: theme.name, directory: theme.directory })),
  }
  await writeFile(path.join(assembling, LINK_MARK_FILE), `${JSON.stringify(mark, undefined, 2)}\n`, 'utf8')
}

function isLinkedRuntime(value: unknown): value is LinkedRuntime {
  return isRecord(value)
    && (value['kind'] === 'generation' || value['kind'] === 'path')
    && typeof value['value'] === 'string'
}

interface LinkMark {
  readonly runtime: LinkedRuntime
  readonly themes: readonly NodeModulesThemeLink[]
}

/**
node_modules の印を読む。無い・読めない・形が違うときは undefined。
node_modules が旧形の symlink 1 本のとき、張り先が消えた symlink のときも undefined。
*/
async function readLinkMark(nodeModules: string): Promise<LinkMark | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path.join(nodeModules, LINK_MARK_FILE), 'utf8'))
  }
  catch {
    return undefined
  }
  if (!isRecord(raw) || !isLinkedRuntime(raw['runtime']) || !Array.isArray(raw['themes'])) return undefined
  const entries: readonly unknown[] = raw['themes']
  const themes: NodeModulesThemeLink[] = []
  for (const theme of entries) {
    if (!isRecord(theme) || typeof theme['name'] !== 'string' || typeof theme['directory'] !== 'string') return undefined
    themes.push({ name: theme['name'], directory: theme['directory'] })
  }
  return { runtime: raw['runtime'], themes }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await realpath(target)
  }
  catch {
    return target
  }
}

/**
talkDirectory の node_modules が、今の依存ルートとテーマで張られたままかを返す。

印の `runtime`（依存ルートの世代、または物理パス）と `themes[].directory` を今の値と比べる。
比較はどちらも realpath に正規化してから行う。
印が無い・読めない・旧形の symlink 1 本・張り先が消えた symlink は「違う」とする。
テーマの項目が node_modules から消えていたときも「違う」とする。
読むだけで、何も書かない。
*/
export async function isNodeModulesLinkCurrent(
  talkDirectory: string,
  dependencyRoot: string,
  themes: readonly NodeModulesThemeLink[],
): Promise<boolean> {
  const nodeModules = path.join(await realpath(talkDirectory), NODE_MODULES_NAME)
  const mark = await readLinkMark(nodeModules)
  if (mark === undefined) return false

  const dependencyNodeModules = requireDependencyNodeModules(dependencyRoot)
  const physical = await physicalNodeModulesTarget(dependencyNodeModules)
  const runtime = await linkedRuntime(path.dirname(dependencyNodeModules), physical)
  const isSameRuntimeLinked = await isSameRuntime(mark.runtime, runtime)
  if (!isSameRuntimeLinked || mark.themes.length !== themes.length) return false

  for (const theme of themes) {
    if (!(await isThemeStillLinked(nodeModules, mark.themes, theme))) return false
  }
  return true
}

async function normalizedRuntimeValue(runtime: Readonly<LinkedRuntime>): Promise<string> {
  return runtime.kind === 'path' ? await realpathOrSelf(runtime.value) : runtime.value
}

async function isSameRuntime(marked: Readonly<LinkedRuntime>, current: Readonly<LinkedRuntime>): Promise<boolean> {
  return marked.kind === current.kind && (await normalizedRuntimeValue(marked)) === (await normalizedRuntimeValue(current))
}

/**
印にテーマが同じ directory で載っていて、node_modules の項目が今も解決できるか。
*/
async function isThemeStillLinked(
  nodeModules: string,
  marked: readonly NodeModulesThemeLink[],
  theme: Readonly<NodeModulesThemeLink>,
): Promise<boolean> {
  const entry = marked.find(candidate => candidate.name === theme.name)
  const isSameDirectory = entry !== undefined
    && (await realpathOrSelf(entry.directory)) === (await realpathOrSelf(theme.directory))
  if (!isSameDirectory) return false
  // 項目そのものが消えている、または張り先が消えている。
  try {
    await stat(path.join(nodeModules, theme.name))
    return true
  }
  catch {
    return false
  }
}

/**
組み立てた node_modules を最終の位置へ入れ替える。
既存があれば先に別名へ移し、入れ替えたあとで消す。
*/
async function swapNodeModules(assembling: string, nodeModules: string): Promise<void> {
  const existing = await lstatIfExists(nodeModules)
  if (existing === undefined) {
    await rename(assembling, nodeModules)
    return
  }
  const old = `${nodeModules}${OLD_INFIX}${randomSuffix()}`
  await rename(nodeModules, old)
  await rename(assembling, nodeModules)
  await removeNodeModules(old)
}

/**
前回の異常終了で残った、組み立て中と入れ替え前の node_modules を消す。
*/
async function removeLeftovers(physicalTalk: string): Promise<void> {
  const entries = await readdir(physicalTalk)
  for (const entry of entries) {
    if (entry.startsWith(`${NODE_MODULES_NAME}${TEMPORARY_INFIX}`) || entry.startsWith(`${NODE_MODULES_NAME}${OLD_INFIX}`)) {
      await removeNodeModules(path.join(physicalTalk, entry))
    }
  }
}

function randomSuffix(): string {
  return randomBytes(6).toString('hex')
}

/**
張る項目の一覧。キーは node_modules からの相対名、値は張り先の絶対パス。
先に依存ルートの項目を並べ、後からテーマで上書きする。
*/
async function plannedLinks(
  physicalNodeModules: string,
  themes: readonly NodeModulesThemeLink[],
): Promise<Map<string, string>> {
  const links = new Map<string, string>()
  const entries = await readdir(physicalNodeModules)
  for (const entry of entries) {
    if (entry !== '.bin' && entry.startsWith('.')) continue
    links.set(entry, path.join(physicalNodeModules, entry))
  }
  for (const theme of themes) {
    const directory = await realpath(theme.directory)
    const scope = theme.name.startsWith('@') ? theme.name.split('/', 1)[0] : undefined
    if (scope !== undefined && links.get(scope) === path.join(physicalNodeModules, scope)) {
      // scope を 1 本で張っていると、テーマの項目を足せない。配下を 1 本ずつに開く。
      links.delete(scope)
      const children = await readdir(path.join(physicalNodeModules, scope))
      for (const child of children) {
        links.set(`${scope}/${child}`, path.join(physicalNodeModules, scope, child))
      }
    }
    links.set(theme.name, directory)
  }
  return links
}

/**
印に書く依存ルートの識別。
`runtime/current` なら向き先の世代名（`generation`）、そうでなければ node_modules の物理パス（`path`）。
*/
async function linkedRuntime(resolvedRoot: string, physicalNodeModules: string): Promise<LinkedRuntime> {
  const info = await lstat(resolvedRoot)
  return info.isSymbolicLink()
    ? { kind: 'generation', value: path.basename(await readlink(resolvedRoot)) }
    : { kind: 'path', value: physicalNodeModules }
}

/**
node_modules を外す。symlink は張り先を残して外し、それ以外は中身ごと消す。
*/
async function removeNodeModules(target: string): Promise<void> {
  const existing = await lstatIfExists(target)
  if (existing === undefined) return
  if (existing.isSymbolicLink()) await unlink(target)
  else await rm(target, { recursive: true, force: true })
}

async function lstatIfExists(target: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(target)
  }
  catch (error: unknown) {
    /* c8 ignore start -- ENOENT 以外で lstat が失敗するのは EACCES 等の防御網 */
    if (!isNotFound(error)) {
      throw new SlideCreateRuntimeError(
        `lstat of node_modules failed: ${formatError(error)}`,
        'symlink-failed',
      )
    }
    /* c8 ignore stop */
    return undefined
  }
}

/**
talk-dir 候補ディレクトリの存在 / type を返す。`assertTalkDirectory` 専用 helper。
*/
export async function talkDirectoryExists(
  talkDirectory: string,
): Promise<{ readonly exists: boolean, readonly isDirectory: boolean }> {
  try {
    const info = await stat(talkDirectory)
    return { exists: true, isDirectory: info.isDirectory() }
  }
  catch (error: unknown) {
    /* c8 ignore start -- ENOENT 以外で stat が失敗するのは EACCES 等の防御網 */
    if (!isNotFound(error)) {
      throw new SlideCreateRuntimeError(
        `checking the talk-dir failed: ${formatError(error)}`,
        'copy-failed',
      )
    }
    /* c8 ignore stop */
    return { exists: false, isDirectory: false }
  }
}

/**
talk-dir マーカーである `slides.md` の存在判定。誤って ~/Documents 等に sync を撒かない
よう、sync は slides.md の存在を必須とする。
*/
export async function hasSlidesMd(talkDirectory: string): Promise<boolean> {
  try {
    await stat(path.join(talkDirectory, 'slides.md'))
    return true
  }
  catch (error: unknown) {
    /* c8 ignore start -- ENOENT 以外で stat が失敗するのは EACCES 等の防御網 */
    if (!isNotFound(error)) {
      throw new SlideCreateRuntimeError(
        `checking slides.md failed: ${formatError(error)}`,
        'copy-failed',
      )
    }
    /* c8 ignore stop */
    return false
  }
}

/**
`pages/` 配下で「symlink かつ解決先がディレクトリ」のエントリを talk-dir 相対パスで列挙する。

eslint の glob walk は、dirent の `isDirectory()` で再帰先を決める。
そのため symlink の dir は、物理パスで `--dir` を指定しても辿られない。
配下の `*.md` が 1 件も lint されないまま、clean / exit 0 で通過する。
この状況を警告するための、検出専用 helper。
lint の成否（outcome / exit code）には関与しない。

walk 中に出会った symlink dir の配下は辿らない。
eslint も辿らないため、警告は symlink dir 1 件につき 1 行で足りる。
glob の起点そのものが symlink の場合は eslint が辿るので、取りこぼしにならない。
配下に md があるかは辿らないため判定できない。
そこで symlink dir は、無条件で報告する保守側の選択を採る。
空 dir、`pages/_references` のような md 非対象、解決先が talk-dir 内の物理領域で別の道筋から lint 済みのもの、のいずれでも報告される。

symlink→ファイル（ページファイル自体が symlink）と dangling symlink は報告しない。
前者は eslint が実際に lint する。これは回帰テストで固定している。
後者は解決先が無く、lint 対象そのものが存在しない。
そのため、いずれも取りこぼしにならない。
`pages/` 不在時は空配列を返す。
*/
export async function listSkippedSymlinkPageDirectories(
  talkDirectory: string,
): Promise<readonly string[]> {
  const found: string[] = []
  await collectSymlinkedDirectories(path.join(talkDirectory, 'pages'), talkDirectory, found)
  return found
}

async function collectSymlinkedDirectories(
  directory: string,
  talkDirectory: string,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 再帰で積む accumulator
  found: string[],
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error: unknown) {
    /* c8 ignore start -- ENOENT 以外で readdir が失敗するのは EACCES 等の防御網 */
    if (!isNotFound(error)) {
      throw new SlideCreateRuntimeError(
        `scanning under pages failed: ${formatError(error)}`,
        'copy-failed',
      )
    }
    /* c8 ignore stop */
    return
  }

  // readdir の返却順は filesystem 依存。警告行の並びを決定論にするため、名前順に固定する。
  const sorted = entries.toSorted((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    const absolute = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      if (await isDirectoryTarget(absolute)) {
        found.push(path.relative(talkDirectory, absolute))
      }
      continue
    }
    if (entry.isDirectory()) {
      await collectSymlinkedDirectories(absolute, talkDirectory, found)
    }
  }
}

async function isDirectoryTarget(target: string): Promise<boolean> {
  try {
    const info = await stat(target)
    return info.isDirectory()
  }
  catch (error: unknown) {
    /* c8 ignore start -- ENOENT 以外で stat が失敗するのは EACCES 等の防御網 */
    if (!isNotFound(error)) {
      throw new SlideCreateRuntimeError(
        `resolving symlinks under pages failed: ${formatError(error)}`,
        'copy-failed',
      )
    }
    /* c8 ignore stop */
    // dangling symlink。lint 対象が消えるわけではないので報告しない。
    return false
  }
}

function isNotFound(error: unknown): boolean {
  /* c8 ignore start -- node:fs の例外は常に Error オブジェクトに code を持つ。防御網。 */
  const hasCode = typeof error === 'object' && error !== null && 'code' in error
  /* c8 ignore stop */
  return hasCode && error.code === 'ENOENT'
}

/* c8 ignore start -- 非 Error 例外 (string throw 等) は本実装範囲では未発生、防御網のみ */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* c8 ignore stop */

// Playwright Chromium が起動するのに要る OS の共有ライブラリの確認と導入 (#1217)。
//
// Chromium の実行ファイルは `playwright install chromium` で取得できるが、それが読み込む
// libatk / libpango 等の OS ライブラリは入らない。利用環境に無ければ drawio export / url の
// PNG 出力と slide convert が起動時に失敗する。利用者に手作業をさせないため、bootstrap と
// MCP の `setup` ツールがここを通り、足りなければ自分で入れる。
//
// 入れるのは共有ライブラリだけにする。
// `playwright install-deps` は、フォント (fonts-wqy-zenhei 等) と headed 用の X サーバ (xvfb 等) も入れる。
// フォントは Chromium の日本語の fallback を変え、PPTX / PNG の見た目を変える。
// X サーバは headless では使わない。
// そのため install-deps には不足パッケージの割り出し (--dry-run) だけを任せ、導入は apt-get で絞って行う。
// 絞るのはパッケージ名でだけで、除いたパッケージの推移依存 (libxfont2 / xkb-data 等) は、
// dry-run の一覧に載っていれば入る。
// 依存閉包で正確に除こうとすると、Chromium 側にも要るライブラリを落として、起動できなくなる恐れがある。
// 推移依存は小さな共有ライブラリとデータで、描画を変えない (フォント本体は --no-install-recommends で入らない)。
// このため、名前での除外に留める。
//
// root 権限が無い環境では、OS ライブラリはどの手段でも入れられない。
// その場合だけ、足りないライブラリと入れるコマンドをそのまま案内する。

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import { stateFileDirectory } from '../_shared/dependency-root.js'
import { spawnPromise } from '../_shared/process.js'
import { resolvePlaywrightCli } from './chromium.js'

/**
apt-get update / install の上限時間 (ms)。パッケージ 15 個前後の取得と展開に十分な値。
*/
const APT_TIMEOUT_MS = 600_000

/**
sudo -n / dry-run 等の短い子プロセスの上限時間 (ms)。
*/
const SHORT_TIMEOUT_MS = 60_000

/**
apt-get が dpkg / apt のロックを待つ秒数。並行起動した apt-get (unattended-upgrades 等) に
即失敗せず、APT_TIMEOUT_MS に収まる範囲で待つ。update と install のそれぞれに付ける。
*/
const APT_LOCK_TIMEOUT_SECONDS = 120

/**
確認の結果を記録する印のファイル名。`${データ置き場}/runtime` 直下（bin/pecotv と同じ場所）に置く。
実行用ミラーを経ない形態（開発・単体配布）では、従来どおり依存ルートの node_modules 直下。

中身は 1 行 `<chromium のリビジョン> <ok|missing|launch-failed> <記録時の epoch 秒>`。
bin/pecotv は、リビジョンが一致し、かつ ok か (失敗系なら) 記録から 1 日以内であれば
確認を飛ばす。リビジョンを含めるので、Playwright を上げて Chromium が変わったときは
改めて確認が動く。失敗も記録するのは、確認に通らない環境で起動のたびに確認と警告が
動き続けないため。
*/
export const HOST_DEPS_STAMP = '.pecotv-chromium-host-deps'

export type HostDependenciesStampStatus = 'ok' | 'missing' | 'launch-failed'

/**
共有ライブラリではないため入れないパッケージ (フォント・headed 用の X サーバ)。
*/
const EXCLUDED_PACKAGES = new Set(['xvfb', 'xserver-common', 'xauth', 'x11-xkb-utils'])

/**
起動前の依存チェック (Playwright が枠付きで出す) で、ライブラリ名が `libxxx.so.N` で並ぶ形か。
*/
function isSharedLibraryName(line: string): boolean {
  return !/\s/.test(line) && /\.so(?:\.|$)/.test(line)
}

/**
Chromium の起動失敗メッセージから、読み込めなかった共有ライブラリ名を取り出す。

形式は 2 つある。
1 つは、実行ファイルが落ちたときの `error while loading shared libraries: <名前>:`。
もう 1 つは、Playwright が起動前にチェックして投げる枠付きの `Missing libraries:` 以下の `<名前>` の列。
*/
export function missingSharedLibraries(message: string): string[] {
  const libraries = new Set<string>()
  for (const match of message.matchAll(/error while loading shared libraries: ([^:\s]+)/g)) {
    const library = match[1]
    if (library !== undefined) libraries.add(library)
  }
  const lines = message.split('\n').map(line => line.replaceAll('║', '').trim())
  const start = lines.indexOf('Missing libraries:')
  if (start !== -1) {
    const followingLines = lines.slice(start + 1)
    for (const line of followingLines) {
      if (!isSharedLibraryName(line)) break
      libraries.add(line)
    }
  }
  return [...libraries]
}

/**
起動失敗が OS のライブラリ不足によるものか。

ライブラリ名を取り出せなくても、Playwright の起動前チェックが出す `Host system is missing dependencies` は、
ライブラリ不足を指す。
パッケージ名の案内だけで、ライブラリ名の列を含まない形がある。
*/
export function isMissingHostDependencies(message: string): boolean {
  return missingSharedLibraries(message).length > 0 || message.includes('Host system is missing dependencies')
}

/**
`playwright install-deps --dry-run chromium` の出力から、入れるべきパッケージを取り出す。

出力は「Missing system dependencies (N):」の見出しに続けて 1 行 1 パッケージを字下げして
並べる形。フォントと X サーバは除く (冒頭のコメントを参照)。
*/
export function hostPackagesFromDryRun(output: string): string[] {
  const lines = output.split('\n')
  const start = lines.findIndex(line => line.startsWith('Missing system dependencies'))
  if (start === -1) return []
  const packages: string[] = []
  const followingLines = lines.slice(start + 1)
  for (const line of followingLines) {
    const name = line.trim()
    if (name === '' || !/^\s+\S+$/.test(line)) break
    if (name.startsWith('fonts-') || name.startsWith('xfonts-') || EXCLUDED_PACKAGES.has(name)) continue
    packages.push(name)
  }
  return packages
}

/**
利用者へ示す導入コマンド。
*/
export function aptInstallCommand(packages: readonly string[]): string {
  return `sudo apt-get install -y --no-install-recommends ${packages.join(' ')}`
}

export type HostDependenciesOutcome
  /**
  起動できた (導入は不要だった)。
  */
  = | { readonly status: 'ok' }
  /**
  足りなかったライブラリを入れ、起動できるようになった。
  */
    | { readonly status: 'installed', readonly packages: readonly string[] }
  /**
  足りないが入れられなかった。案内を detail に載せる。libraries は名前を取り出せなければ空。
  */
    | {
      readonly status: 'missing'
      readonly libraries: readonly string[]
      readonly packages: readonly string[]
      readonly detail: string
    }
  /**
  起動できないが、原因は OS ライブラリではない (実行ファイル未取得等)。
  */
    | { readonly status: 'launch-failed', readonly detail: string }

export interface HostDependencies {
  readonly platform: NodeJS.Platform
  /**
  root で動いているか。root なら sudo を介さず apt-get を叩く。
  */
  readonly isRoot: boolean
  /**
  headless Chromium を起動して閉じる。起動できなければエラーメッセージを返す。
  */
  readonly probe: () => Promise<string | undefined>
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- signal は mutable 型
  readonly run: (command: string, arguments_: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<SpawnResult>
  readonly playwrightCli: () => string
  readonly nodePath: string
  /**
  確認の結果を記録する (recordHostDependenciesResult)。
  */
  readonly record: (status: HostDependenciesStampStatus) => void
  /**
  apt-get を始める前に、何をなぜ入れるかを利用者へ伝える。数分かかり得るため、通知なしで止まって
  見えないようにする。stdout を JSON-RPC に使う MCP 経由では何も出さない既定のままにする。
  */
  readonly notify: (message: string) => void
}

async function probeLaunch(): Promise<string | undefined> {
  try {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    await browser.close()
    return undefined
  }
  catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function hostDependenciesDefaultDependencies(): HostDependencies {
  return {
    platform: process.platform,
    isRoot: process.getuid?.() === 0,
    probe: probeLaunch,
    run: async (command, arguments_, timeoutMs, signal) => await spawnPromise(command, arguments_, { timeoutMs, signal }),
    playwrightCli: resolvePlaywrightCli,
    nodePath: process.execPath,
    record: recordHostDependenciesResult,
    notify: () => {
      // デフォルトでは通知しない。stderr へ出す呼び出し元 (pecotv chromium host-deps) が差し替える。
    },
  }
}

function spawnDetail(result: Readonly<SpawnResult>): string {
  const output = `${result.stderr}\n${result.stdout}`.trim()
  return result.timedOut ? `did not finish in time: ${output}` : output
}

/**
Chromium が起動できる状態にする。

起動を試し、OS ライブラリ不足で落ちたときだけ不足パッケージを割り出して入れ、もう一度
起動を試す。Linux 以外は Playwright がブラウザ側に依存を同梱するため確認しない。

不足パッケージの割り出し (install-deps --dry-run) は apt の一覧に頼る。一覧が空の
イメージでは失敗するので、権限があるときは apt-get update をしてやり直す。update の
失敗 (無関係な第三者リポの署名切れ等) は install の失敗の手掛かりとして残すだけで、
install まで進む。
*/
export async function ensureChromiumHostDependencies(
  dependencies: HostDependencies,
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- signal は mutable 型
  signal?: AbortSignal,
): Promise<HostDependenciesOutcome> {
  if (dependencies.platform !== 'linux') return { status: 'ok' }

  const failure = await dependencies.probe()
  if (failure === undefined) return { status: 'ok' }
  if (!isMissingHostDependencies(failure)) return { status: 'launch-failed', detail: failure }
  const libraries = missingSharedLibraries(failure)
  const libraryList = libraries.length > 0 ? ` (${libraries.join(', ')})` : ''

  const missing = (packages: readonly string[], reason: string): HostDependenciesOutcome => ({
    status: 'missing',
    libraries,
    packages,
    detail: `OS libraries required to launch Chromium are missing${libraryList}; ${reason}`,
  })

  // -n: パスワードを求めずに使えるときだけ通す (devcontainer 等)。対話で止めない。
  const sudo = dependencies.isRoot ? undefined : await dependencies.run('sudo', ['-n', 'true'], SHORT_TIMEOUT_MS, signal)
  const canElevate = sudo === undefined || sudo.exitCode === 0

  // sudo はデフォルトで環境変数を引き継がないため、apt-get の非対話化は env で渡し直す。
  const command = dependencies.isRoot ? 'env' : 'sudo'
  const aptGet = [
    ...(dependencies.isRoot ? [] : ['-n', 'env']),
    'DEBIAN_FRONTEND=noninteractive',
    'apt-get',
    '-o',
    `DPkg::Lock::Timeout=${String(APT_LOCK_TIMEOUT_SECONDS)}`,
  ]
  const update: { done: boolean, failure: string | undefined } = { done: false, failure: undefined }
  const runUpdate = async (): Promise<void> => {
    if (!update.done) dependencies.notify('OS libraries required to launch Chromium are missing; installing them with apt-get (this can take a few minutes)')
    update.done = true
    const result = await dependencies.run(command, [...aptGet, 'update'], APT_TIMEOUT_MS, signal)
    update.failure = result.exitCode === 0 ? undefined : `apt-get update failed: ${spawnDetail(result)}`
  }
  const dryRun = async (): Promise<{ result: SpawnResult, packages: string[] }> => {
    const result = await dependencies.run(dependencies.nodePath, [dependencies.playwrightCli(), 'install-deps', '--dry-run', 'chromium'], SHORT_TIMEOUT_MS, signal)
    return { result, packages: hostPackagesFromDryRun(result.stdout) }
  }

  let found = await dryRun()
  if (canElevate && found.packages.length === 0) {
    await runUpdate()
    found = await dryRun()
  }
  const { packages } = found
  if (packages.length === 0) {
    const reasons = [spawnDetail(found.result), update.failure].filter(text => text !== undefined && text !== '').join('\n')
    return missing([], `cannot determine the packages to install on this OS; install the libraries above with the OS package manager: ${reasons}`)
  }
  if (!canElevate) {
    return missing(packages, `cannot install automatically without root privileges; run: ${aptInstallCommand(packages)}`)
  }

  if (!update.done) await runUpdate()
  const install = await dependencies.run(command, [...aptGet, 'install', '-y', '--no-install-recommends', ...packages], APT_TIMEOUT_MS, signal)
  if (install.exitCode !== 0) {
    const reasons = [spawnDetail(install), update.failure].filter(text => text !== undefined && text !== '').join('\n')
    return missing(packages, `apt-get install failed; check the network and proxy settings, then run: ${aptInstallCommand(packages)}\n${reasons}`)
  }

  const retry = await dependencies.probe()
  if (retry === undefined) return { status: 'installed', packages }
  if (!isMissingHostDependencies(retry)) return { status: 'launch-failed', detail: retry }
  return missing(packages, `installed ${packages.join(' ')}, but Chromium still cannot launch: ${retry}`)
}

/**
今の Playwright が使う Chromium のリビジョン。解決できないときは undefined。
*/
export function chromiumRevision(): string | undefined {
  const require_ = createRequire(import.meta.url)
  const core = createRequire(require_.resolve('playwright/package.json')).resolve('playwright-core/package.json')
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読むのは browsers.json のみ
  const manifest = readFileSync(path.join(path.dirname(core), 'browsers.json'), 'utf8')
  // browsers[] は name の直後に revision が並ぶ固定の書式 (utils/roll_browser.js の生成物)。
  return /"name":\s*"chromium",\s*"revision":\s*"(\d+)"/.exec(manifest)?.[1]
}

/**
確認の結果を印の置き場に記録する (置き場と印の形式は HOST_DEPS_STAMP を参照)。

記録できなくても (置き場が無い・リビジョンを解決できない・書き込めない) 失敗にはしない。
次回の起動で確認がもう一度動くだけで、結果は変わらない。
*/
export function recordHostDependenciesResult(status: HostDependenciesStampStatus, nowMs: number = Date.now()): void {
  try {
    const stateDirectory = stateFileDirectory()
    const revision = chromiumRevision()
    if (stateDirectory === undefined || revision === undefined) return
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 書くのは印の置き場直下の固定名の印のみ
    writeFileSync(path.join(stateDirectory, HOST_DEPS_STAMP), `${revision} ${status} ${String(Math.floor(nowMs / 1000))}\n`)
  }
  catch {
    // 上のコメントのとおり握りつぶす。
  }
}

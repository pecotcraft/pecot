// Playwright Chromium の取得状態の判定と、取得の実行。
//
// `pecotv mcp` は、MCP クライアントの接続タイムアウトに収めるため、起動時に Chromium を取得しない。
// 接続タイムアウトは、Claude Code の MCP_TIMEOUT が既定 30000ms。
// 取得は `setup` ツールを明示的に呼んだとき、または PECOTV_AUTO_INSTALL_BROWSER=1 のときにだけ動く。
//
// 通常の CLI 実行 (`pecotv drawio url` 等) の取得手段は bin/pecotv 側にあり、本モジュールは通らない。
// 両者の「取得済みか」の判定基準は、Playwright が完了時に置く INSTALLATION_COMPLETE マーカーで揃える。

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import { stateFileDirectory } from '../_shared/dependency-root.js'
import { withFlock } from '../_shared/flock.js'
import { spawnPromise } from '../_shared/process.js'

/**
Chromium 取得の上限時間 (ms)。

真 cold の計測は 33 秒 (Chrome for Testing / FFmpeg / Headless Shell の 3 本)。
この上限は同時に「MCP の直列実行キューを 1 件が専有してよい上限」でもある
(tools/call は FIFO で直列化され、取得中は他ツールが待たされる)。計測の 9 倍まで
待って返らないなら、待ち続けるより理由付きで失敗させて再実行させる方が早い。
*/
const INSTALL_TIMEOUT_MS = 300_000

/**
取得を自動で行ってよいかを示す opt-in の環境変数。
*/
export const AUTO_INSTALL_ENV = 'PECOTV_AUTO_INSTALL_BROWSER'

/**
Playwright が取得完了時にブラウザディレクトリ直下へ置くマーカー。
*/
const INSTALLATION_COMPLETE = 'INSTALLATION_COMPLETE'

/**
Playwright がブラウザを置くディレクトリ。判定できないときは undefined。

取得済みかの判定には使わない (判定は Playwright 自身の解決に寄せる。
chromiumBrowserDirectory を参照)。ここで求めるのは「どこに期待しているか」を
利用者へ示すための表示用の場所で、PLAYWRIGHT_BROWSERS_PATH を尊重する。
`0` はパッケージ同梱位置を指す特殊値で場所を特定できないため undefined を返す。
*/
export function browsersRoot(): string | undefined {
  const override = process.env['PLAYWRIGHT_BROWSERS_PATH']
  if (override === '0') return undefined
  if (override !== undefined && override !== '') return override
  const home = process.env['HOME']
  return home === undefined || home === '' ? undefined : path.join(home, '.cache', 'ms-playwright')
}

/**
Playwright が「今の playwright 版で使う」Chromium を置くディレクトリ。

解決は Playwright 自身に任せる。
`chromium.executablePath()` は `<browsers root>/chromium-<revision>/<platform 依存のパス>` を返す。
そのため、`chromium-` で始まる祖先ディレクトリまで遡れば、ブラウザディレクトリが得られる。
platform ごとに実行ファイルの深さが違うので、固定の段数では遡らない。

自前で `chromium-*` を走査しない理由は 2 つある。
- Playwright を上げた直後は、「古い chromium-<旧 rev> は残っているが、必要な chromium-<新 rev> は無い」状態になる。
  前方一致では取得済みと誤判定する。
- PLAYWRIGHT_BROWSERS_PATH=0 (パッケージ同梱位置) を、自前では解決できない。
*/
export async function chromiumBrowserDirectory(): Promise<string | undefined> {
  const { chromium } = await import('playwright')
  let directory = path.dirname(chromium.executablePath())
  while (!path.basename(directory).startsWith('chromium-')) {
    const parent = path.dirname(directory)
    /* c8 ignore next -- executablePath は必ず chromium-<rev> 配下を返すため到達しない防御網 */
    if (parent === directory) return undefined
    directory = parent
  }
  return directory
}

/**
Chromium バイナリが取得済みかを判定する。

見るのは、Playwright が取得完了時に置く INSTALLATION_COMPLETE マーカー。
これは playwright-core の browserFetcher が完了判定に使うのと同じもの。
ディレクトリの存在だけでは、展開先が先に作られるダウンロード途中の状態を、取得済みと誤判定する。
bin/pecotv の bootstrap も同じマーカーを見る。

判定に失敗したとき (playwright を解決できない・当該 platform 非対応) は、取得済み扱いで通す。
誤検知で使える機能を塞ぐより、実際の起動失敗を各コマンドのエラーとして返す。その方が害は小さい。
*/
export async function isChromiumInstalled(): Promise<boolean> {
  let directory: string | undefined
  try {
    directory = await chromiumBrowserDirectory()
  }
  catch {
    return true
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright 解決済みの dir のみ
  return directory === undefined || existsSync(path.join(directory, INSTALLATION_COMPLETE))
}

/**
PECOTV_AUTO_INSTALL_BROWSER による自動取得が有効か。
*/
export function isAutoInstallEnabled(): boolean {
  // eslint-disable-next-line security/detect-object-injection -- キーは本モジュールの定数
  return process.env[AUTO_INSTALL_ENV] === '1'
}

/**
`playwright` パッケージの CLI エントリの絶対パス。

`playwright/cli.js` は package.json の exports に載っていないため直接は解決できない。
exports に載っている `playwright/package.json` からパッケージ root を求めて join する。
node_modules が破損している / playwright が未 install の環境では同期 throw する。
*/
export function resolvePlaywrightCli(): string {
  const require_ = createRequire(import.meta.url)
  return path.join(path.dirname(require_.resolve('playwright/package.json')), 'cli.js')
}

/**
bin/pecotv がバックグラウンド取得に使う専有ロックのパス。

PECOTV_AUTO_INSTALL_BROWSER=1 の環境では、起動時のバックグラウンド取得とツール実行時の
取得が同時に動き得る。同じロックファイルを同じ primitive (flock(2)) で取ることで、
2 本目は 1 本目の完了を待ってから動く (待ったあとは Playwright 側が冪等に skip する)。

置き場所は `${データ置き場}/runtime`（bin/pecotv と同じ場所。runtimeStateDirectory）。
実行用ミラーを経ない形態（開発・単体配布）では、従来どおり依存ルートの node_modules
(infra/_shared/dependency-root.ts)。
実在するディレクトリが 1 つも無ければ undefined を返し、ロックなしで動く。
flock(1) は親ディレクトリが無いとロックファイルを作れず exit 66 で終わる。
そのため、場所が決まらないときにパスを組み立てて渡すと、取得そのものが必ず失敗する。
*/
export function installLockPath(): string | undefined {
  const stateDirectory = stateFileDirectory()
  return stateDirectory === undefined ? undefined : path.join(stateDirectory, '.pecotv-chromium-install.lock')
}

export interface InstallChromiumOptions {
  /**
  呼び出し元 (MCP の tools/call) がキャンセルされたら取得も打ち切る。
  */
  readonly signal?: AbortSignal | undefined
  /**
  playwright CLI の解決口。既定は resolvePlaywrightCli で、テストが解決失敗を差し込む。
  */
  readonly resolveCli?: (() => string) | undefined
}

/**
`playwright install chromium` を実行する。

既に取得済みでも Playwright 側が冪等に skip するため、呼び出し前の存在確認は不要。
取得済み判定は、ダウンロード途中を弾く目的でのみ使う。

flock(1) が使える環境では、bin/pecotv と同じロックファイル越しに実行する。
これは、起動時のバックグラウンド取得との二重ダウンロードを避けるため。
包み方と待ち方は infra/_shared/flock.ts に置き、実行時依存の取得と揃える。

env は利用者環境のものを引き継ぐ。
PLAYWRIGHT_DOWNLOAD_HOST や HTTPS_PROXY といった取得先・通信の指定は、利用者環境の変数で行われる。
そのため、絞り込むと取得できなくなる。
プロキシの CA は利用者が `NODE_EXTRA_CA_CERTS` で渡す。
Playwright の実ダウンロードは子 node を fork して動く。
fork は親の env を継承するので、利用者の指定は子にも届く。
*/
export async function installChromium(options: InstallChromiumOptions = {}): Promise<SpawnResult> {
  let cli: string
  try {
    cli = (options.resolveCli ?? resolvePlaywrightCli)()
  }
  catch (error: unknown) {
    // ここで throw すると MCP ハンドラの外へ例外が出て、SDK が structuredContent 無しのエラーへまとめる。
    // ToolResult 契約 (reason と `setup` 誘導) を保つため、起動失敗として返す。
    const detail = error instanceof Error ? error.message : String(error)
    return {
      // eslint-disable-next-line unicorn/no-null -- SpawnResult は起動失敗を exitCode: null で表す
      exitCode: null,
      // eslint-disable-next-line unicorn/no-null -- 同上
      signal: null,
      stdout: '',
      stderr: `cannot resolve the playwright package: ${detail}`,
      timedOut: false,
    }
  }

  const locked = withFlock(installLockPath(), process.execPath, [cli, 'install', 'chromium'])

  return await spawnPromise(
    locked.command,
    locked.commandArguments,
    {
      env: process.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      signal: options.signal,
    },
  )
}

// chromium 依存ツールの実行時ガード (src/mcp/tools/_shared.ts) をテストから決定論的に
// 固定するためのヘルパ。
//
// ガードは Playwright 自身の解決 (`chromium.executablePath()`) からブラウザディレクトリを求める。
// Playwright が取得完了時に置く INSTALLATION_COMPLETE の有無で、取得済みかを判定する。
// 素のままでは判定結果が実行ホストの `~/.cache/ms-playwright` の状態に依存してしまうため、
// 一時ディレクトリを指す `playwright` の mock に差し替える。
//
// PLAYWRIGHT_BROWSERS_PATH の stubEnv では固定できない。
// playwright は同変数を module の import 時に 1 度だけ読んで browsers root を確定する。
// そのためテストからの後追いの stub は働かない (playwright-core/lib/server/registry/index.js の registryDirectory)。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, vi } from 'vitest'

/**
Playwright のブラウザディレクトリ名。リビジョン番号は判定に使われないので固定値でよい。
*/
const BROWSER_DIRECTORY = 'chromium-0000'

/**
mock の状態。`resolveExecutablePath` が mock の返す実行ファイルパスの現在値。

vi.doMock は、同じ module id への再登録が済みの mock インスタンスへ届かないことがある。
そのため登録は 1 度きりにして、テストごとの差し替えはこの状態の書き換えで行う。
毎回 factory を差し替える形にすると、2 件目以降が 1 件目のパスを見続けて flake する。
*/
const playwrightMock = {
  resolveExecutablePath: (): string => {
    throw new Error('chromium の stub が設定されていません')
  },
  isRegistered: false,
}

function registerPlaywrightMock(): void {
  if (playwrightMock.isRegistered) return
  playwrightMock.isRegistered = true
  vi.doMock('playwright', () => ({
    chromium: { executablePath: () => playwrightMock.resolveExecutablePath() },
  }))
}

/**
「取得済み / 未取得」の browsers root を一時ディレクトリに作り、Playwright の解決を
そこへ向ける。

@param isInstalled true なら取得完了マーカーまで置く (= 取得済みと判定される)。
@returns 作った browsers root の絶対パス (後片付けは removeChromiumCacheDirectory)。
*/
export function createChromiumCacheDirectory(isInstalled: boolean): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecotv-ms-playwright-'))
  const browserDirectory = path.join(directory, BROWSER_DIRECTORY)
  // 実行ファイルの実体は不要。ガードが見るのは完了マーカーの有無だけ。
  mkdirSync(path.join(browserDirectory, 'chrome-linux64'), { recursive: true })
  if (isInstalled) writeFileSync(path.join(browserDirectory, 'INSTALLATION_COMPLETE'), '')
  const executablePath = path.join(browserDirectory, 'chrome-linux64', 'chrome')
  playwrightMock.resolveExecutablePath = () => executablePath
  registerPlaywrightMock()
  return directory
}

/**
Playwright 側が実行ファイルを解決できない状態 (platform 非対応など) にする。
*/
export function stubUnresolvableChromium(): void {
  playwrightMock.resolveExecutablePath = () => {
    throw new Error('Browser is not supported on current platform')
  }
  registerPlaywrightMock()
}

/**
createChromiumCacheDirectory で作った未取得の root を、取得済みに切り替える。
*/
export function markChromiumInstalled(directory: string): void {
  writeFileSync(path.join(directory, BROWSER_DIRECTORY, 'INSTALLATION_COMPLETE'), '')
}

export function removeChromiumCacheDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true })
}

/**
各テストの前に取得済みの browsers root を作って `PLAYWRIGHT_BROWSERS_PATH` に向け、後で片付ける。
`vi.stubEnv` の解除は呼び出し側の `vi.unstubAllEnvs()` が行う。
*/
export function useInstalledChromiumCache(): void {
  let directory = ''
  beforeEach(() => {
    directory = createChromiumCacheDirectory(true)
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', directory)
  })
  afterEach(() => {
    removeChromiumCacheDirectory(directory)
  })
}

// pecot-visual にも同じ helper がある（プラグインは別々に配布されるため、共有コードにせず各プラグインが持つ）。
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeAll, beforeEach } from 'vitest'

interface TemporaryDirectoryOptions {
  /**
  作成を `beforeAll`（ファイルで 1 回）にするか `beforeEach`（テストごと）にするか。既定は `beforeEach`。
  */
  readonly hook?: 'all' | 'each'
  /**
  symlink を解決した実パスで返すか（macOS の /var → /private/var などの差を避けたいとき）。
  */
  readonly resolveRealPath?: boolean
}

/**
テスト用の一時ディレクトリを `beforeEach` / `beforeAll` で作り、現在のパスを返す関数を返す。
返した関数は引数のセグメントをディレクトリへ連結する（`path.join(dir, ...segments)` と同じ）。
削除は呼び出し側のフックが行う。
*/
export function useTemporaryDirectory(
  prefix: string,
  options: Readonly<TemporaryDirectoryOptions> = {},
): (...segments: readonly string[]) => string {
  let directory = ''
  const create = (): void => {
    const root = options.resolveRealPath === true ? realpathSync.native(tmpdir()) : tmpdir()
    directory = mkdtempSync(path.join(root, prefix))
  }
  if (options.hook === 'all') beforeAll(create)
  else beforeEach(create)
  return (...segments) => path.join(directory, ...segments)
}

/**
テスト内で必要な数だけ一時ディレクトリを作る関数を返し、`afterEach` でまとめて消す。
`describe` / ファイルの直下で 1 度だけ呼ぶ。
*/
export function useTemporaryDirectories(): (prefix: string) => string {
  const created: string[] = []
  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })
  return (prefix) => {
    const directory = mkdtempSync(path.join(tmpdir(), prefix))
    created.push(directory)
    return directory
  }
}

// pnpm の起動コマンドを解く。bin/_lib.sh の resolve_pnpm と同じ順を TypeScript に写したもの。
//
// 順は pnpm、corepack pnpm@<版>、`npx --yes pnpm@<版>`。
// 版は package.json の packageManager から読み、読めなければ FALLBACK_PNPM_VERSION を使う。
// 単体配布の package.json は packageManager を持たない（npx で起動する配布物に pnpm の宣言を載せると、
// corepack を有効にした環境で止まる）。そのため定数が要る。

import { accessSync, constants, readFileSync } from 'node:fs'
import path from 'node:path'

/**
packageManager を読めないときの pnpm の版。
plugins/pecot-visual/package.json の packageManager と同じ値にし、unit test で固定する。
*/
export const FALLBACK_PNPM_VERSION = '12.15.0'

/**
起動する pnpm のコマンドと、その先頭の引数。
*/
export interface PnpmCommand {
  readonly command: string
  readonly commandArguments: readonly string[]
}

/**
コマンドが PATH 上にあるか。テストが差し替える。
*/
export type CommandProbe = (command: string) => boolean

// `[^+"]*` は `+`（ビルドメタデータ区切り）か閉じる `"` の手前までを版とする。bin/_lib.sh の pnpm_version_from_manifest と同じ。
const PACKAGE_MANAGER_PATTERN = /"packageManager": *"pnpm@([^+"]*)/u

function isOnPath(command: string): boolean {
  const directories = (process.env['PATH'] ?? '').split(path.delimiter).filter(directory => directory !== '')
  return directories.some((directory) => {
    try {
      accessSync(path.join(directory, command), constants.X_OK)
      return true
    }
    catch {
      return false
    }
  })
}

function pnpmVersion(pluginRoot: string): string {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 対象は plugin root の package.json
    const text = readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')
    const version = PACKAGE_MANAGER_PATTERN.exec(text)?.[1]
    return version === undefined || version === '' ? FALLBACK_PNPM_VERSION : version
  }
  catch {
    return FALLBACK_PNPM_VERSION
  }
}

/**
pnpm の起動コマンドを返す。pnpm が無く corepack も無いときは npx で版を指す。
*/
export function resolvePnpmCommand(pluginRoot: string, isAvailable: CommandProbe = isOnPath): PnpmCommand {
  if (isAvailable('pnpm')) return { command: 'pnpm', commandArguments: [] }
  if (isAvailable('corepack')) return { command: 'corepack', commandArguments: [`pnpm@${pnpmVersion(pluginRoot)}`] }
  return { command: 'npx', commandArguments: ['--yes', `pnpm@${pnpmVersion(pluginRoot)}`] }
}

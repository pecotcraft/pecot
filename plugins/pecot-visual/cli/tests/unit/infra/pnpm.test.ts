// infra/_shared/pnpm.ts の unit test。
// pnpm → corepack pnpm → npx pnpm@<版>（cwd は /、--dir で対象を指す）の順と、版の読み方を固定する。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp の一時ディレクトリ配下と追跡ファイルだけ */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FALLBACK_PNPM_VERSION, resolvePnpmCommand } from '../../../src/infra/_shared/pnpm.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const TARGET = '/work/theme/package'
const temporaryRoot = useTemporaryDirectory('pecotv-pnpm-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

function only(...available: readonly string[]): (command: string) => boolean {
  return command => available.includes(command)
}

function writeManifest(contents: string): string {
  writeFileSync(temporaryRoot('package.json'), contents, 'utf8')
  return temporaryRoot()
}

describe('resolvePnpmCommand', () => {
  it('pnpm があれば、pnpm をそのまま使う', async () => {
    await explains('使う pnpm のコマンドを決める `resolvePnpmCommand` のテストです。`pnpm`・`corepack`・`npx` がすべて使える場合に、`pnpm` を引数なしで返すことを確認します。')
    expect(resolvePnpmCommand(temporaryRoot(), TARGET, only('pnpm', 'corepack', 'npx'))).toEqual({ command: 'pnpm', commandArguments: [] })
  })

  it('pnpm がなければ、corepack を使い、packageManager に書かれた版の pnpm を指定する', async () => {
    await explains('使う pnpm のコマンドを決める `resolvePnpmCommand` のテストです。`corepack` だけを使える場合に、`pnpm@10.1.2+sha512.abc` の版を使い、`corepack pnpm@10.1.2` を返すことを確認します。')
    const root = writeManifest('{ "packageManager": "pnpm@10.1.2+sha512.abc" }')
    expect(resolvePnpmCommand(root, TARGET, only('corepack', 'npx'))).toEqual({ command: 'corepack', commandArguments: ['pnpm@10.1.2'] })
  })

  it('pnpm と corepack がなければ、npx を使い、packageManager に書かれた版の pnpm を指定する', async () => {
    await explains('使う pnpm のコマンドを決める `resolvePnpmCommand` のテストです。`npx` だけが使える場合に、`packageManager` の版を指定した `npx --yes pnpm@<版> --dir <対象>` と、作業ディレクトリの `/` を返すことを確認します。')
    const root = writeManifest('{ "packageManager": "pnpm@10.0.0-beta.1+sha512.abc" }')
    expect(resolvePnpmCommand(root, TARGET, only('npx'))).toEqual({
      command: 'npx',
      commandArguments: ['--yes', 'pnpm@10.0.0-beta.1', '--dir', TARGET],
      cwd: '/',
    })
  })

  it('packageManager を読み取れなければ、定数の既定の版を使う', async () => {
    await explains('使う pnpm のコマンドを決める `resolvePnpmCommand` のテストです。`package.json` がない場合と `packageManager` がない場合に、`FALLBACK_PNPM_VERSION` の版を指定した `npx` の引数を返すことを確認します。')
    expect(resolvePnpmCommand(temporaryRoot(), TARGET, only('npx'))).toEqual({
      command: 'npx',
      commandArguments: ['--yes', `pnpm@${FALLBACK_PNPM_VERSION}`, '--dir', TARGET],
      cwd: '/',
    })
    const root = writeManifest('{ "name": "x" }')
    expect(resolvePnpmCommand(root, TARGET, only('npx')).commandArguments).toEqual(['--yes', `pnpm@${FALLBACK_PNPM_VERSION}`, '--dir', TARGET])
  })

  it('コマンドの有無の確認を省略した場合は、PATH から探し、この環境にある pnpm を使う', async () => {
    await explains('使う pnpm のコマンドを決める `resolvePnpmCommand` のテストです。コマンドの有無を確認する引数を渡さない場合に、実際の `PATH` から `pnpm` を見つけ、`pnpm` を引数なしで返すことを確認します。')
    expect(resolvePnpmCommand(temporaryRoot(), TARGET)).toEqual({ command: 'pnpm', commandArguments: [] })
  })
})

describe('FALLBACK_PNPM_VERSION', () => {
  it('既定の pnpm の版は、plugins/pecot-visual/package.json の packageManager の版と同じにする', async () => {
    await explains('定数 `FALLBACK_PNPM_VERSION` のテストです。`plugins/pecot-visual/package.json` の `packageManager` から `+` 以降を除いた値が、`pnpm@` に続けた定数の版と一致することを確認します。')
    const manifest: unknown = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    const declared = typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest ? manifest.packageManager : undefined
    expect(String(declared).split('+', 1)[0]).toBe(`pnpm@${FALLBACK_PNPM_VERSION}`)
  })
})

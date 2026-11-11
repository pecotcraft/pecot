// infra/_shared/pnpm.ts の unit test。
// pnpm → corepack pnpm → npx pnpm@<版>（cwd は /、--dir で対象を指す）の順と、版の読み方を固定する。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp の一時ディレクトリ配下と追跡ファイルだけ */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FALLBACK_PNPM_VERSION, resolvePnpmCommand } from '../../../src/infra/_shared/pnpm.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

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
  it('pnpm があればそれを使う', () => {
    expect(resolvePnpmCommand(temporaryRoot(), TARGET, only('pnpm', 'corepack', 'npx'))).toEqual({ command: 'pnpm', commandArguments: [] })
  })

  it('pnpm が無ければ corepack で packageManager の版の pnpm を使う', () => {
    const root = writeManifest('{ "packageManager": "pnpm@10.1.2+sha512.abc" }')
    expect(resolvePnpmCommand(root, TARGET, only('corepack', 'npx'))).toEqual({ command: 'corepack', commandArguments: ['pnpm@10.1.2'] })
  })

  it('どちらも無ければ npx で packageManager の版を指す', () => {
    const root = writeManifest('{ "packageManager": "pnpm@10.0.0-beta.1+sha512.abc" }')
    expect(resolvePnpmCommand(root, TARGET, only('npx'))).toEqual({
      command: 'npx',
      commandArguments: ['--yes', 'pnpm@10.0.0-beta.1', '--dir', TARGET],
      cwd: '/',
    })
  })

  it('packageManager が読めなければ定数の版を使う', () => {
    expect(resolvePnpmCommand(temporaryRoot(), TARGET, only('npx'))).toEqual({
      command: 'npx',
      commandArguments: ['--yes', `pnpm@${FALLBACK_PNPM_VERSION}`, '--dir', TARGET],
      cwd: '/',
    })
    const root = writeManifest('{ "name": "x" }')
    expect(resolvePnpmCommand(root, TARGET, only('npx')).commandArguments).toEqual(['--yes', `pnpm@${FALLBACK_PNPM_VERSION}`, '--dir', TARGET])
  })

  it('既定の probe は PATH を引く（この環境には pnpm がある）', () => {
    expect(resolvePnpmCommand(temporaryRoot(), TARGET)).toEqual({ command: 'pnpm', commandArguments: [] })
  })
})

describe('FALLBACK_PNPM_VERSION', () => {
  it('既定の pnpm の版は、plugins/pecot-visual/package.json の packageManager が指す版と等しい', () => {
    const manifest: unknown = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    const declared = typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest ? manifest.packageManager : undefined
    expect(String(declared).split('+', 1)[0]).toBe(`pnpm@${FALLBACK_PNPM_VERSION}`)
  })
})

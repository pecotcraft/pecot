/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下のみ */
// w-onboarding の open_browser.sh が、OS ごとに正しいコマンドでブラウザを開くことと、開けないときの失敗を確かめる。
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import { pluginRoot } from './_helpers/documents.js'

const SCRIPT = path.join(pluginRoot, 'skills/w-onboarding/scripts/open_browser.sh')
const URL_ARGUMENT = 'https://example.com'

function isWsl(): boolean {
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  }
  catch {
    return false
  }
}

function installMock(binDirectory: string, name: string): void {
  const target = path.join(binDirectory, name)
  writeFileSync(target, `#!/bin/bash\necho "mock: ${name} $*"\n`)
  chmodSync(target, 0o755)
}

function run(arguments_: readonly string[], pathValue?: string): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...arguments_], {
    encoding: 'utf8',
    timeout: 25_000,
    env: { ...process.env, ...pathValue !== undefined && { PATH: pathValue } },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function withMockBin(name: string): string {
  const binDirectory = makeTemporaryDirectory()
  installMock(binDirectory, name)
  return `${binDirectory}${path.delimiter}${process.env['PATH'] ?? ''}`
}

describe('open_browser.sh', () => {
  it('引数なしでは、使い方の文を stderr に出して失敗する', () => {
    const result = run([])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage: open_browser.sh <url>')
  })

  it.skipIf(!isWsl())('WSL では powershell.exe を呼ぶ', () => {
    const result = run([URL_ARGUMENT], withMockBin('powershell.exe'))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('mock: powershell.exe -Command Start-Process \'https://example.com\'\n')
  })

  it.skipIf(isWsl() || process.platform !== 'darwin')('macOS では open を呼ぶ', () => {
    const result = run([URL_ARGUMENT], withMockBin('open'))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('mock: open https://example.com\n')
  })

  it.skipIf(isWsl() || process.platform === 'darwin')('Linux では xdg-open を呼ぶ', () => {
    const result = run([URL_ARGUMENT], withMockBin('xdg-open'))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('mock: xdg-open https://example.com\n')
  })

  it.skipIf(isWsl() || process.platform === 'darwin')('ブラウザのコマンドが無いときは、URL を示して失敗する', () => {
    // xdg-open を PATH から外し、基本のコマンドだけをシンボリックリンクで置く
    const binDirectory = makeTemporaryDirectory()
    for (const command of ['bash', 'grep', 'uname', 'cat', 'echo', 'printf', 'sed', 'awk', 'rm', 'mkdir', 'chmod', 'ln', 'ls']) {
      const real = spawnSync('bash', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim()
      const link = path.join(binDirectory, command)
      if (real !== '' && !existsSync(link)) symlinkSync(real, link)
    }
    const result = run([URL_ARGUMENT], binDirectory)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('ブラウザを自動で開けません。以下のURLを手動で開いてください:\nhttps://example.com\n')
  })
})

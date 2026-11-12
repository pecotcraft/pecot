/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// set -e の無いエントリポイントの、スクリプト不在と実行権限なしの動作を確かめる。
// 各行の失敗は無視される。最後の行の終了コードが、スクリプト全体の終了コードになる。
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { runScript } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'

function makeEntry(entryDirectory: string, lines: readonly string[]): string {
  const entry = path.join(entryDirectory, 'entry.sh')
  writeFileSync(entry, `#!/bin/bash\n${lines.join('\n')}\n`)
  chmodSync(entry, 0o755)
  return entry
}

function makeDummy(file: string, message: string): void {
  writeFileSync(file, `#!/bin/bash\necho "${message}"\n`)
  chmodSync(file, 0o755)
}

interface Directories {
  readonly entryDirectory: string
  readonly scriptsDirectory: string
}

function setUpDirectories(hookCase: HookCase): Directories {
  const entryDirectory = path.join(hookCase.temporaryPath, 'entry')
  const scriptsDirectory = path.join(hookCase.temporaryPath, 'scripts')
  mkdirSync(entryDirectory, { recursive: true })
  mkdirSync(scriptsDirectory, { recursive: true })
  return { entryDirectory, scriptsDirectory }
}

function combined(result: RunResult): string {
  return result.stdout + result.stderr
}

describe('エントリポイントのエッジケース', () => {
  it('呼ぶスクリプトが存在しないとき、終了コード 127 とスクリプト名のエラーを返す', () => {
    const hookCase = createHookCase()
    const { entryDirectory, scriptsDirectory } = setUpDirectories(hookCase)
    const entry = makeEntry(entryDirectory, [`"${scriptsDirectory}/nonexistent.sh"`])
    const result = runScript(hookCase, entry)
    expect(result.exitCode).toBe(127)
    // stderr にスクリプトのパスを含むエラーメッセージが出る（stdout と合わせて確かめる）
    expect(combined(result)).toContain('nonexistent.sh')
  })

  it('存在しないスクリプトの後に有効なスクリプトを呼ぶとき、終了コード 0 でその出力を返す', () => {
    const hookCase = createHookCase()
    const { entryDirectory, scriptsDirectory } = setUpDirectories(hookCase)
    makeDummy(path.join(scriptsDirectory, 'valid.sh'), 'valid-output')
    const entry = makeEntry(entryDirectory, [`"${scriptsDirectory}/nonexistent.sh"`, `"${scriptsDirectory}/valid.sh"`])
    const result = runScript(hookCase, entry)
    expect(result.exitCode).toBe(0)
    expect(combined(result)).toContain('valid-output')
  })

  it('呼ぶスクリプトがすべて存在しないとき、終了コード 127 ですべての名前をエラーに含める', () => {
    const hookCase = createHookCase()
    const { entryDirectory, scriptsDirectory } = setUpDirectories(hookCase)
    const entry = makeEntry(entryDirectory, [
      `"${scriptsDirectory}/missing1.sh"`,
      `"${scriptsDirectory}/missing2.sh"`,
      `"${scriptsDirectory}/missing3.sh"`,
    ])
    const result = runScript(hookCase, entry)
    expect(result.exitCode).toBe(127)
    expect(combined(result)).toContain('missing1.sh')
    expect(combined(result)).toContain('missing2.sh')
    expect(combined(result)).toContain('missing3.sh')
  })

  it('呼ぶスクリプトに実行権限が無いとき、終了コード 126 を返し、スクリプトは実行しない', () => {
    const hookCase = createHookCase()
    const { entryDirectory, scriptsDirectory } = setUpDirectories(hookCase)
    const noPermission = path.join(scriptsDirectory, 'no_perm.sh')
    writeFileSync(noPermission, '#!/bin/bash\necho "should-not-appear"\n')
    chmodSync(noPermission, 0o644)
    const entry = makeEntry(entryDirectory, [`"${noPermission}"`])
    const result = runScript(hookCase, entry)
    expect(result.exitCode).toBe(126)
    expect(combined(result)).toContain('no_perm.sh')
    expect(combined(result)).not.toContain('should-not-appear')
  })

  it('実行権限の無いスクリプトの後に有効なスクリプトを呼ぶとき、終了コード 0 でその出力を返す', () => {
    const hookCase = createHookCase()
    const { entryDirectory, scriptsDirectory } = setUpDirectories(hookCase)
    const noPermission = path.join(scriptsDirectory, 'no_perm.sh')
    writeFileSync(noPermission, '#!/bin/bash\necho "should-not-appear"\n')
    chmodSync(noPermission, 0o644)
    makeDummy(path.join(scriptsDirectory, 'valid_after.sh'), 'after-output')
    const entry = makeEntry(entryDirectory, [`"${noPermission}"`, `"${scriptsDirectory}/valid_after.sh"`])
    const result = runScript(hookCase, entry)
    expect(result.exitCode).toBe(0)
    expect(combined(result)).toContain('after-output')
  })
})

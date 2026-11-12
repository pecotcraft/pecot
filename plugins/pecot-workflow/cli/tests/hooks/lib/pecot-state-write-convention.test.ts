// .pecot 書き込み規約の確認（#666）。lib 配下の .sh で mkdir を直接含むものが、許可した 3 ファイルだけであることを固定する。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import { hooksDirectory, projectRoot } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import { splitLines } from '../_helpers/text.js'

const ALLOWLIST = new Set(['pecot-dir-init.sh', 'pecot-gitignore-ensure.sh', 'pecot-state-guard.sh'])

describe('.pecot 書き込み規約', () => {
  it('mkdir を直接含む .sh は、許可した 3 ファイルだけにする', () => {
    const hookCase = createHookCase()
    const libraryDirectory = path.join(hooksDirectory, 'lib')
    // 手前に # が無い行の mkdir のみ一致させる。コメント行は除外し、-l でファイル名だけを返す。
    const result = run(hookCase, 'grep', ['-rlP', '--include=*.sh', '--exclude-dir=tests', String.raw`^[^#]*\bmkdir\b`, libraryDirectory])
    // grep の exit 1（マッチなし）は許容する。2 以上は実行エラー。
    expect([0, 1], `grep failed: ${result.stderr}`).toContain(result.exitCode)

    const offenders = splitLines(result.stdout)
      .filter(line => line !== '' && !ALLOWLIST.has(path.basename(line)))
      .map(line => path.relative(projectRoot, line))

    expect(offenders, `allowlist 外で mkdir を直接含む .sh: ${offenders.join(', ')} — pecot_state_dir_ensure() 経由へ置換してください（gitignore-before-write #666）。`).toEqual([])
  })
})

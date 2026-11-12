/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// エントリーポイントリンターのテスト。
// .githooks/pre-commit/check-entry-point-logic.sh の挙動を検証する。
// ディスパッチャに含めてよい構文は PASS とする（shebang / SCRIPT_DIR / 早期リターン / スクリプト呼び出し）。
// ロジックは VIOLATION として報告する（for / while / case / 関数定義 / grep-sed-awk / mkdir-touch-rm）。
import { readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { hooksDirectory, projectRoot } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { splitLines } from '../_helpers/text.js'

const LINTER = path.join(projectRoot, '.githooks', 'pre-commit', 'check-entry-point-logic.sh')

function runLinter(hookCase: HookCase, ...targets: readonly string[]): RunResult {
  return run(hookCase, 'bash', [LINTER, ...targets])
}

// 行の配列を改行でつなぐ。末尾の空要素が最後の改行になる。
function joinLines(...lines: readonly string[]): string {
  return lines.join('\n')
}

// パスするケース。
const PASS_FIXTURES = [
  {
    label: 'ハンドラを呼ぶだけ',
    name: 'clean.sh',
    content: joinLines('#!/bin/bash', 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"', '"$SCRIPT_DIR/lib/handler.sh"', ''),
  },
  {
    label: 'jq で振り分ける',
    name: 'jq_dispatch.sh',
    content: joinLines(
      '#!/bin/bash',
      'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'INPUT=$(cat)',
      'TOOL_NAME=$(echo "$INPUT" | jq -r \'.tool_name\')',
      '[ -z "$TOOL_NAME" ] && exit 0',
      '"$SCRIPT_DIR/lib/handler.sh"',
      'exit 0',
      '',
    ),
  },
  {
    label: 'source と export',
    name: 'source_export.sh',
    content: joinLines(
      '#!/bin/bash',
      'set -euo pipefail',
      'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'LIB_DIR="$SCRIPT_DIR/lib"',
      'source "$LIB_DIR/common.sh"',
      'export HOOK_COMMAND="$COMMAND"',
      'OUTPUT=$("$LIB_DIR/core/check.sh")',
      'if [ $? -eq 1 ]; then',
      '    echo "$OUTPUT"',
      '    exit 1',
      'fi',
      'exit 0',
      '',
    ),
  },
  {
    label: 'コメントだけ',
    name: 'comments_only.sh',
    content: joinLines('#!/bin/bash', '# This is a comment', '# Another comment', '', '# More comments', '', ''),
  },
  {
    label: 'パイプでハンドラに渡す',
    name: 'pipe_exec.sh',
    content: joinLines(
      '#!/bin/bash',
      'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'INPUT=$(cat)',
      'echo "$INPUT" | "$SCRIPT_DIR/lib/handler.sh"',
      'exit 0',
      '',
    ),
  },
  {
    label: '早期リターン',
    name: 'early_return.sh',
    content: joinLines(
      '#!/bin/bash',
      'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'INPUT=$(cat)',
      'MODE=$(echo "$INPUT" | jq -r \'.mode\')',
      '[ "$MODE" != "active" ] && exit 0',
      '"$SCRIPT_DIR/lib/handler.sh"',
      'exit 0',
      '',
    ),
  },
]

// 実エントリポイント全件（ガード本体と一覧のドリフト検知）。
// guard は .pre-commit-config.yaml では、staged ファイルのみを確認する。
// そのため、「全 entry point が違反 0」と「一覧が実ファイルと一致」は、ここで担保する。
// .githooks/tests/ 側の同名ファイルは、files: ^\.githooks/ の pre-push でしか動かない。
// entry point の変更では発火しない。

// 引数なし実行（= guard 内蔵の ALL_ENTRY_POINTS を対象）。パスはリポルート相対。
function runLinterAllEntryPoints(hookCase: HookCase): RunResult {
  return run(hookCase, 'bash', [LINTER], { cwd: projectRoot })
}

function realEntryPoints(): Set<string> {
  const names = readdirSync(hooksDirectory).filter(name => name.endsWith('.sh'))
  return new Set(names.map(name => path.relative(projectRoot, path.join(hooksDirectory, name)).split(path.sep).join('/')))
}

// guard 出力から確認対象パスを復元する（PASS / VIOLATION / WARNING の 3 形態）。
function reportedTargets(stdout: string): Set<string> {
  const targets = new Set<string>()
  for (const line of splitLines(stdout)) {
    const prefix = ['PASS: ', 'VIOLATION: ', 'WARNING: File not found: '].find(candidate => line.startsWith(candidate))
    if (prefix !== undefined) targets.add(line.slice(prefix.length).trim())
  }
  return targets
}

describe('check-entry-point-logic.sh', () => {
  it.for(PASS_FIXTURES)('ディスパッチャとして許される構文（$label）のとき、PASS を返す', (row) => {
    const hookCase = createHookCase()
    const target = path.join(hookCase.temporaryPath, row.name)
    writeFileSync(target, row.content)
    const result = runLinter(hookCase, target)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('PASS:')
  })

  it('実在するクリーンなエントリポイントは、PASS を返す', () => {
    const hookCase = createHookCase()
    const result = runLinter(hookCase, path.join(hooksDirectory, 'session-start.sh'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('PASS:')
  })

  // 違反するケース。
  it.for([
    {
      label: 'for ループ',
      name: 'for_loop.sh',
      content: joinLines('#!/bin/bash', 'for file in *.sh; do', '    echo "$file"', 'done', ''),
      marker: 'for file',
    },
    {
      label: 'while ループ',
      name: 'while_loop.sh',
      content: joinLines('#!/bin/bash', 'while read -r line; do', '    echo "$line"', 'done', ''),
      marker: 'while read',
    },
    {
      label: 'case',
      name: 'case_esac.sh',
      content: joinLines('#!/bin/bash', 'case "$1" in', '    start) echo "starting" ;;', '    stop) echo "stopping" ;;', 'esac', ''),
      marker: 'case "$1"',
    },
    {
      label: '関数定義',
      name: 'func_def.sh',
      content: joinLines('#!/bin/bash', 'my_function() {', '    echo "hello"', '}', ''),
      marker: 'my_function()',
    },
    {
      label: 'grep と sed',
      name: 'grep_sed.sh',
      content: joinLines(
        '#!/bin/bash',
        'INPUT=$(cat)',
        'RESULT=$(echo "$INPUT" | grep -oP \'pattern\')',
        'echo "$RESULT" | sed \'s/old/new/\'',
        '',
      ),
      marker: 'grep -oP',
    },
    {
      label: 'mkdir・touch・rm',
      name: 'file_ops.sh',
      content: joinLines('#!/bin/bash', 'mkdir -p "$WORK_DIR/test"', 'touch "$WORK_DIR/test/file"', 'rm -f "$WORK_DIR/test/file"', ''),
      marker: 'mkdir',
    },
  ])('ロジック（$label）を含むとき、VIOLATION を報告する', (row) => {
    const hookCase = createHookCase()
    const target = path.join(hookCase.temporaryPath, row.name)
    writeFileSync(target, row.content)
    const result = runLinter(hookCase, target)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('VIOLATION:')
    expect(result.stdout).toContain(row.marker)
  })

  it('実エントリポイント全件が、違反 0 かつ exit 0 で、未確認の WARNING も無い', () => {
    const hookCase = createHookCase()
    const result = runLinterAllEntryPoints(hookCase)
    const expectedCount = realEntryPoints().size
    // 実在しないパスが一覧に残ると、clean へ誤計上される
    expect(result.stdout).not.toContain('WARNING')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`0 files with violations, ${String(expectedCount)} files clean`)
  })

  // 一覧に実在しないパスが残ると WARNING 付きで clean 計上され、実在するエントリが一覧から抜けると恒久的に未確認になる。
  // どちらも guard を pass させてしまうため、実ファイル集合との一致をここで固定する。
  it('ALL_ENTRY_POINTS の一覧と hooks/*.sh が、双方向で一致する', () => {
    const hookCase = createHookCase()
    const result = runLinterAllEntryPoints(hookCase)
    expect(reportedTargets(result.stdout)).toEqual(realEntryPoints())
  })

  it('クリーンなものと違反するものが両方あるとき、件数を分けて報告する', () => {
    const hookCase = createHookCase()
    const clean = path.join(hookCase.temporaryPath, 'clean.sh')
    writeFileSync(clean, joinLines('#!/bin/bash', 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"', '"$SCRIPT_DIR/lib/handler.sh"', ''))
    const dirty = path.join(hookCase.temporaryPath, 'dirty.sh')
    writeFileSync(dirty, joinLines('#!/bin/bash', 'for i in 1 2 3; do', '    echo "$i"', 'done', ''))

    const result = runLinter(hookCase, clean, dirty)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('PASS:')
    expect(result.stdout).toContain('VIOLATION:')
    expect(result.stdout).toContain('1 files with violations, 1 files clean')
  })
})

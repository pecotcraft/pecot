/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pre-tool-use-bash.sh の permission_mode 非依存性のテスト。実 JSON をエントリに流し、通常モードと plan mode で同じ判定を返すことを固定する。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import { gitRepository } from './_helpers/git.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import { jsonDumps } from './_helpers/text.js'

const ENTRY = path.join(hooksDirectory, 'pre-tool-use-bash.sh')

// 判定ごとに stdout が含むべき断片と、含んではいけない断片
const NO_FRAGMENTS: readonly string[] = []
const ASK = { contains: ['"permissionDecision"', '"ask"'], absent: NO_FRAGMENTS }
const DENY = { contains: ['"permissionDecision": "deny"'], absent: ['"decision"'] }

// 操作と、発火するガードの期待判定。
// pecot pr create <file> は ask（external-post-check / pecot-pr-create-ask）。
// gh pr merge <n> は ask（external-post-check / gh-pr-merge-ask）。
// git commit --no-verify は deny（git-no-verify-check）。
// gh pr create は deny（gh-command-check / gh-pr-create-check）。
// pecot issue quick -m <msg> は ask（external-post-check / pecot-issue-create-ask）。
const OPERATIONS = [
  { command: 'pecot pr create x.md', expected: 'ask', decision: ASK },
  { command: 'gh pr merge 1', expected: 'ask', decision: ASK },
  { command: 'git commit --no-verify -m x', expected: 'deny', decision: DENY },
  { command: 'gh pr create', expected: 'deny', decision: DENY },
  { command: 'pecot issue quick -m x -r owner/repo', expected: 'ask', decision: ASK },
]

describe('pre-tool-use-bash.sh', () => {
  it.for(
    OPERATIONS.flatMap(operation => ['default', 'plan'].map(mode => ({ ...operation, mode, label: operation.command }))),
  )('permission_mode が $mode のとき、$label に対するガードは $expected を返す', (row) => {
    const hookCase = createHookCase()
    // 環境は、feature ブランチの git リポジトリと .pecot-active
    const repository = gitRepository(hookCase)
    const checkout = run(hookCase, 'git', ['-C', repository, 'checkout', '-b', 'feat/regression/820', '--quiet'])
    expect(checkout.exitCode).toBe(0)
    const state = path.join(repository, '.pecot', 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(path.join(state, '.pecot-active'), 'org/repo/820\n')
    hookCase.setEnv('CLAUDE_PROJECT_DIR', repository)

    const payload = jsonDumps({
      tool_name: 'Bash',
      tool_input: { command: row.command },
      permission_mode: row.mode,
    })
    const result = run(hookCase, 'bash', [ENTRY], { stdin: payload, cwd: repository })

    expect(result.exitCode).toBe(0)
    for (const fragment of row.decision.contains) expect(result.stdout).toContain(fragment)
    for (const fragment of row.decision.absent) expect(result.stdout).not.toContain(fragment)
  })
})

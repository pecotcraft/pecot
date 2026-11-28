// 移行後の案内文（hooks/lib/core/mcp-guidance.sh）を固定する。
// 各関数の出力の全文と、対応する MCP ツール名があり、pecot の起動形が無いことを確かめる。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import { runShell } from './_helpers/run.js'
import { explains } from '../_helpers/explains.js'

const guidanceScript = path.resolve(import.meta.dirname, '../../../hooks/lib/core/mcp-guidance.sh')

// pecot の起動形: `pecot <語>`・`$PECOT`・`bin/pecot`。
const launcherForm = /(?<![\w-])pecot\s+[a-z]|\$PECOT|bin\/pecot/

const guidances = [
  { shellFunction: 'mcp_guidance_gh_pr_create', start: 'gh-pr-create-check: gh pr create is not allowed.', tools: ['pr_check', 'create_pull_request'], text:
      'gh-pr-create-check: gh pr create is not allowed.\n\nReason: using gh pr create directly skips the automatic Issue reference, the PR template validation,\nand the traceability record, which breaks the consistency of the workflow.\n\nUse this instead:\n  check the values with the MCP tool pr_check of the workflow server,\n  then create the PR with create_pull_request of the official GitHub MCP server\n  (steps: skills/w-help/references/github-write.md)\n' },
  { shellFunction: 'mcp_guidance_gh_issue_create', start: 'gh-issue-create-check: gh issue create is not allowed.', tools: ['issue_check', 'issue_write'], text:
      'gh-issue-create-check: gh issue create is not allowed.\n\nReason: using gh issue create directly skips the checks of the workflow (the template,\nthe title number, the prerequisites and the board fields), which breaks the consistency\nand traceability of the workflow.\n\nUse this instead:\n  check the arguments with the MCP tool issue_check of the workflow server,\n  then create the Issue with issue_write of the official GitHub MCP server\n  (steps: skills/w-help/references/github-write.md)\n' },
  { shellFunction: 'mcp_guidance_gh_stack', start: 'gh-stack-check: gh stack is not allowed', tools: ['pr_check', 'create_pull_request', 'stack-register', 'pr_restack'], text:
      'gh-stack-check: gh stack is not allowed (only gh stack view (use --json) and --help are).\n\nReason: running gh stack directly changes the stack without the workflow\'s records,\nthe Issue reference and the readiness checks, which breaks the consistency of the workflow.\n\nUse these instead:\n  open a stacked PR: check with the MCP tool pr_check of the workflow server, create it with\n    create_pull_request of the official GitHub MCP server, then register it with the\n    stack-register operation of github-ops (steps: skills/w-help/references/github-write.md)\n  merge a PR: the merge button on the GitHub page (/pecot-w:w-pr waits for it and cleans up)\n  restack a stacked branch: the MCP tool pr_restack of the workflow server\n' },
]

function guidanceOf(shellFunction: string): string {
  const result = runShell(createHookCase(), 'source "$1"; "$2"', [guidanceScript, shellFunction])
  expect(result.exitCode).toBe(0)
  return result.stdout
}

describe('mcp-guidance', () => {
  it.for(guidances)('$shellFunction は、$start で始まり、対応するツール名を案内する', async ({ shellFunction, start, tools }) => {
    await explains(`移行後の案内文（\`mcp-guidance.sh\`）のテストです。\`${shellFunction}\` の出力を取得した場合に、決めた書き出しで始まり、対応する MCP ツール名をすべて含むことを確認します。`)
    const text = guidanceOf(shellFunction)
    expect(text.startsWith(start)).toBe(true)
    for (const tool of tools) expect(text).toContain(tool)
  })

  it('mcp_guidance_gh_stack は、マージを画面のマージボタンに案内し、pr_merge を案内しない', async () => {
    await explains('移行後の案内文（`mcp-guidance.sh`）のテストです。`mcp_guidance_gh_stack` の出力を取得した場合に、マージを GitHub の画面のボタンへ案内し、`pr_merge` を案内しないことを確認します。')
    const text = guidanceOf('mcp_guidance_gh_stack')
    expect(text).toContain('merge a PR: the merge button on the GitHub page')
    expect(text).not.toContain('pr_merge')
  })

  it.for(guidances)('$shellFunction の出力は、決めた全文と一致する', async ({ shellFunction, text }) => {
    await explains(`移行後の案内文（\`mcp-guidance.sh\`）のテストです。\`${shellFunction}\` の出力を取得した場合に、決めた全文と一致することを確認します。`)
    expect(guidanceOf(shellFunction)).toBe(text)
  })

  it.for(guidances)('$shellFunction の出力に、pecot の起動形が無い', async ({ shellFunction }) => {
    await explains(`移行後の案内文（\`mcp-guidance.sh\`）のテストです。\`${shellFunction}\` の出力を取得した場合に、\`pecot\` コマンドの起動形が含まれないことを確認します。`)
    expect(guidanceOf(shellFunction)).not.toMatch(launcherForm)
  })

  it('起動形の検出は、元の案内文の形を拾う', async () => {
    await explains('移行後の案内文のテストです。元の案内文にあった `pecot` の起動形の 2 つの例を検出用の正規表現へ通した場合は、どちらも一致することを確認します。')
    expect('/opt/plugin/bin/pecot branch delete <owner/repo> <branch>').toMatch(launcherForm)
    expect('Run `pecot issue quick` or `pecot issue create` first.').toMatch(launcherForm)
  })
})

// 移行後の案内文（hooks/lib/core/mcp-guidance.sh）を固定する。
// 各関数の出力の全文と、対応する MCP ツール名があり、pecot の起動形が無いことを確かめる。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import { runShell } from './_helpers/run.js'

const guidanceScript = path.resolve(import.meta.dirname, '../../../hooks/lib/core/mcp-guidance.sh')

// pecot の起動形: `pecot <語>`・`$PECOT`・`bin/pecot`。
const launcherForm = /(?<![\w-])pecot\s+[a-z]|\$PECOT|bin\/pecot/

const guidances = [
  { shellFunction: 'mcp_guidance_gh_pr_create', start: 'gh-pr-create-check: gh pr create is not allowed.', tools: ['pr_create'], text:
      'gh-pr-create-check: gh pr create is not allowed.\n\nReason: using gh pr create directly skips the automatic Issue reference, the PR template validation,\nand the traceability record, which breaks the consistency of the workflow.\n\nUse this instead:\n  the MCP tool pr_create of the workflow server\n' },
  { shellFunction: 'mcp_guidance_gh_issue_create', start: 'gh-issue-create-check: gh issue create is not allowed.', tools: ['issue_create', 'freeform: true'], text:
      'gh-issue-create-check: gh issue create is not allowed.\n\nReason: using gh issue create directly skips the automatic registration on the project board,\nthe status field settings, and the template validation, which breaks the consistency\nand traceability of the workflow.\n\nUse one of these instead:\n  the MCP tool issue_create with freeform: true  (free-form quick filing)\n  the MCP tool issue_create                      (from Markdown with frontmatter)\n' },
  { shellFunction: 'mcp_guidance_gh_stack', start: 'gh-stack-check: gh stack is not allowed', tools: ['pr_create', 'pr_merge'], text:
      'gh-stack-check: gh stack is not allowed (only gh stack view (use --json) and --help are).\n\nReason: running gh stack directly changes the stack without the workflow\'s records,\nthe Issue reference and the readiness checks, which breaks the consistency of the workflow.\n\nUse these instead:\n  the MCP tool pr_create of the workflow server  (open a PR, stacked when needed)\n  the MCP tool pr_merge of the workflow server   (merge a PR)\n  the MCP tool pr_restack of the workflow server (restack a stacked branch)\n' },
  { shellFunction: 'mcp_guidance_branch_delete', start: 'To delete a remote branch', tools: ['branch_delete', 'repo', 'branch'], text:
      'To delete a remote branch, use the MCP tool branch_delete of the workflow server with repo (owner/repo) and branch.\n' },
]

function guidanceOf(shellFunction: string): string {
  const result = runShell(createHookCase(), 'source "$1"; "$2"', [guidanceScript, shellFunction])
  expect(result.exitCode).toBe(0)
  return result.stdout
}

describe('mcp-guidance', () => {
  it.for(guidances)('$shellFunction は、$start で始まり、対応するツール名を案内する', ({ shellFunction, start, tools }) => {
    const text = guidanceOf(shellFunction)
    expect(text.startsWith(start)).toBe(true)
    for (const tool of tools) expect(text).toContain(tool)
  })

  it.for(guidances)('$shellFunction の出力は、決めた全文と一致する', ({ shellFunction, text }) => {
    expect(guidanceOf(shellFunction)).toBe(text)
  })

  it.for(guidances)('$shellFunction の出力に、pecot の起動形が無い', ({ shellFunction }) => {
    expect(guidanceOf(shellFunction)).not.toMatch(launcherForm)
  })

  it('起動形の検出は、元の案内文の形を拾う', () => {
    expect('/opt/plugin/bin/pecot branch delete <owner/repo> <branch>').toMatch(launcherForm)
    expect('Run `pecot issue quick` or `pecot issue create` first.').toMatch(launcherForm)
  })
})

// 移行後の案内文（hooks/lib/core/mcp-guidance.sh）を固定する。
// 各関数の出力の全文と、対応する MCP ツール名があり、pecot の起動形が無いことを確かめる。
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const guidanceScript = path.resolve(import.meta.dirname, '../../../hooks/lib/core/mcp-guidance.sh')

// pecot の起動形: `pecot <語>`・`$PECOT`・`bin/pecot`。
const launcherForm = /(?<![\w-])pecot\s+[a-z]|\$PECOT|bin\/pecot/

const guidances = [
  { shellFunction: 'mcp_guidance_gh_pr_create', start: 'gh-pr-create-check: gh pr create is not allowed.', tools: ['pr_create'], text:
      'gh-pr-create-check: gh pr create is not allowed.\n\nReason: using gh pr create directly skips the automatic Issue reference, the PR template validation,\nand the traceability record, which breaks the consistency of the workflow.\n\nUse this instead:\n  the MCP tool pr_create of the workflow server\n' },
  { shellFunction: 'mcp_guidance_gh_issue_create', start: 'gh-issue-create-check: gh issue create is not allowed.', tools: ['issue_quick', 'issue_create'], text:
      'gh-issue-create-check: gh issue create is not allowed.\n\nReason: using gh issue create directly skips the automatic registration on the project board,\nthe status/priority/size field settings, and the template validation, which breaks the consistency\nand traceability of the workflow.\n\nUse one of these instead:\n  the MCP tool issue_quick   (free-form quick filing)\n  the MCP tool issue_create  (from Markdown with frontmatter)\n' },
  { shellFunction: 'mcp_guidance_delete_branch', start: 'To delete a remote branch', tools: ['delete_branch', 'repo_ref', 'branch'], text:
      'To delete a remote branch, use the MCP tool delete_branch of the workflow server with repo_ref (owner/repo) and branch.\n' },
  { shellFunction: 'mcp_guidance_reminder_quick', start: 'Issue filing is not complete.', tools: ['issue_quick'], text:
      'Issue filing is not complete.\n\nComplete Step 1 of w-quick before moving on.\n  Call the MCP tool issue_quick with repo (owner/repo) and message (summary of the user instruction).\n\nThis reminder disappears automatically once filing succeeds.\n' },
  { shellFunction: 'mcp_guidance_reminder_ready', start: 'Subtask Issue filing is not complete.', tools: ['issue_create', 'prepare: true'], text:
      'Subtask Issue filing is not complete.\n\nComplete Step 4 of w-ready before moving on.\n  1. Call the MCP tool issue_create with prepare: true, template: task, and repo (owner/repo)\n\n  2. Edit the generated file (set title / parent_epic; repository is already set by repo)\n\n  3. Call the MCP tool issue_create with files (the file path)\n\nThis reminder disappears automatically once filing succeeds.\n' },
  { shellFunction: 'mcp_guidance_reminder_other', start: 'Issue filing is not complete.', tools: ['issue_quick', 'issue_create'], text:
      'Issue filing is not complete. Call the MCP tool issue_quick or issue_create first.\n' },
  { shellFunction: 'mcp_guidance_pr_merge', start: 'external-post-check: gh pr merge publishes a PR merge externally.', tools: ['pr_cleanup'], text:
      'external-post-check: gh pr merge publishes a PR merge externally.\n\nDo not run it until the user has explicitly approved.\nThe canonical route for merging is /pecot-w:w-merge.\nMerge with gh pr merge, then clean up with the MCP tool pr_cleanup.\n' },
  { shellFunction: 'mcp_guidance_post_ask_issue', start: 'external-post-check: the MCP tools issue_create / issue_quick', tools: ['issue_create', 'issue_quick', 'prepare: true'], text:
      'external-post-check: the MCP tools issue_create / issue_quick (a real post) publish an Issue externally.\n\nDo not call them until the user has explicitly approved.\nThe canonical routes for filing are these skills:\n/pecot-w:w-quick, /pecot-w:w-ready, /pecot-w:w-backlog, /pecot-w:w-issueize.\nTo only generate a template, call issue_create with prepare: true.\nThe tool issue_quick has no prepare.\n' },
  { shellFunction: 'mcp_guidance_post_ask_pr', start: 'external-post-check: the MCP tool pr_create', tools: ['pr_create', 'prepare: true', 'dry_run: true'], text:
      'external-post-check: the MCP tool pr_create (a real post) publishes a PR externally.\n\nDo not call it until the user has explicitly approved.\nTo only review the content, call pr_create with prepare: true (template generation) or dry_run: true.\n' },
]

function guidanceOf(shellFunction: string): string {
  const result = spawnSync('bash', ['-c', 'source "$1"; "$2"', '_', guidanceScript, shellFunction], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } })
  expect(result.status).toBe(0)
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
    expect('/opt/plugin/bin/pecot delete-branch <owner/repo> <branch>').toMatch(launcherForm)
    expect('Run `pecot issue quick` or `pecot issue create` first.').toMatch(launcherForm)
  })
})

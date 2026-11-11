// 移行後の案内文（hooks/lib/core/mcp-guidance.sh）を固定する。
// 各関数の出力に、対応する MCP ツール名があり、pecot の起動形が無いことを確かめる。
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const guidanceScript = path.resolve(import.meta.dirname, '../../../hooks/lib/core/mcp-guidance.sh')

// pecot の起動形: `pecot <語>`・`$PECOT`・`bin/pecot`。
const launcherForm = /(?<![\w-])pecot\s+[a-z]|\$PECOT|bin\/pecot/

const guidances = [
  { shellFunction: 'mcp_guidance_gh_pr_create', start: 'gh-pr-create-check: gh pr create is not allowed.', tools: ['pr_create'] },
  { shellFunction: 'mcp_guidance_gh_issue_create', start: 'gh-issue-create-check: gh issue create is not allowed.', tools: ['issue_quick', 'issue_create'] },
  { shellFunction: 'mcp_guidance_delete_branch', start: 'To delete a remote branch', tools: ['delete_branch', 'repo_ref', 'branch'] },
  { shellFunction: 'mcp_guidance_reminder_quick', start: 'Issue filing is not complete.', tools: ['issue_quick'] },
  { shellFunction: 'mcp_guidance_reminder_ready', start: 'Subtask Issue filing is not complete.', tools: ['issue_create', 'prepare: true'] },
  { shellFunction: 'mcp_guidance_reminder_other', start: 'Issue filing is not complete.', tools: ['issue_quick', 'issue_create'] },
  { shellFunction: 'mcp_guidance_pr_merge', start: 'external-post-check: gh pr merge publishes a PR merge externally.', tools: ['pr_cleanup'] },
  { shellFunction: 'mcp_guidance_plan_comment_update', start: 'Plan comment update:', tools: ['issue_comment'] },
]

function guidanceOf(shellFunction: string): string {
  const result = spawnSync('bash', ['-c', `source "${guidanceScript}"; ${shellFunction}`], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } })
  expect(result.status).toBe(0)
  return result.stdout
}

describe('mcp-guidance', () => {
  it.for(guidances)('$shellFunction は、$start で始まり、対応するツール名を案内する', ({ shellFunction, start, tools }) => {
    const text = guidanceOf(shellFunction)
    expect(text.startsWith(start)).toBe(true)
    for (const tool of tools) expect(text).toContain(tool)
  })

  it.for(guidances)('$shellFunction の出力に、pecot の起動形が無い', ({ shellFunction }) => {
    expect(guidanceOf(shellFunction)).not.toMatch(launcherForm)
  })

  it('起動形の検出は、元の案内文の形を拾う', () => {
    expect('/opt/plugin/bin/pecot delete-branch <owner/repo> <branch>').toMatch(launcherForm)
    expect('Run `pecot issue quick` or `pecot issue create` first.').toMatch(launcherForm)
  })
})

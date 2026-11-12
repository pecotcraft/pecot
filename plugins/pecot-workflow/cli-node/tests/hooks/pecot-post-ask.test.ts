// 投稿の ask（hooks/lib/mcp-handlers/pecot-post-ask.sh）を、MCP の入力 JSON で確かめる。
// エントリの pre-tool-use-mcp.sh から流し、ask の段を足しても deny と allow が変わらないことも確かめる。
import { describe, expect, it } from 'vitest'

import type { HookRun } from './_helpers/run-hook.js'
import { createProject, runHook, writeHooksConfig, writeStateFlag } from './_helpers/run-hook.js'

const forms = [
  { label: '接頭辞が長い形', prefix: 'mcp__plugin_pecot-w_pecot-workflow__' },
  { label: 'プラグインの外で登録した形', prefix: 'mcp__pecot-workflow__' },
  { label: '接頭辞が短い形', prefix: 'pecot-workflow-' },
]

// 対象の 3 ツールと、Bash の同じ操作・設定キー・スラッシュコマンド起点のフラグ。
const targets = [
  { tool: 'issue_create', bash: 'pecot issue create body.md', key: 'pecot-issue-create-ask', flag: 'issue-create-slash-pending' },
  { tool: 'issue_quick', bash: 'pecot issue quick -r o/r -m x', key: 'pecot-issue-create-ask', flag: 'issue-create-slash-pending' },
  { tool: 'pr_create', bash: 'pecot pr create body.md', key: 'pecot-pr-create-ask', flag: 'pr-create-slash-pending' },
]

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

// hookSpecificOutput の permissionDecision と permissionDecisionReason を取り出す。出力が空なら undefined。
function readDecision(run: Readonly<HookRun>): { readonly decision: unknown, readonly reason: unknown } | undefined {
  if (run.stdout === '') return undefined
  const parsed: unknown = JSON.parse(run.stdout)
  const output = isRecord(parsed) ? parsed['hookSpecificOutput'] : undefined
  return isRecord(output) ? { decision: output['permissionDecision'], reason: output['permissionDecisionReason'] } : undefined
}

function runEntry(projectDirectory: string, toolName: string, toolInput: unknown): HookRun {
  const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput })
  return runHook('pre-tool-use-mcp.sh', { projectDirectory, stdin })
}

// エントリを通した出力の permissionDecision。出力が空なら undefined。
function decisionOf(toolName: string, toolInput: unknown, project = createProject()): unknown {
  return readDecision(runEntry(project, toolName, toolInput))?.decision
}

// エントリを通した stdout。
function outputOf(toolName: string, toolInput: unknown, project = createProject()): string {
  return runEntry(project, toolName, toolInput).stdout
}

// Bash の同じ操作で external-post-check.sh が出す文（ask の理由）。
function bashReason(projectDirectory: string, command: string): string {
  const run = runHook('lib/core/external-post-check.sh', { projectDirectory, env: { HOOK_COMMAND: command, HOOK_WORKING_DIR: projectDirectory } })
  expect(run.status).toBe(11)
  return run.stdout.trimEnd()
}

describe.for(forms)('ツール名が$label', (form) => {
  describe.for(targets)('$tool', (target) => {
    const toolName = `${form.prefix}${target.tool}`

    it('入力に何も無いと、Bash の同じ操作と同じ文で ask を返す', () => {
      const project = createProject()
      const result = readDecision(runEntry(project, toolName, {}))
      expect(result?.decision).toBe('ask')
      expect(result?.reason).toBe(bashReason(project, target.bash))
    })

    // issue_quick の入力に prepare は無いので、素通しにしない。
    it.skipIf(target.tool === 'issue_quick')('prepare が true だと、素通しにする', () => {
      expect(outputOf(toolName, { prepare: true })).toBe('')
    })

    it.runIf(target.tool === 'issue_quick')('prepare が true でも、ask を返す', () => {
      expect(decisionOf(toolName, { prepare: true })).toBe('ask')
    })

    it('prepare が文字列の "true" だと、ask を返す', () => {
      expect(decisionOf(toolName, { prepare: 'true' })).toBe('ask')
    })

    it('prepare が false だと、ask を返す', () => {
      expect(decisionOf(toolName, { prepare: false })).toBe('ask')
    })

    it('tool_input が文字列で届くと、ask を返す', () => {
      expect(decisionOf(toolName, '{"prepare":true}')).toBe('ask')
    })

    it('スラッシュコマンド起点のフラグがあると、素通しにする', () => {
      const project = createProject()
      writeStateFlag(project, target.flag)
      expect(outputOf(toolName, {}, project)).toBe('')
    })

    it('別の種類のスラッシュコマンド起点のフラグだけでは、ask を返す', () => {
      const project = createProject()
      writeStateFlag(project, target.flag === 'pr-create-slash-pending' ? 'issue-create-slash-pending' : 'pr-create-slash-pending')
      expect(decisionOf(toolName, {}, project)).toBe('ask')
    })

    it('設定のキーが false だと、素通しにする', () => {
      const project = createProject()
      writeHooksConfig(project, { [target.key]: false })
      expect(outputOf(toolName, {}, project)).toBe('')
    })
  })

  it('pr_create は dry_run が true だと、素通しにする', () => {
    expect(outputOf(`${form.prefix}pr_create`, { dry_run: true })).toBe('')
  })

  it.for(['issue_create', 'issue_quick'])('%s は dry_run が true でも、ask を返す', (tool) => {
    expect(decisionOf(`${form.prefix}${tool}`, { dry_run: true })).toBe('ask')
  })

  it.for(['issue_read', 'pr_read', 'pr_cleanup', 'session_status'])('対象でない %s は、無出力にする', (tool) => {
    expect(outputOf(`${form.prefix}${tool}`, {})).toBe('')
  })

  it('一覧に無い名前は、対象の名前が続いていても無出力にする', () => {
    expect(outputOf(`${form.prefix}issue_create_extra`, {})).toBe('')
  })
})

describe('ツール名が一覧に無いとき', () => {
  it.for([
    'pecot-workflow-playwright-browser_click',
    'mcp__plugin_pecot-w_pecot-workflow-playwright__browser_click',
    'mcp__plugin_pecot-w_pecot-workflow-playwright__issue_create',
    'mcp__pecot-workflow-playwright__browser_click',
    'mcp__pecot-workflow-playwright__issue_create',
    'other-server-issue_create',
    'issue_create',
  ])('%s は、無出力にする', (toolName) => {
    expect(outputOf(toolName, {})).toBe('')
  })
})

describe('ask の段を足した後の mcp-dispatcher', () => {
  it('GitHub の PR 作成は、deny のまま', () => {
    expect(decisionOf('mcp__github__create_pull_request', {})).toBe('deny')
  })

  it.for(['resolve-library-id', 'query-docs'])('context7 の %s は、allow のまま', (tool) => {
    expect(decisionOf(`mcp__plugin_pecot-w_context7__${tool}`, {})).toBe('allow')
  })
})

// スキル・エージェント・hooks のテンプレートの本文に出るツール名が、COMMANDS に実在することを確かめる。
// あわせて、`pecot <サブコマンド>` の書き方（R-19）が本文に残らないことを確かめる。
import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../../src/commands/registry.js'
import { readDocuments, toolInputs } from './_helpers/documents.js'

// 利用者が端末で打つコマンドの説明として、本文に残してよい `pecot <サブコマンド>`。
// 書式は `<プラグインからの相対パス>:<行>`。いまは該当する箇所が無い。
const TERMINAL_COMMANDS: readonly string[] = []

// ツール名に似るが、入力の値や概念を指す語
const NOT_TOOLS: ReadonlySet<string> = new Set(['release_type', 'release_branch', 'issue_number', 'session_id'])

const TOOL_LIKE = /\b(?:(?:issue|pr|project|session|worktree|release|security|dependabot)_[a-z_]+|add_to_project|update_issue_status|create_branch|delete_branch)\b/gu
const CLI_FORM = /\bpecot"? +(?:issue|pr|project|session|worktree|release|security|dependabot|add-to-project|update-issue-status|create-branch|delete-branch)\b/u
const PREFIXED = /mcp__plugin_pecot-w_pecot-workflow__([a-z_]+)/gu

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

describe('本文のツール名', () => {
  const tools = toolInputs()
  const inputNames = new Set<string>()
  for (const names of tools.values()) for (const name of names) inputNames.add(name)
  const documents = readDocuments()

  it('読む本文が 1 件以上ある', () => {
    expect(documents.length).toBeGreaterThan(30)
  })

  it('ツール名らしい語は、COMMANDS のツール名・入力名、またはツールでない語の一覧のどれかにある', () => {
    const unknown: string[] = []
    for (const { file, text } of documents) {
      for (const match of text.matchAll(TOOL_LIKE)) {
        const word = match[0]
        if (!tools.has(word) && !inputNames.has(word) && !NOT_TOOLS.has(word)) unknown.push(`${file}:${String(lineNumberAt(text, match.index))} ${word}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it('ツールでない語の一覧は、どれも本文のどこかに出る', () => {
    const joined = documents.map(({ text }) => text).join('\n')
    const unused = [...NOT_TOOLS].filter(word => !joined.includes(word))
    expect(unused).toEqual([])
  })

  it('接頭辞付きの名前は、実在するツールを指す', () => {
    const unknown: string[] = []
    for (const { file, text } of documents) {
      for (const match of text.matchAll(PREFIXED)) {
        if (!tools.has(match[1] ?? '')) unknown.push(`${file} ${match[0]}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it('接頭辞付きの名前は、スキルの frontmatter の allowed-tools にだけ書く', () => {
    const outside = documents.filter(({ text }) => {
      const body = text.replace(/^---\n[\s\S]*?\n---\n/u, '')
      return body.includes('mcp__plugin_pecot-w_pecot-workflow__') || body.includes('pecot-workflow-')
    }).map(({ file }) => file)
    expect(outside).toEqual([])
  })

  it('w-pr の allowed-tools は、pr_preflight と pr_create を許す', () => {
    const skill = documents.find(({ file }) => file === 'skills/w-pr/SKILL.md')
    expect(skill?.text).toContain('mcp__plugin_pecot-w_pecot-workflow__pr_preflight')
    expect(skill?.text).toContain('mcp__plugin_pecot-w_pecot-workflow__pr_create')
  })

  it('COMMANDS の全ツールの名前が、重ならない', () => {
    const names = COMMANDS.map(command => command.toolName)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('`pecot <サブコマンド>` の残り（R-19）', () => {
  it('残りは、端末で打つコマンドとして許した箇所の一覧と一致する', () => {
    const residual: string[] = []
    for (const { file, text } of readDocuments()) {
      for (const [index, line] of text.split('\n').entries()) {
        if (CLI_FORM.test(line)) residual.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(residual).toEqual(TERMINAL_COMMANDS)
  })
})

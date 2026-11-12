// 本文に書かれたツールの呼び出しを、COMMANDS の定義と比べる。
// - 呼び出しの入力名が、そのツールの入力に実在する
// - w-help の commands.md に、COMMANDS の全コマンドが載っている
// - w-release の release-multi.md が、project_info の `package:` 行の形式を使う
import { describe, expect, it } from 'vitest'

import { COMMANDS } from '../../src/commands/registry.js'
import { infoMarkdown } from '../../src/commands/project-info.js'
import { parseProjectConfig } from '../../src/domain/config.js'
import { readDocuments, readPluginFile, toolInputs } from './_helpers/documents.js'

interface Call {
  readonly line: number
  readonly tool: string
  readonly input: string
}

const INLINE_TOOL = /^`([a-z][a-z_]*)`$/u
const INLINE_INPUT = /^`([a-z][a-z_]*): (?:"|true\b|false\b|\[)[^`]*`$/u
const FENCE = /^(`{3,}|~{3,})/u
const BLOCK_INPUT = /^ {2}([a-z][a-z_]*):/u
// 実数 158 件に近い下限（95% 程度の切りのよい数）。実数が大きく増えたら引き上げる
const COUNT_FLOOR = 150

/**
本文から、ツールの呼び出しの入力名を集める。
インラインは「同じ段落で直前に出たツール名」への入力、`text` のブロックは「先頭行のツール名」への入力として数える
*/
function collectCalls(text: string, tools: ReadonlySet<string>): readonly Call[] {
  return scan(text, tools).calls
}

interface Scan {
  readonly calls: readonly Call[]
  // 文書の終わりで閉じていないコードフェンスの開始行
  readonly unclosedFence: number | undefined
}

function scan(text: string, tools: ReadonlySet<string>): Scan {
  const calls: Call[] = []
  let openedAt = 0
  let current: string | undefined
  let blockTool: string | undefined
  let opener: string | undefined
  for (const [index, line] of text.split('\n').entries()) {
    const fence = FENCE.exec(line)?.[1]
    const rest = fence === undefined ? '' : line.slice(fence.length)
    if (opener !== undefined) {
      if (fence?.startsWith(opener) === true && rest.trim() === '') {
        opener = undefined
        blockTool = undefined
        continue
      }
      if (blockTool === undefined && tools.has(line.trim())) blockTool = line.trim()
      else if (blockTool !== undefined) {
        const input = BLOCK_INPUT.exec(line)?.[1]
        if (input !== undefined) calls.push({ line: index + 1, tool: blockTool, input })
      }
      continue
    }
    if (fence !== undefined) {
      opener = fence
      openedAt = index + 1
      continue
    }
    // 空行と見出しで、直前のツール名を忘れる。段落をまたいだ入力を、別のツールのものにしないため
    if (line.trim() === '' || line.startsWith('#')) current = undefined
    for (const match of line.matchAll(/`[^`]+`/gu)) {
      const tool = INLINE_TOOL.exec(match[0])?.[1]
      if (tool !== undefined && tools.has(tool)) current = tool
      const input = INLINE_INPUT.exec(match[0])?.[1]
      if (input !== undefined && current !== undefined) calls.push({ line: index + 1, tool: current, input })
    }
  }
  return { calls, unclosedFence: opener === undefined ? undefined : openedAt }
}

function invalidCalls(text: string, file: string): readonly string[] {
  const inputs = toolInputs()
  return collectCalls(text, new Set(inputs.keys()))
    .filter(call => inputs.get(call.tool)?.has(call.input) !== true)
    .map(call => `${file}:${String(call.line)} ${call.tool} に入力 ${call.input} が無い`)
}

describe('本文のツールの呼び出し', () => {
  it('入力名が、そのツールの入力に実在する', () => {
    const invalid = readDocuments().flatMap(({ file, text }) => invalidCalls(text, file))
    expect(invalid).toEqual([])
  })

  it('呼び出しを 150 件以上拾う（拾えない呼び出しがあれば失敗する）', () => {
    const tools = new Set(toolInputs().keys())
    const count = readDocuments().reduce((sum, { text }) => sum + collectCalls(text, tools).length, 0)
    expect(count).toBeGreaterThanOrEqual(COUNT_FLOOR)
  })

  it('コードフェンスが開いたまま終わる文書は無い', () => {
    const tools = new Set(toolInputs().keys())
    const unclosed = readDocuments()
      .map(({ file, text }) => ({ file, line: scan(text, tools).unclosedFence }))
      .filter(({ line }) => line !== undefined)
      .map(({ file, line }) => `${file}:${String(line)}`)
    expect(unclosed).toEqual([])
  })

  it('コードフェンスが開いたまま終わる見本の文書を検出する', () => {
    const text = ['```text', 'pr_create', '  title: "t"'].join('\n')
    expect(scan(text, new Set(['pr_create'])).unclosedFence).toBe(1)
    expect(scan(['```text', 'x', '```'].join('\n'), new Set()).unclosedFence).toBeUndefined()
  })

  it('存在しない入力名を書いたインラインの呼び出しを検出する', () => {
    const text = '`pr_create` を `no_such_input: "x"` で呼ぶ'
    expect(invalidCalls(text, 'sample.md')).toEqual(['sample.md:1 pr_create に入力 no_such_input が無い'])
  })

  it('存在しない入力名を書いた text ブロックの呼び出しを検出する', () => {
    const text = ['```text', 'pr_create', '  no_such_input: "x"', '  title: "t"', '```'].join('\n')
    expect(invalidCalls(text, 'sample.md')).toEqual(['sample.md:3 pr_create に入力 no_such_input が無い'])
  })

  it('ブロックの閉じフェンスより後の行は、呼び出しに数えない', () => {
    const text = ['```text', 'pr_create', '```', '  no_such_input: "x"'].join('\n')
    expect(invalidCalls(text, 'sample.md')).toEqual([])
  })

  it('ブロックの中で、message の本文の深い字下げは入力に数えない', () => {
    const text = ['```text', 'pr_create', '  message: |', '    summary: x', '```'].join('\n')
    expect(invalidCalls(text, 'sample.md')).toEqual([])
  })
})

describe('commands.md', () => {
  it('COMMANDS の全コマンドが載っている', () => {
    const document = readPluginFile('skills/w-help/references/commands.md')
    const missing = COMMANDS.map(command => command.path.join(' ')).filter(path => !document.includes(`\`${path}\``))
    expect(missing).toEqual([])
  })
})

describe('release-multi.md', () => {
  it('project_info が出す package 行の形式を使う', () => {
    const config = parseProjectConfig({
      host: 'github.com',
      owner: 'demo',
      workflow_suffix: 'x',
      project: { number: 1, id: 'P', fields: { workflow: { id: 'F', options: {} } } },
      repositories: [{ owner: 'demo', name: 'repo', packages: [{ name: 'demo-pkg', changelog: 'packages/demo-pkg/CHANGELOG.md' }] }],
    })
    const statuses = [{ enabled: false, openCount: 0, maxSeverity: undefined, alertsUrl: 'https://example.invalid/alerts', openAlerts: [] }]
    const output = infoMarkdown({ config, projectName: 'demo', statuses }, undefined, '')
    const line = output.split('\n').find(candidate => candidate.includes('package:'))
    expect(line?.trim()).toBe('package: demo-pkg → packages/demo-pkg/CHANGELOG.md')
    expect(readPluginFile('skills/w-release/references/release-multi.md')).toContain('`package: NAME → CHANGELOG パス`')
  })
})

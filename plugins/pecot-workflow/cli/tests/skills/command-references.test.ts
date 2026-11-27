// 本文に書かれたツールの呼び出しを、TOOLS の定義と比べる。
// - 呼び出しの入力名が、そのツールの入力に実在する
// - w-help の commands.md に、TOOLS の全ツールが載っている
// - w-release の release-multi.md が、board_show の repositories の packages の項目名で読む
import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { TOOLS } from '../../src/commands/registry.js'
import { boardShowData, boardShowResult } from '@pecot/workflow-core/commands-shared/board-view.js'
import { parseProjectConfig } from '@pecot/workflow-core/domain/config.js'
import { TEMPLATE_RESOURCES, templateUri } from '../../src/mcp/templates.js'
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
// 実数 89 件に近い下限（95% 程度の切りのよい数）。実数が大きく増えたら引き上げる
const COUNT_FLOOR = 85
const TEMPLATE_URI = /pecot-template:\/\/[a-z]+\/[a-z-]+/gu

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
  it('入力名が、そのツールの入力に実在する', async () => {
    await explains('スキルなどの本文に書かれたツール呼び出しのテストです。本文のインラインの記述と `text` ブロックに書かれた入力名が、そのツールの入力としてすべて存在することを確認します。')
    const invalid = readDocuments().flatMap(({ file, text }) => invalidCalls(text, file))
    expect(invalid).toEqual([])
  })

  it('本文に書いたテンプレートの resource の URI は、サーバが提供する resource に存在する', async () => {
    await explains('本文に書かれたテンプレートの URI のテストです。`pecot-template://` で始まる URI が 1 件以上あり、すべてサーバが提供する resource に存在することを確認します。')
    const known = new Set(TEMPLATE_RESOURCES.map(template => templateUri(template)))
    const references = readDocuments().flatMap(({ file, text }) => (text.match(TEMPLATE_URI) ?? []).map(uri => ({ file, uri })))
    expect(references.length).toBeGreaterThan(0)
    expect(references.filter(({ uri }) => !known.has(uri)).map(({ file, uri }) => `${file} ${uri}`)).toEqual([])
  })

  it('本文から 85 件以上のツール呼び出しを抽出できる', async () => {
    await explains('ツール呼び出しの抽出のテストです。本文から抽出できる呼び出しが 85 件以上あることを確認します。')
    const tools = new Set(toolInputs().keys())
    const count = readDocuments().reduce((sum, { text }) => sum + collectCalls(text, tools).length, 0)
    expect(count).toBeGreaterThanOrEqual(COUNT_FLOOR)
  })

  it('閉じていないコードフェンスを持つ文書が存在しない', async () => {
    await explains('本文のコードフェンスのテストです。どの文書にも、閉じずに終わるコードフェンスが存在しないことを確認します。')
    const tools = new Set(toolInputs().keys())
    const unclosed = readDocuments()
      .map(({ file, text }) => ({ file, line: scan(text, tools).unclosedFence }))
      .filter(({ line }) => line !== undefined)
      .map(({ file, line }) => `${file}:${String(line)}`)
    expect(unclosed).toEqual([])
  })

  it('閉じていないコードフェンスを持つ見本の文書から、開始行を検出する', async () => {
    await explains('閉じていないコードフェンスの検出処理のテストです。閉じていない見本では開始行（1 行目）を返し、閉じている見本では `undefined` を返すことを確認します。')
    const text = ['```text', 'pr_create', '  title: "t"'].join('\n')
    expect(scan(text, new Set(['pr_create'])).unclosedFence).toBe(1)
    expect(scan(['```text', 'x', '```'].join('\n'), new Set()).unclosedFence).toBeUndefined()
  })

  it('存在しない入力名を書いたインラインの呼び出しを検出する', async () => {
    await explains('インラインの呼び出しの検証処理のテストです。`pr_create` に存在しない入力名 `no_such_input` を渡した記述が、行番号つきの違反として報告されることを確認します。')
    const text = '`pr_create` を `no_such_input: "x"` で呼ぶ'
    expect(invalidCalls(text, 'sample.md')).toEqual(['sample.md:1 pr_create に入力 no_such_input が無い'])
  })

  it('存在しない入力名を書いた text ブロックの呼び出しを検出する', async () => {
    await explains('`text` ブロックの呼び出しの検証処理のテストです。`pr_create` のブロックに存在しない入力名を書いた行が、行番号つきの違反として報告されることを確認します。')
    const text = ['```text', 'pr_create', '  no_such_input: "x"', '  title: "t"', '```'].join('\n')
    expect(invalidCalls(text, 'sample.md')).toEqual(['sample.md:3 pr_create に入力 no_such_input が無い'])
  })

  it('ブロックの閉じフェンスより後の行は、呼び出しとして扱わない', async () => {
    await explains('`text` ブロックの終わりの判定のテストです。閉じフェンスより後に書かれた入力名は、呼び出しの入力として扱われず、違反にならないことを確認します。')
    const text = ['```text', 'pr_create', '```', '  no_such_input: "x"'].join('\n')
    expect(invalidCalls(text, 'sample.md')).toEqual([])
  })

  it('ブロックの中で、message の本文の深い字下げは入力として扱わない', async () => {
    await explains('`message` の本文の扱いのテストです。`message: |` の下に深く字下げして書かれた行は、入力名として扱われず、違反にならないことを確認します。')
    const text = ['```text', 'pr_create', '  message: |', '    summary: x', '```'].join('\n')
    expect(invalidCalls(text, 'sample.md')).toEqual([])
  })
})

describe('commands.md', () => {
  it('commands.md に TOOLS の全ツールが記載されている', async () => {
    await explains('w-help の `commands.md` のテストです。`TOOLS` に登録されたすべてのツールの名前が、バッククォートで囲んで記載されていることを確認します。')
    const document = readPluginFile('skills/w-help/references/commands.md')
    const missing = TOOLS.map(tool => tool.name).filter(name => !document.includes(`\`${name}\``))
    expect(missing).toEqual([])
  })
})

describe('release-multi.md', () => {
  it('release-multi.md は、対象リポジトリの package の一覧から package を選ぶ書き方になっている', async () => {
    await explains('w-release の `release-multi.md` のテストです。`board_show` の結果の `repositories` に含まれる `packages` の項目名で読む記述があり、古い `package: NAME` の書き方が含まれないことを確認します。')
    const config = parseProjectConfig({
      host: 'github.com',
      owner: 'demo',
      workflow_suffix: 'x',
      project: { number: 1, id: 'P', fields: { workflow: { id: 'F', options: {} } } },
      repositories: [{ owner: 'demo', name: 'repo', packages: [{ name: 'demo-pkg', changelog: 'packages/demo-pkg/CHANGELOG.md' }] }],
    })
    const statuses = [{ enabled: false, openCount: 0, maxSeverity: undefined, alertsUrl: 'https://example.invalid/alerts', openAlerts: [] }]
    const view = { config, projectName: 'demo', statuses }
    const data = boardShowResult(view, boardShowData(view, []), 0)
    expect(data.repositories.map(repository => [repository.full_name, repository.packages])).toEqual([
      ['demo/repo', [{ name: 'demo-pkg', changelog: 'packages/demo-pkg/CHANGELOG.md' }]],
    ])
    const document = readPluginFile('skills/w-release/references/release-multi.md')
    expect(document).toContain('対象リポの package の一覧から、対象の package 名を選ぶ')
    expect(document).toContain('選んだ要素の `packages` のうち、`name` が `<package>` の要素の `changelog` のファイルを編集する')
    expect(document).not.toContain('package: NAME')
  })
})

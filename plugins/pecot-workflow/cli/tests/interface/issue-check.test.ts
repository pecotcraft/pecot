import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ISSUE_CHECK_COMMANDS } from '../../src/commands/issue-check.js'
import { useIsolatedEnvironment } from '../../src/tests/_helpers/environment.js'
import { writeTree } from '../../src/tests/_helpers/temporary.js'
import { runInProcess, startGithub } from '../_helpers/interface-case.js'
import type { CliResult, RunningGithub } from '../_helpers/interface-case.js'
import {
  blockedBySupported,
  blockedByUnsupported,
  issueNodeId,
  linkedRepositories,
  parentEpic,
  rawFrontmatterFile,
  setUpIssueProject,
  subIssuesPage,
} from '../_helpers/issue-create-case.js'
import { definitionRules } from '../_helpers/attributes.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { verifies } from '../_helpers/verifies.js'

useIsolatedEnvironment()

async function check(...argv: readonly string[]): Promise<CliResult> {
  return await runInProcess(['issue', 'check', ...argv], ISSUE_CHECK_COMMANDS)
}

async function checkTool(argumentsOfTool: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await callToolOnce(ISSUE_CHECK_COMMANDS, 'issue_check', argumentsOfTool)
}

// 親 Epic #3 に #3-02 がある
const EXISTING_SUB_ISSUE = { number: 9, state: 'OPEN', title: '#3-02: 先の子' }

const PARENT = 'parent_epic: acme/demo/3'

function taskFile(title: string, ...extra: readonly string[]): string {
  return rawFrontmatterFile(['type: task', 'repository: acme/demo', `title: ${title}`, ...extra])
}

function blockedBy(...entries: readonly string[]): string[] {
  return ['blocked_by:', ...entries.map(entry => `  - issue: ${entry}`)]
}

function inRoot(root: string, ...names: readonly string[]): string[] {
  return names.map(name => path.join(root, name))
}

function operations(github: RunningGithub): string[] {
  return github.requests().map(request => request.type === 'rest' ? request.method : request.operation)
}

// 書き込みの操作。issue check は 1 つも送らない
function writes(github: RunningGithub): string[] {
  return operations(github).filter(operation => operation === 'POST' || operation === 'PATCH' || /^(?:Add|Update|Create)/u.test(operation))
}

describe('issue check', () => {
  it('ファイルを渡すと、何も作らずに番号・前提・進め方の表とスタックできる並びを標準出力に出す', async (context) => {
    await verifies(context, 'PW-ISSUE-CHECK-01')
    const project = setUpIssueProject()
    writeTree(project.root, {
      'a.md': taskFile('先頭', PARENT),
      'b.md': taskFile('2 番目', PARENT, ...blockedBy('a')),
      'c.md': taskFile('3 番目', PARENT, ...blockedBy('b')),
      'd.md': taskFile('4 番目', PARENT, 'blocked_by:', '  - issue: c', '    wait: merge', '    reason: 既定のブランチから配られる'),
    })
    const github = await startGithub([linkedRepositories(), blockedBySupported(), parentEpic(3, [EXISTING_SUB_ISSUE])])

    const result = await check(...inRoot(project.root, 'a.md', 'b.md', 'c.md', 'd.md'))

    expect(result).toEqual({
      code: 0,
      stderr: '',
      stdout: [
        'Plan:',
        '| File | Number | Blocked by | Approach |',
        '|---|---|---|---|',
        '| a | 3 | - | alone |',
        '| b | 4 | a | stack on a |',
        '| c | 5 | b | stack on b |',
        '| d | 6 | c (merge) | wait for merge of c |',
        '',
        'Stackable chains:',
        '- a -> b -> c',
        '',
      ].join('\n'),
    })
    expect(operations(github)).toEqual(['GetLinkedRepositoriesUser', 'HasAddBlockedByInput', 'GetIssueSlim'])
  })

  it('既存の Issue の表記は、一括の先頭のファイルのリポジトリを基準にそろえる', async (context) => {
    await verifies(context, 'PW-ISSUE-CHECK-01')
    const project = setUpIssueProject({ otherRepositories: ['other'] })
    writeTree(project.root, {
      'a.md': taskFile('先頭', ...blockedBy('acme/demo/12')),
      'b.md': rawFrontmatterFile(['type: task', 'repository: acme/other', 'title: 別のリポ', ...blockedBy('acme/demo/12')]),
      'c.md': taskFile('最後', ...blockedBy('acme/other/7')),
    })
    const github = await startGithub([linkedRepositories(1, ['demo', 'other']), blockedBySupported(), issueNodeId(12), issueNodeId(7, 1, 'other')])

    const result = await check(...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

    expect(result.code).toBe(0)
    expect(result.stdout).toBe([
      'Plan:',
      '| File | Number | Blocked by | Approach |',
      '|---|---|---|---|',
      '| a | - | #12 | stack on #12 |',
      '| b | - | #12 | stack on #12 |',
      '| c | - | acme/other#7 | stack on acme/other#7 |',
      '',
      'Stackable chains:',
      '- #12 -> a',
      '- #12 -> b',
      '- acme/other#7 -> c',
      '',
    ].join('\n'))
    expect(writes(github)).toEqual([])
  })

  it('親 Epic のサブ Issue が複数のページにわたっても、全ページの最大の次の番号を表に出す', async (context) => {
    await verifies(context, 'PW-ISSUE-CHECK-01')
    const project = setUpIssueProject()
    writeTree(project.root, { 'a.md': taskFile('先頭', PARENT) })
    await startGithub([
      linkedRepositories(),
      parentEpic(3, [EXISTING_SUB_ISSUE], 1, 'cursor1'),
      subIssuesPage([{ number: 30, state: 'OPEN', title: '#3-21: 2 ページ目の子' }]),
    ])

    const result = await check(path.join(project.root, 'a.md'))

    expect(result).toEqual({ code: 0, stderr: '', stdout: 'Plan:\n| File | Number | Blocked by | Approach |\n|---|---|---|---|\n| a | 22 | - | alone |\n' })
  })

  it('ボードに Blocked の列が無いとき、これからの動きとして warning を 1 回だけ出す', async (context) => {
    await verifies(context, 'PW-ISSUE-CHECK-01')
    const project = setUpIssueProject({ withoutBlockedColumn: true })
    writeTree(project.root, {
      'a.md': taskFile('先頭'),
      'b.md': taskFile('次', ...blockedBy('a')),
      'c.md': taskFile('最後', ...blockedBy('b')),
    })
    await startGithub([linkedRepositories(), blockedBySupported()])

    const result = await check(...inRoot(project.root, 'a.md', 'b.md', 'c.md'))

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('warning: the board has no Blocked column; Issues with blocked-by will be created in Ready\n')
  })

  it.for([
    { name: '前提が一括のどのファイルのキーにも当たらない', second: blockedBy('nope'), first: [], expected: 'error: blocked_by in b.md refers to unknown key nope\n' },
    { name: '前提が輪になる', second: blockedBy('a'), first: blockedBy('b'), expected: 'error: blocked_by forms a cycle: a -> b -> a\n' },
    { name: '前提が後ろのファイルを指す', second: [], first: blockedBy('b'), expected: 'error: blocked_by in a.md refers to b, which comes later\n' },
    { name: '同じ前提を 2 回書く', second: [...blockedBy('a'), '  - issue: a'], first: [], expected: 'error: blocked_by in b.md refers to a more than once\n' },
    { name: 'parallel を書く', second: ['parallel: true'], first: [], expected: 'error: parallel is no longer supported in b.md. Remove it\n' },
    { name: 'wait: merge に reason が無い', second: ['blocked_by:', '  - issue: a', '    wait: merge'], first: [], expected: 'error: blocked_by in b.md needs reason for wait: merge\n' },
  ])('$name とき、終了コード 1 で終わる', async (row, context) => {
    await verifies(context, 'PW-ISSUE-CHECK-02')
    const project = setUpIssueProject()
    writeTree(project.root, {
      'a.md': taskFile('先頭', ...row.first),
      'b.md': taskFile('次', ...row.second),
    })

    const result = await check(...inRoot(project.root, 'a.md', 'b.md'))

    expect(result).toEqual({ code: 1, stdout: '', stderr: row.expected })
  })

  it('依存関係に対応しないサーバで blocked_by を書いたとき、error を出して終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-CHECK-02')
    const project = setUpIssueProject()
    writeTree(project.root, { 'a.md': taskFile('先頭'), 'b.md': taskFile('次', ...blockedBy('a')) })
    const github = await startGithub([linkedRepositories(), blockedByUnsupported()])

    const result = await check(...inRoot(project.root, 'a.md', 'b.md'))

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'error: this GitHub Enterprise Server does not support issue dependencies (blockedBy); version 3.19 or later is required\n',
    })
    expect(operations(github)).toEqual(['GetLinkedRepositoriesUser', 'HasAddBlockedByInput'])
  })

  it('フロントマターの attributes の値が定義に合わないとき、合わない値ごとに error の行を出し、終了コード 1 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-CHECK-04')
    const project = setUpIssueProject()
    writeTree(project.root, { 'a.md': taskFile('先頭', 'attributes:', '  - name: Area', '    value: web', '  - name: Effort', '    value: big') })
    const github = await startGithub([linkedRepositories(), ...definitionRules()])

    const result = await check(...inRoot(project.root, 'a.md'))

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: a\.md: invalid_value: Area \(project\); value "web"; expected .+\nerror: a\.md: invalid_value: Effort \(issue_field\); value "big"; expected .+\nerror: did not create any Issue: /u)
    expect(writes(github)).toEqual([])
  })

  it('ファイルの引数が無いとき、終了コード 2 で終わる', async (context) => {
    await verifies(context, 'PW-ISSUE-CHECK-03')
    setUpIssueProject()

    const result = await check()

    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
  })

  describe('MCP の data', () => {
    it('ファイルを渡すと、進め方の表の行とスタックできる並びを data に返す', async () => {
      const project = setUpIssueProject()
      writeTree(project.root, {
        'a.md': taskFile('先頭', PARENT),
        'b.md': taskFile('2 番目', PARENT, ...blockedBy('a')),
        'c.md': taskFile('3 番目', PARENT, 'blocked_by:', '  - issue: b', '    wait: merge', '    reason: 配られてから', '  - issue: acme/demo/12'),
      })
      await startGithub([linkedRepositories(), blockedBySupported(), parentEpic(3, [EXISTING_SUB_ISSUE]), issueNodeId(12)])

      const outcome = await checkTool({ files: inRoot(project.root, 'a.md', 'b.md', 'c.md') })

      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        plan: [
          { file: 'a', order: 3, blockedBy: [], approach: 'alone' },
          { file: 'b', order: 4, blockedBy: [{ issue: 'a', wait: 'stack' }], approach: 'stack', stackOn: 'a' },
          { file: 'c', order: 5, blockedBy: [{ issue: 'b', wait: 'merge' }, { issue: '#12', wait: 'stack' }], approach: 'wait-merge' },
        ],
        stackableChains: [['a', 'b']],
      })
    })

    it('files が空なら、invalid-input を返す', async () => {
      setUpIssueProject()

      const outcome = await checkTool({ files: [] })

      expect(outcome).toMatchObject({ isError: true, structured: { kind: 'invalid-input' } })
    })
  })
})

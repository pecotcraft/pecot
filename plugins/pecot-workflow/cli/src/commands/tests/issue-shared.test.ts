// issue 系のコマンドの共有関数のテスト。GitHub は偽サーバにする。期待値は cli/tests/cli/test_issue.py と同じ。
import { describe, expect, it } from 'vitest'

import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import { createIssueReference } from '../../domain/reference-parser.js'
import { createRepositoryReference } from '../../domain/repository-resolver.js'
import { graphqlData, graphqlError, rejection, restResponse, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import '../registry.js'
import {
  buildIssueTitle,
  checkDuplicateOrder,
  createIssueOrExit,
  exitInvalidStatus,
  linkToParentEpic,
  normalizeParentEpicCli,
  parseIssueReferenceOrExit,
  resolveEpicTargetRepository,
  resolveParentEpicReference,
  runWithExit,
  validateIssueTemplate,
  validateStatusForType,
  warnEpicRepositoryException,
} from '../issue-shared.js'
import { CommandExit } from '../command-definition.js'
import { createOutput } from '../output.js'
import { UsageError } from '../usage-error.js'
import { capture } from './support.js'
import type { CapturedIo } from './support.js'
import { JSON_NULL } from '../../domain/json-null.js'

useFakeGithub()

function config(aggregation?: string): ProjectConfig {
  return parseProjectConfig({
    host: 'github.com',
    owner: 'o',
    workflow_suffix: 'o',
    ...(aggregation !== undefined && { aggregation_repo: aggregation }),
    project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'F_workflow', options: { backlog: 'O_b' } } } },
  })
}

function started(): { readonly io: CapturedIo, readonly output: ReturnType<typeof createOutput> } {
  const io = capture()
  return { io, output: createOutput(false, io) }
}

async function succeed(): Promise<void> {
  await Promise.resolve()
}

async function exitWith3(): Promise<void> {
  await Promise.resolve()
  throw new CommandExit(3)
}

async function badParameter(): Promise<void> {
  await Promise.resolve()
  resolveParentEpicReference('nope', config(), 'o', 'impl')
}

async function boom(): Promise<void> {
  await Promise.resolve()
  throw new TypeError('boom')
}

describe('runWithExit', () => {
  it('本体が終われば 0 を返す', async () => {
    expect(await runWithExit(succeed)).toBe(0)
  })

  it('CommandExit は、終了コードを持ったまま伝える', async () => {
    await expect(runWithExit(exitWith3)).rejects.toMatchObject({ exitCode: 3 })
  })

  it('BadParameterError は context 無しの UsageError にして伝える', async () => {
    const error = await rejection(runWithExit(badParameter))
    expect(error).toBeInstanceOf(UsageError)
    expect(error).toMatchObject({ context: undefined })
    expect(error instanceof Error ? error.message : '').toMatch(/^Invalid value: could not resolve parent_epic: /u)
  })

  it('ほかの例外はそのまま伝える', async () => {
    await expect(runWithExit(boom)).rejects.toThrow('boom')
    expect(new CommandExit(2).exitCode).toBe(2)
  })
})

const prefixRows: readonly (readonly [string, string, string])[] = [
  ['task', 'タイトル', '[Task] タイトル'],
  ['task', '[Task] タイトル', '[Task] タイトル'],
  ['bug', 'x', '[Bug] x'],
  ['unknown', 'x', 'x'],
]

describe('buildIssueTitle', () => {
  it.for(prefixRows)('接頭辞を付ける %j', ([issueType, title, expected]) => {
    expect(buildIssueTitle(issueType, title)).toBe(expected)
  })

  it('Epic 番号と order があれば `#epic-order` を付ける', () => {
    expect(buildIssueTitle('task', 'タイトル', { parentEpic: 353, order: 1 })).toBe('[Task] #353-01: タイトル')
    expect(buildIssueTitle('task', '[Task] タイトル', { parentEpic: 353, order: 12 })).toBe('[Task] #353-12: タイトル')
  })

  it('接頭辞の無い型は番号だけを付ける', () => {
    expect(buildIssueTitle('unknown', 'タイトル', { parentEpic: 50, order: 1 })).toBe('#50-01: タイトル')
  })

  it('order は 2 桁にして付ける', () => {
    expect(buildIssueTitle('task', 'タイトル', { parentEpic: 189, order: 4 })).toBe('[Task] #189-04: タイトル')
    expect(buildIssueTitle('task', 'タイトル', { parentEpic: 189, order: 10 })).toBe('[Task] #189-10: タイトル')
  })
})

const parentEpicRows: readonly (readonly [string | undefined, number | string | undefined])[] = [
  [undefined, undefined],
  ['  ', undefined],
  [' 353 ', 353],
  ['o/r/353', 'o/r/353'],
  ['9007199254740991', 9_007_199_254_740_991],
  ['9007199254740993', '9007199254740993'],
  ['  000012345678901234567890 ', '12345678901234567890'],
  ['1000000000000000000000', '1000000000000000000000'],
]

describe('normalizeParentEpicCli', () => {
  it.for(parentEpicRows)('CLI の入力 %j を整える', ([raw, expected]) => {
    expect(normalizeParentEpicCli(raw)).toBe(expected)
  })
})

describe('resolveParentEpicReference', () => {
  it('整数は aggregation_repo の Issue にする', () => {
    expect(resolveParentEpicReference(353, config('o/agg'), 'o', 'impl')).toEqual(createIssueReference(createRepositoryReference('o', 'agg'), 353))
  })

  it('aggregation_repo が無ければ task のリポジトリの Issue にする', () => {
    expect(resolveParentEpicReference(353, config(), 'o', 'impl')).toEqual(createIssueReference(createRepositoryReference('o', 'impl'), 353))
  })

  it('owner/repo/N はそのまま使う', () => {
    expect(resolveParentEpicReference('x/y/9', config('o/agg'), 'o', 'impl')).toEqual(createIssueReference(createRepositoryReference('x', 'y'), 9))
  })

  it('解決できなければ受け付ける形を案内する BadParameterError', () => {
    expect(() => resolveParentEpicReference('nope', config(), 'o', 'impl')).toThrow(/^could not resolve parent_epic: .+\naccepted forms: an integer \(Issue number in aggregation_repo\) or the primary form 'owner\/repo\/N'$/su)
  })
})

describe('resolveParentEpicReference の大きな番号', () => {
  it('安全な整数に収まらない番号は、丸めずに解決できない参照として案内する', () => {
    expect(() => resolveParentEpicReference('12345678901234567890', config(), 'o', 'impl')).toThrow(/^could not resolve parent_epic: the number is too large: 12345678901234567890\naccepted forms: /u)
  })
})

describe('resolveEpicTargetRepository', () => {
  it('省略して aggregation_repo も無ければ、終了コード 2', () => {
    const { io, output } = started()
    expect(() => resolveEpicTargetRepository(output, ' ', config())).toThrow(CommandExit)
    expect(io.err).toEqual(['error: cannot decide where to create the Epic\n  declare aggregation_repo in the project config, or pass --repo\n'])
  })

  it('省略すれば aggregation_repo を使う', () => {
    expect(resolveEpicTargetRepository(started().output, undefined, config('o/agg'))).toEqual({ repository: 'o/agg', needsWarning: false })
  })

  it('aggregation_repo が無いか同じなら例外にしない。違えば例外', () => {
    const { output } = started()
    expect(resolveEpicTargetRepository(output, 'o/impl', config())).toEqual({ repository: 'o/impl', needsWarning: false })
    expect(resolveEpicTargetRepository(output, 'o/agg', config('o/agg'))).toEqual({ repository: 'o/agg', needsWarning: false })
    expect(resolveEpicTargetRepository(output, 'o/impl', config('o/agg'))).toEqual({ repository: 'o/impl', needsWarning: true })
  })

  it('例外の警告を出す', () => {
    const { io, output } = started()
    warnEpicRepositoryException(output, 'o/impl', config('o/agg'))
    expect(io.err).toEqual(['warning: --repo o/impl differs from aggregation_repo (o/agg)\n  continuing as an exception for an Epic in an implementation repo\n'])
  })
})

describe('status の検証', () => {
  it('enum 外の値は有効な値を案内して終了コード 1', () => {
    const { io, output } = started()
    expect(() => exitInvalidStatus(output, 'foo')).toThrow(CommandExit)
    expect(io.err).toEqual(['error: invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n'])
  })

  it('型の既定値と同じなら通す', () => {
    const { io, output } = started()
    validateStatusForType(output, 'task', 'ready')
    validateStatusForType(output, 'epic', 'backlog')
    expect(io.err).toEqual([])
  })

  it('型の既定値と違えば、既定値と後から動かす案内を出す', () => {
    const { io, output } = started()
    expect(() => {
      validateStatusForType(output, 'bug', 'backlog')
    }).toThrow(CommandExit)
    expect(io.err).toEqual(['error: the status at creation for type \'bug\' is only \'ready\' (given: backlog)\n  hint: move it to pending or another status on the board after creation\n'])
  })

  it('許す値を渡すと、その値でも通し、違えば許す値を並べる', () => {
    const { io, output } = started()
    validateStatusForType(output, 'task', 'blocked', ['ready', 'blocked'])
    expect(() => {
      validateStatusForType(output, 'task', 'active', ['ready', 'blocked'])
    }).toThrow(CommandExit)
    expect(io.err).toEqual(['error: the status at creation for type \'task\' is only \'ready\' or \'blocked\' (given: active)\n  hint: move it to pending or another status on the board after creation\n'])
  })

  it('許す値を渡さないと、blocked は型の既定値でないので止める', () => {
    const { output } = started()
    expect(() => {
      validateStatusForType(output, 'task', 'blocked')
    }).toThrow(CommandExit)
  })

  it('enum 外の値は先に弾く', () => {
    const { io, output } = started()
    expect(() => {
      validateStatusForType(output, 'task', 'foo')
    }).toThrow(CommandExit)
    expect(io.err[0]).toMatch(/^error: invalid status: foo\n/u)
  })
})

function epic(subs: readonly Readonly<{ number: number, state: string, title: string }>[]): ReturnType<typeof graphqlData> {
  return graphqlData('GetIssueSlim', {
    repository: { issue: { number: 353, state: 'OPEN', title: 'E', body: '', comments: { totalCount: 0 }, subIssues: { nodes: subs } } },
  })
}

describe('checkDuplicateOrder', () => {
  it('重複が無ければ何も出さない', async () => {
    const { client } = await startClient([epic([{ number: 1, state: 'OPEN', title: '[Task] #353-01: a' }])])
    const { io, output } = started()
    await checkDuplicateOrder(output, client, 'o', 'r', 353, 2)
    expect(io.err).toEqual([])
  })

  it('別の Epic の番号は数えない', async () => {
    const { client } = await startClient([epic([{ number: 1, state: 'OPEN', title: '[Task] #999-01: a' }])])
    const { io, output } = started()
    await checkDuplicateOrder(output, client, 'o', 'r', 353, 1)
    expect(io.err).toEqual([])
  })

  it('同じ order があれば、次に使える order を案内して終了コード 1', async () => {
    const { client } = await startClient([epic([{ number: 11, state: 'CLOSED', title: '[Task] #353-01: a' }, { number: 12, state: 'OPEN', title: '[Task] #353-02: b' }])])
    const { io, output } = started()
    await expect(checkDuplicateOrder(output, client, 'o', 'r', 353, 1)).rejects.toThrow(CommandExit)
    expect(io.err).toEqual(['error: Epic #353 already has an Issue with order=1 (CLOSED)\n  #11 [Task] #353-01: a\n  next available order: 3\n'])
  })

  it('既存のタイトルの枝の文字（04a）は数えず、番号 4 の重複にする', async () => {
    const { client } = await startClient([epic([{ number: 1, state: 'OPEN', title: '[Task] #353-04a: a' }])])
    const { io, output } = started()
    await expect(checkDuplicateOrder(output, client, 'o', 'r', 353, 4)).rejects.toThrow(CommandExit)
    expect(io.err).toEqual(['error: Epic #353 already has an Issue with order=4 (OPEN)\n  #1 [Task] #353-04a: a\n  next available order: 5\n'])
  })

  it('サブ Issue が 1 ページ目に収まらなくても、全件を読んで重複を見つける', async () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({ number: index + 1, state: 'OPEN', title: `[Task] #353-${String(index + 1).padStart(2, '0')}: a` }))
    const { client } = await startClient([
      graphqlData('GetIssueSlim', { repository: { issue: { number: 353, state: 'OPEN', title: 'E', body: '', comments: { totalCount: 0 }, subIssues: { nodes, pageInfo: { hasNextPage: true, endCursor: 'c1' } } } } }),
      graphqlData('GetSubIssuesPage', { repository: { issue: { subIssues: { nodes: [{ number: 21, state: 'CLOSED', title: '[Task] #353-21: z' }], pageInfo: { hasNextPage: false, endCursor: JSON_NULL } } } } }),
    ])
    const { io, output } = started()
    await expect(checkDuplicateOrder(output, client, 'o', 'r', 353, 21)).rejects.toThrow(CommandExit)
    expect(io.err).toEqual(['error: Epic #353 already has an Issue with order=21 (CLOSED)\n  #21 [Task] #353-21: z\n  next available order: 22\n'])
  })

  it('親 Epic を取れなければ warning だけで続ける', async () => {
    const { client } = await startClient([graphqlError('GetIssueSlim', 'boom')])
    const { io, output } = started()
    await checkDuplicateOrder(output, client, 'o', 'r', 353, 1)
    expect(io.err).toHaveLength(1)
    expect(io.err[0]).toMatch(/^warning: could not fetch the parent Epic #353: /u)
  })
})

describe('createIssueOrExit', () => {
  it('Issue を作って created の行を出す。source があれば末尾に付ける', async () => {
    const { client } = await startClient([restResponse('POST', '/repos/o/r/issues', { status: 201, body: { number: 5 } }, 2)])
    const { io, output } = started()
    expect(await createIssueOrExit(output, client, 'o', 'r', 'T', 'B', undefined)).toEqual({ number: 5 })
    await createIssueOrExit(output, client, 'o', 'r', 'T', 'B', undefined, 'a.md')
    expect(io.err).toEqual(['created: Issue o/r/5\n', 'created: Issue o/r/5 from a.md\n'])
  })

  it('失敗は error の行と終了コード 1', async () => {
    const { client } = await startClient([restResponse('POST', '/repos/o/r/issues', { status: 422, text: 'bad' })])
    const { io, output } = started()
    await expect(createIssueOrExit(output, client, 'o', 'r', 'T', 'B', undefined)).rejects.toThrow(CommandExit)
    expect(io.err[0]).toMatch(/^error: could not create an Issue in o\/r: /u)
  })
})

describe('linkToParentEpic', () => {
  const parent = createIssueReference(createRepositoryReference('o', 'agg'), 353)

  it('親 Epic のサブ Issue にして added の行を出す', async () => {
    const { client } = await startClient([
      graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_parent', title: 'E' } } }),
      graphqlData('AddSubIssue', { addSubIssue: { issue: { number: 353 }, subIssue: { number: 5 } } }),
    ])
    const { io, output } = started()
    await linkToParentEpic(output, client, 'Issue o/r/5', parent, 'I_child', 'https://x/5')
    expect(io.err).toEqual(['added: Issue o/r/5 as sub-issue of o/agg/353\n'])
  })

  it('失敗は URL、error の順に出して終了コード 1', async () => {
    const { client } = await startClient([graphqlError('GetIssueNodeId', 'nope')])
    const { io, output } = started()
    await expect(linkToParentEpic(output, client, 'Issue o/r/5', parent, 'I_child', 'https://x/5')).rejects.toThrow(CommandExit)
    expect(io.out).toEqual(['https://x/5\n'])
    expect(io.err[0]).toMatch(/^error: could not add Issue o\/r\/5 as sub-issue of o\/agg\/353: /u)
  })
})

describe('validateIssueTemplate', () => {
  it('テンプレートそのものは通す', () => {
    const { io, output } = started()
    validateIssueTemplate(output, 'task', '## Goal \u{2014} 達成したい状態\n\n実現したい状態\n\n## Acceptance \u{2014} 達成判定\n\n- **条件1** \u{2014} 確認: pytest\n')
    expect(io.err).toEqual([])
  })

  it('セクションが無い本文は、テンプレートのパスと不足を出して終了コード 1', () => {
    const { io, output } = started()
    expect(() => {
      validateIssueTemplate(output, 'task', 'ただの本文')
    }).toThrow(CommandExit)
    expect(io.err[0]).toMatch(/^error: the body does not follow the template .+task\.md\n {2}missing sections: /u)
  })
})

describe('Issue 参照と設定', () => {
  it('--repo を基準に短縮形と主軸形を分ける', () => {
    const { output } = started()
    expect(parseIssueReferenceOrExit(output, 'o/r', '5')).toEqual({ owner: 'o', repository: 'r', number: 5 })
    expect(parseIssueReferenceOrExit(output, 'o/r', 'x/y/7')).toEqual({ owner: 'x', repository: 'y', number: 7 })
  })

  it('不正な参照は error の行と終了コード 2', () => {
    const { io, output } = started()
    expect(() => parseIssueReferenceOrExit(output, 'o/r', 'zzz')).toThrow(expect.objectContaining({ exitCode: 2 }))
    expect(io.err[0]).toMatch(/^error: /u)
  })
})

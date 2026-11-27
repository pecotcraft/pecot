// issue 系のコマンドの共有関数のテスト。GitHub は偽サーバにする。期待値は cli/tests/cli/test_issue.py と同じ。
/* eslint-disable security/detect-non-literal-fs-filename -- 書くのは一時ディレクトリ配下のみ */
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { parseProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import { createIssueReference } from '../../domain/reference-parser.js'
import { createRepositoryReference } from '../../domain/repository-resolver.js'
import { graphqlData, graphqlError, rejection, restResponse, startClient, useFakeGithub } from '../../infra/github/tests/fake-client.js'
import '../../../tests/_helpers/hint-commands.js'
import {
  buildIssueTitle,
  checkDuplicateOrder,
  createIssueOrExit,
  exitInvalidStatus,
  hasReportedTemplateTextViolations,
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
import { capture } from '../../../tests/_helpers/captured-io.js'
import type { CapturedIo } from '../../../tests/_helpers/captured-io.js'
import { JSON_NULL } from '../../domain/json-null.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'

useFakeGithub()

function config(aggregation?: string): ProjectConfig {
  return parseProjectConfig({
    host: 'github.com',
    owner: 'o',
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
  throw new CommandExit(3, 'content-invalid')
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
  it('処理が正常に終了した場合は、終了コード 0 を返す', async () => {
    await explains('処理を実行して終了コードへ変換する関数（`runWithExit`）のテストです。例外が発生せず終了した場合は、終了コード 0 を返すことを確認します。')
    expect(await runWithExit(succeed)).toBe(0)
  })

  it('CommandExit が発生した場合は、終了コードを保ったまま再度発生させる', async () => {
    await explains('`runWithExit` が実行する処理で、`CommandExit`（終了コード 3）が発生した場合のテストです。変換せず、終了コード 3 を持つ例外が発生することを確認します。')
    await expect(runWithExit(exitWith3)).rejects.toMatchObject({ exitCode: 3 })
  })

  it('BadParameterError が発生した場合は、UsageError に変換して発生させる', async () => {
    await explains('`runWithExit` が実行する処理で、`BadParameterError` が発生した場合のテストです。`UsageError` に変換され、メッセージが `Invalid value: could not resolve parent_epic:` で始まることを確認します。')
    const error = await rejection(runWithExit(badParameter))
    expect(error).toBeInstanceOf(UsageError)
    expect(error instanceof Error ? error.message : '').toMatch(/^Invalid value: could not resolve parent_epic: /u)
  })

  it('それ以外の例外は、変換せずにそのまま発生させる', async () => {
    await explains('`TypeError` など、想定していない例外が発生した場合のテストです。変換せず、元のメッセージのまま例外が発生することを確認します。')
    await expect(runWithExit(boom)).rejects.toThrow('boom')
    expect(new CommandExit(2, 'invalid-input').exitCode).toBe(2)
  })
})

const prefixRows: readonly (readonly [string, string, string])[] = [
  ['task', 'タイトル', '[Task] タイトル'],
  ['task', '[Task] タイトル', '[Task] タイトル'],
  ['bug', 'x', '[Bug] x'],
  ['unknown', 'x', 'x'],
]

describe('buildIssueTitle', () => {
  it.for(prefixRows)('Issue の種類 $0 とタイトル $1 に接頭辞を付けると、$2 になる', async ([issueType, title, expected]) => {
    await explains(`Issue のタイトルに、種類ごとの接頭辞を付ける関数（\`buildIssueTitle\`）のテストです。種類 \`${issueType}\` とタイトル \`${title}\` の場合に、\`${expected}\` になることを確認します。`)
    expect(buildIssueTitle(issueType, title)).toBe(expected)
  })

  it('親 Epic の番号と order を指定した場合は、タイトルに Epic の番号と order を付ける', async () => {
    await explains('親 Epic の番号と order を指定した場合のテストです。接頭辞の後ろに `#353-01:` のような番号が付き、タイトルがすでに接頭辞で始まっていても重複しないことを確認します。')
    expect(buildIssueTitle('task', 'タイトル', { parentEpic: 353, order: 1 })).toBe('[Task] #353-01: タイトル')
    expect(buildIssueTitle('task', '[Task] タイトル', { parentEpic: 353, order: 12 })).toBe('[Task] #353-12: タイトル')
  })

  it('接頭辞を持たない種類の場合は、番号だけをタイトルに付ける', async () => {
    await explains('接頭辞を持たない種類（`unknown`）に、親 Epic の番号と order を指定した場合のテストです。接頭辞は付けず、`#50-01:` の番号だけが付くことを確認します。')
    expect(buildIssueTitle('unknown', 'タイトル', { parentEpic: 50, order: 1 })).toBe('#50-01: タイトル')
  })

  it('order は 2 桁に揃えて、タイトルに付ける', async () => {
    await explains('order が 1 桁の場合のテストです。`04` のように 0 で埋めた 2 桁になり、2 桁の `10` はそのまま付くことを確認します。')
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
  it.for(parentEpicRows)('CLI の入力 %j を、親 Epic の指定として正規化する', async ([raw, expected]) => {
    await explains('CLI で指定した親 Epic の値を正規化する関数（`normalizeParentEpicCli`）のテストです。前後の空白と先頭の 0 を取り除き、安全な整数は数値にして、安全な整数に収まらない値は文字列のまま返すことを確認します。')
    expect(normalizeParentEpicCli(raw)).toBe(expected)
  })
})

describe('resolveParentEpicReference', () => {
  it('整数を指定した場合は、aggregation_repo の Issue として解決する', async () => {
    await explains('親 Epic の参照を解決する関数（`resolveParentEpicReference`）のテストです。番号だけを指定した場合に、`aggregation_repo` に設定したリポジトリの Issue になることを確認します。')
    expect(resolveParentEpicReference(353, config('o/agg'), 'o', 'impl')).toEqual(createIssueReference(createRepositoryReference('o', 'agg'), 353))
  })

  it('aggregation_repo が設定されていない場合は、task のリポジトリの Issue として解決する', async () => {
    await explains('`aggregation_repo` が設定されていない場合のテストです。番号だけを指定すると、task を作成するリポジトリの Issue になることを確認します。')
    expect(resolveParentEpicReference(353, config(), 'o', 'impl')).toEqual(createIssueReference(createRepositoryReference('o', 'impl'), 353))
  })

  it('owner/repo/N の形で指定した場合は、その Issue をそのまま使う', async () => {
    await explains('`owner/repo/N` の形で指定した場合のテストです。`aggregation_repo` を設定していても、指定したリポジトリの Issue になることを確認します。')
    expect(resolveParentEpicReference('x/y/9', config('o/agg'), 'o', 'impl')).toEqual(createIssueReference(createRepositoryReference('x', 'y'), 9))
  })

  it('解決できない場合は、受け付ける形を示した BadParameterError が発生する', async () => {
    await explains('解決できない値（`nope`）を指定した場合のテストです。受け付ける形（整数または `owner/repo/N`）を案内するメッセージの `BadParameterError` が発生することを確認します。')
    expect(() => resolveParentEpicReference('nope', config(), 'o', 'impl')).toThrow(/^could not resolve parent_epic: .+\naccepted forms: an integer \(Issue number in aggregation_repo\) or the primary form 'owner\/repo\/N'$/su)
  })
})

describe('resolveParentEpicReference の大きな番号', () => {
  it('安全な整数に収まらない番号を指定した場合は、丸めずに、大きすぎる番号として案内する', async () => {
    await explains('JavaScript で正確に表せない大きな番号（`12345678901234567890`）を指定した場合のテストです。番号を丸めず、`the number is too large` を理由に含むメッセージが発生することを確認します。')
    expect(() => resolveParentEpicReference('12345678901234567890', config(), 'o', 'impl')).toThrow(/^could not resolve parent_epic: the number is too large: 12345678901234567890\naccepted forms: /u)
  })
})

describe('resolveEpicTargetRepository', () => {
  it('リポジトリを指定せず aggregation_repo も設定されていない場合は、作成先を決められないエラーで止める', async () => {
    await explains('Epic の作成先のリポジトリを決める関数（`resolveEpicTargetRepository`）のテストです。`repo` と `aggregation_repo` の指定がない場合は、エラーを表示して `CommandExit` が発生することを確認します。')
    const { io, output } = started()
    expect(() => resolveEpicTargetRepository(output, ' ', config())).toThrow(CommandExit)
    expect(io.err).toEqual(['error: cannot decide where to create the Epic\n  declare aggregation_repo in the project config, or pass repo\n'])
  })

  it('リポジトリを指定しない場合は、aggregation_repo を作成先にする', async () => {
    await explains('`repo` を指定しない場合のテストです。`aggregation_repo` のリポジトリが作成先になり、例外の警告は不要と判定されることを確認します。')
    expect(resolveEpicTargetRepository(started().output, undefined, config('o/agg'))).toEqual({ repository: 'o/agg', needsWarning: false })
  })

  it('指定したリポジトリが aggregation_repo と異なる場合だけ、例外の警告が必要と判定する', async () => {
    await explains('`repo` を指定した場合のテストです。`aggregation_repo` が設定されていない場合や同じ場合は警告が不要で、異なる場合だけ警告が必要（`needsWarning` が `true`）になることを確認します。')
    const { output } = started()
    expect(resolveEpicTargetRepository(output, 'o/impl', config())).toEqual({ repository: 'o/impl', needsWarning: false })
    expect(resolveEpicTargetRepository(output, 'o/agg', config('o/agg'))).toEqual({ repository: 'o/agg', needsWarning: false })
    expect(resolveEpicTargetRepository(output, 'o/impl', config('o/agg'))).toEqual({ repository: 'o/impl', needsWarning: true })
  })

  it('作成先が aggregation_repo と異なる場合は、例外として作成する旨の警告を表示する', async () => {
    await explains('作成先が `aggregation_repo` と異なる場合の警告（`warnEpicRepositoryException`）のテストです。入力 `repo` と `aggregation_repo` が異なることと、例外として続行することを知らせる警告を表示することを確認します。')
    const { io, output } = started()
    warnEpicRepositoryException(output, 'o/impl', config('o/agg'))
    expect(io.err).toEqual(['warning: repo: "o/impl" differs from aggregation_repo (o/agg)\n  continuing as an exception for an Epic in an implementation repo\n'])
  })
})

describe('status の検証', () => {
  it('定義に存在しない status を指定した場合は、有効な値を案内して止める', async () => {
    await explains('無効な status を報告する関数（`exitInvalidStatus`）のテストです。`invalid status: foo` と有効な値の一覧を表示し、`CommandExit` が発生することを確認します。')
    const { io, output } = started()
    expect(() => exitInvalidStatus(output, 'foo')).toThrow(CommandExit)
    expect(io.err).toEqual(['error: invalid status: foo\n  valid values: backlog/pending/blocked/ready/active/in_review/archived\n'])
  })

  it('Issue の種類の既定の status と同じ値の場合は、エラーにしない', async () => {
    await explains('Issue の種類ごとの既定の status を検証する関数（`validateStatusForType`）のテストです。`task` に `ready`、`epic` に `backlog` を指定した場合に、何も表示せず、例外も発生しないことを確認します。')
    const { io, output } = started()
    validateStatusForType(output, 'task', 'ready')
    validateStatusForType(output, 'epic', 'backlog')
    expect(io.err).toEqual([])
  })

  it('既定の status と異なる場合は、既定の値と、作成後に動かす手順を案内して止める', async () => {
    await explains('`bug` に `ready` 以外の status を指定した場合のテストです。許される値と、作成後にボードで動かす手順を案内し、`CommandExit` が発生することを確認します。')
    const { io, output } = started()
    expect(() => {
      validateStatusForType(output, 'bug', 'backlog')
    }).toThrow(CommandExit)
    expect(io.err).toEqual(['error: the status at creation for type \'bug\' is only \'ready\' (given: backlog)\n  hint: move it to pending or another status on the board after creation\n'])
  })

  it('許可する値を追加で指定した場合は、その値も受け付け、それ以外の場合は許可する値を並べて案内する', async () => {
    await explains('許可する値の一覧（`ready` と `blocked`）を指定した場合のテストです。`blocked` は受け付け、`active` の場合は許可する値を並べた案内を表示して `CommandExit` が発生することを確認します。')
    const { io, output } = started()
    validateStatusForType(output, 'task', 'blocked', ['ready', 'blocked'])
    expect(() => {
      validateStatusForType(output, 'task', 'active', ['ready', 'blocked'])
    }).toThrow(CommandExit)
    expect(io.err).toEqual(['error: the status at creation for type \'task\' is only \'ready\' or \'blocked\' (given: active)\n  hint: move it to pending or another status on the board after creation\n'])
  })

  it('許可する値を指定しない場合は、blocked は既定の status ではないため止める', async () => {
    await explains('許可する値を指定せず、`task` に `blocked` を指定した場合のテストです。`blocked` は既定の status ではないため、`CommandExit` が発生することを確認します。')
    const { output } = started()
    expect(() => {
      validateStatusForType(output, 'task', 'blocked')
    }).toThrow(CommandExit)
  })

  it('定義外の status は、種類ごとの検証より先にエラーとする', async () => {
    await explains('`task` に定義外の status（`foo`）を指定した場合のテストです。種類ごとの検証より前に、`invalid status: foo` のエラーを表示することを確認します。')
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
  it('order が重複していない場合は、何も表示しない', async () => {
    await explains('親 Epic のサブ Issue の order が重複していないかを確認する関数（`checkDuplicateOrder`）のテストです。同じ order のサブ Issue が存在しない場合に、何も表示せず、例外も発生しないことを確認します。')
    const { client } = await startClient([epic([{ number: 1, state: 'OPEN', title: '[Task] #353-01: a' }])])
    const { io, output } = started()
    await checkDuplicateOrder(output, client, 'o', 'r', 353, 2)
    expect(io.err).toEqual([])
  })

  it('別の Epic の番号を持つサブ Issue は、重複として扱わない', async () => {
    await explains('別の Epic の番号（`#999-01`）を持つサブ Issue が存在する場合のテストです。同じ order でも重複として扱わず、何も表示しないことを確認します。')
    const { client } = await startClient([epic([{ number: 1, state: 'OPEN', title: '[Task] #999-01: a' }])])
    const { io, output } = started()
    await checkDuplicateOrder(output, client, 'o', 'r', 353, 1)
    expect(io.err).toEqual([])
  })

  it('同じ order のサブ Issue が存在する場合は、次に使える order を案内して止める', async () => {
    await explains('同じ order のサブ Issue が存在する場合のテストです。重複した Issue と次に使える order（3）を表示し、`CommandExit` が発生することを確認します。')
    const { client } = await startClient([epic([{ number: 11, state: 'CLOSED', title: '[Task] #353-01: a' }, { number: 12, state: 'OPEN', title: '[Task] #353-02: b' }])])
    const { io, output } = started()
    await expect(checkDuplicateOrder(output, client, 'o', 'r', 353, 1)).rejects.toThrow(CommandExit)
    expect(io.err).toEqual(['error: Epic #353 already has an Issue with order=1 (CLOSED)\n  #11 [Task] #353-01: a\n  next available order: 3\n'])
  })

  it('タイトルの order に枝番の文字（04a）が付いていても、数字の部分（4）が同じなら重複として扱う', async () => {
    await explains('既存の Issue のタイトルが `#353-04a` の場合のテストです。枝番の文字を除いた order 4 の重複として扱い、次に使える order（5）を案内することを確認します。')
    const { client } = await startClient([epic([{ number: 1, state: 'OPEN', title: '[Task] #353-04a: a' }])])
    const { io, output } = started()
    await expect(checkDuplicateOrder(output, client, 'o', 'r', 353, 4)).rejects.toThrow(CommandExit)
    expect(io.err).toEqual(['error: Epic #353 already has an Issue with order=4 (OPEN)\n  #1 [Task] #353-04a: a\n  next available order: 5\n'])
  })

  it('サブ Issue が 1 ページに収まらない場合も、全件を取得して重複を検出する', async () => {
    await explains('サブ Issue が 2 ページにわたる場合のテストです。2 ページ目の Issue（order 21）も取得して重複を検出し、`CommandExit` が発生することを確認します。')
    const nodes = Array.from({ length: 20 }, (_, index) => ({ number: index + 1, state: 'OPEN', title: `[Task] #353-${String(index + 1).padStart(2, '0')}: a` }))
    const { client } = await startClient([
      graphqlData('GetIssueSlim', { repository: { issue: { number: 353, state: 'OPEN', title: 'E', body: '', comments: { totalCount: 0 }, subIssues: { nodes, pageInfo: { hasNextPage: true, endCursor: 'c1' } } } } }),
      graphqlData('GetSubIssuesPage', { repository: { issue: { subIssues: { nodes: [{ number: 21, state: 'CLOSED', title: '[Task] #353-21: z' }], pageInfo: { hasNextPage: false, endCursor: JSON_NULL } } } } }),
    ])
    const { io, output } = started()
    await expect(checkDuplicateOrder(output, client, 'o', 'r', 353, 21)).rejects.toThrow(CommandExit)
    expect(io.err).toEqual(['error: Epic #353 already has an Issue with order=21 (CLOSED)\n  #21 [Task] #353-21: z\n  next available order: 22\n'])
  })

  it('親 Epic を取得できない場合は、警告を表示するだけで処理を続ける', async () => {
    await explains('親 Epic の取得に失敗した場合のテストです。`warning: could not fetch the parent Epic #353` の警告を 1 行だけ表示し、例外は発生しないことを確認します。')
    const { client } = await startClient([graphqlError('GetIssueSlim', 'boom')])
    const { io, output } = started()
    await checkDuplicateOrder(output, client, 'o', 'r', 353, 1)
    expect(io.err).toHaveLength(1)
    expect(io.err[0]).toMatch(/^warning: could not fetch the parent Epic #353: /u)
  })
})

describe('createIssueOrExit', () => {
  it('Issue を作成して created の行を表示し、source を指定した場合は行の末尾に付ける', async () => {
    await explains('Issue を作成して結果を表示する関数（`createIssueOrExit`）のテストです。作成した Issue の番号を `created:` の行に表示し、元のファイルを指定した場合はその名前を末尾に付けることを確認します。')
    const { client } = await startClient([restResponse('POST', '/repos/o/r/issues', { status: 201, body: { number: 5 } }, 2)])
    const { io, output } = started()
    expect(await createIssueOrExit(output, client, 'o', 'r', 'T', 'B', undefined)).toEqual({ number: 5 })
    await createIssueOrExit(output, client, 'o', 'r', 'T', 'B', undefined, 'a.md')
    expect(io.err).toEqual(['created: Issue o/r/5\n', 'created: Issue o/r/5 from a.md\n'])
  })

  it('Issue の作成に失敗した場合は、エラーの行を表示して止める', async () => {
    await explains('Issue の作成が HTTP 422 で失敗した場合のテストです。`error: could not create an Issue in o/r` の行を表示し、`CommandExit` が発生することを確認します。')
    const { client } = await startClient([restResponse('POST', '/repos/o/r/issues', { status: 422, text: 'bad' })])
    const { io, output } = started()
    await expect(createIssueOrExit(output, client, 'o', 'r', 'T', 'B', undefined)).rejects.toThrow(CommandExit)
    expect(io.err[0]).toMatch(/^error: could not create an Issue in o\/r: /u)
  })
})

describe('linkToParentEpic', () => {
  const parent = createIssueReference(createRepositoryReference('o', 'agg'), 353)

  it('作成した Issue を親 Epic のサブ Issue にして、added の行を表示する', async () => {
    await explains('Issue を親 Epic のサブ Issue として登録する関数（`linkToParentEpic`）のテストです。登録に成功すると、`added: Issue o/r/5 as sub-issue of o/agg/353` の行を表示することを確認します。')
    const { client } = await startClient([
      graphqlData('GetIssueNodeId', { repository: { issue: { id: 'I_parent', title: 'E' } } }),
      graphqlData('AddSubIssue', { addSubIssue: { issue: { number: 353 }, subIssue: { number: 5 } } }),
    ])
    const { io, output } = started()
    await linkToParentEpic(output, client, 'Issue o/r/5', parent, 'I_child', 'https://x/5')
    expect(io.err).toEqual(['added: Issue o/r/5 as sub-issue of o/agg/353\n'])
  })

  it('登録に失敗した場合は、Issue の URL とエラーの行をこの順に表示して止める', async () => {
    await explains('親 Epic の取得に失敗した場合のテストです。Issue の URL を標準出力に、エラーの行を標準エラー出力に表示し、`CommandExit` が発生することを確認します。')
    const { client } = await startClient([graphqlError('GetIssueNodeId', 'nope')])
    const { io, output } = started()
    await expect(linkToParentEpic(output, client, 'Issue o/r/5', parent, 'I_child', 'https://x/5')).rejects.toThrow(CommandExit)
    expect(io.out).toEqual(['https://x/5\n'])
    expect(io.err[0]).toMatch(/^error: could not add Issue o\/r\/5 as sub-issue of o\/agg\/353: /u)
  })
})

// 配布テンプレートの issue/task.md の見出しを写した、テンプレートのファイル
function taskTemplate(): string {
  const file = path.join(makeTemporaryDirectory(), 'task.md')
  writeFileSync(file, '---\ntype: task\n---\n\n## Goal — <達成したい状態>\n\n## Acceptance — <達成判定>\n', 'utf8')
  return file
}

describe('validateIssueTemplate', () => {
  it('テンプレートの見出しをすべて含む本文は、エラーにしない', async () => {
    await explains('本文がテンプレートに従っているかを確認する関数（`validateIssueTemplate`）のテストです。テンプレートの見出し（`Goal` と `Acceptance`）をすべて含む本文の場合に、何も表示せず、例外も発生しないことを確認します。')
    const { io, output } = started()
    validateIssueTemplate(output, taskTemplate(), '## Goal \u{2014} 達成したい状態\n\n実現したい状態\n\n## Acceptance \u{2014} 達成判定\n\n- **条件1** \u{2014} 確認: pytest\n')
    expect(io.err).toEqual([])
  })

  it('テンプレートの節が不足している本文は、テンプレートのパスと不足している節を表示して止める', async () => {
    await explains('テンプレートの節を含まない本文のテストです。テンプレートのファイルのパスと不足している節を表示し、`CommandExit` が発生することを確認します。')
    const { io, output } = started()
    expect(() => {
      validateIssueTemplate(output, taskTemplate(), 'ただの本文')
    }).toThrow(CommandExit)
    expect(io.err[0]).toMatch(/^error: the body does not follow the template .+task\.md\n {2}missing sections: /u)
  })
})

describe('hasReportedTemplateTextViolations', () => {
  const TEMPLATE = '---\ntemplate: note\n---\n\n## Note — <要約>\n\n- 中身 — <中身>\n'

  it('文字列のテンプレートの見出しを持つ本文は、何も出さずに false を返す', async () => {
    await explains('本文がテンプレートに沿うかを確認する `hasReportedTemplateTextViolations` のテストです。文字列のテンプレートの見出しをすべて持つ本文の場合に、何も出力せず `false` を返すことを確認します。')
    const { io, output } = started()
    expect(hasReportedTemplateTextViolations(output, '## Note — 要約\n\n- 中身 — 本文\n', 'note', TEMPLATE)).toBe(false)
    expect(io.err).toEqual([])
  })

  it('見出しが無い本文は、テンプレートの名前と不足を出して true を返す', async () => {
    await explains('本文がテンプレートに沿うかを確認する `hasReportedTemplateTextViolations` のテストです。見出しの無い本文の場合に、テンプレートの名前と不足している見出しを出力し、`true` を返すことを確認します。')
    const { io, output } = started()
    expect(hasReportedTemplateTextViolations(output, 'ただの本文', 'note', TEMPLATE)).toBe(true)
    expect(io.err[0]).toMatch(/^error: the body does not follow the template note\n {2}missing sections: /u)
  })
})

describe('Issue 参照と設定', () => {
  it('repo を基準にして、短縮形と owner/repo/N の形を区別して解釈する', async () => {
    await explains('Issue の参照を解釈する関数（`parseIssueReferenceOrExit`）のテストです。番号だけの短縮形は `repo` のリポジトリの Issue になり、`owner/repo/N` の形は指定したリポジトリの Issue になることを確認します。')
    const { output } = started()
    expect(parseIssueReferenceOrExit(output, 'o/r', '5')).toEqual({ owner: 'o', repository: 'r', number: 5 })
    expect(parseIssueReferenceOrExit(output, 'o/r', 'x/y/7')).toEqual({ owner: 'x', repository: 'y', number: 7 })
  })

  it('不正な参照を指定した場合は、エラーの行を表示して終了コード 2 で止める', async () => {
    await explains('解釈できない参照（`zzz`）を指定した場合のテストです。`error:` で始まる行を表示し、終了コード 2 の `CommandExit` が発生することを確認します。')
    const { io, output } = started()
    expect(() => parseIssueReferenceOrExit(output, 'o/r', 'zzz')).toThrow(expect.objectContaining({ exitCode: 2 }))
    expect(io.err[0]).toMatch(/^error: /u)
  })
})

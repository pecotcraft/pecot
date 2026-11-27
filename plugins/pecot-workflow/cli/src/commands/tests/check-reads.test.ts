/* eslint-disable unicorn/no-null -- 公式の結果の JSON にある null を再現する */
// issue_check・issue_dependency_check が共有する、読み取りの結果の受け方とボードの形の振る舞い。
import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { parseProjectConfig } from '@pecot/workflow-core/domain/config.js'
import type { IssueFacts, IssuePullRequest, Prerequisite } from '@pecot/workflow-core/domain/readiness.js'
import { createIssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { createRepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import type { BoardShape, StackUndecided } from '../check-reads.js'
import { boardShapeOf, columnNames, configFor, developmentBranchOf, issueText, judgeMove, parseReads, prerequisiteFacts, stackUndecidedHint, unreadProblem } from '../check-reads.js'
import type { ReadProjectField } from '../official-reads.js'
import { capture } from './support.js'

useIsolatedEnvironment()

const HOME = createRepositoryReference('acme', 'app')
const reference = (number: number): ReturnType<typeof createIssueReference> => createIssueReference(HOME, number)

const CONFIG = parseProjectConfig({
  host: 'github.com',
  owner: 'acme',
  project: {
    number: 1,
    id: 'PVT_1',
    fields: {
      workflow: { id: 'WF', options: { ready: 'o-ready', blocked: 'o-blocked' } },
      status: { id: 'ST', options: { todo: 'o-todo' } },
    },
  },
  repositories: [{ owner: 'acme', name: 'app', develop_branch: 'main' }],
})

const field = (overrides: Readonly<Partial<ReadProjectField>>): ReadProjectField => ({ id: '1', nodeId: undefined, name: 'X', dataType: 'TEXT', options: [], ...overrides })
const WORKFLOW_FIELD = field({ id: '10', nodeId: 'WF', name: 'Workflow', dataType: 'SINGLE_SELECT', options: [{ id: 'o-ready', name: 'Ready' }, { id: 'x', name: 'blocked' }] })
const STATUS_FIELD = field({ id: '11', nodeId: 'ST', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'o-todo', name: 'Todo' }] })

describe('issueText と unreadProblem', () => {
  it('参照を owner/repo/番号 の形の文字にする', async () => {
    await explains('`issueText` のテストです。参照を、CLI の入力に使える形の文字にすることを確認します。')
    expect(issueText(reference(5))).toBe('acme/app/5')
  })

  it('Issue を指定すると issue を持つ problem を、指定しなければ持たない problem を返す', async () => {
    await explains('`unreadProblem` のテストです。Issue の指定がある場合とない場合の両方で、`read-required` の problem を作り、issue の項目の有無が変わることを確認します。')
    expect(unreadProblem('reads.issues', 'm', 'acme/app/5')).toEqual({ issue: 'acme/app/5', field: 'reads.issues', code: 'read-required', message: 'm' })
    expect(unreadProblem('reads.issues', 'm')).toEqual({ field: 'reads.issues', code: 'read-required', message: 'm' })
  })
})

describe('boardShapeOf', () => {
  it('設定の ID で進行の欄を見つけ、選択肢を設定の ID で引く', async () => {
    await explains('`boardShapeOf` のテストです。設定の進行の欄の ID が欄の nodeId と一致する場合に、その欄を進行の欄にし、設定の ID の選択肢の表示名を返すことを確認します。')
    const shape = boardShapeOf([WORKFLOW_FIELD, STATUS_FIELD], CONFIG)
    expect(shape.workflow).toBe(WORKFLOW_FIELD)
    expect(shape.status).toBe(STATUS_FIELD)
    expect(shape.column('ready')).toBe('Ready')
    expect(shape.label('todo')).toBe('Todo')
  })

  it('ID で見つからない選択肢は、名前で探し、どちらでも見つからなければ undefined にする', async () => {
    await explains('`boardShapeOf` のテストです。設定の ID に当たる選択肢が無い場合は、大文字小文字を除いた表示名で探し、名前も無ければ undefined を返すことを確認します。')
    const shape = boardShapeOf([WORKFLOW_FIELD, STATUS_FIELD], CONFIG)
    expect(shape.column('blocked')).toBe('blocked')
    expect(shape.column('active')).toBeUndefined()
    expect(shape.label('needs_attention')).toBeUndefined()
  })

  it('設定が無ければ、欄の名前で進行の欄を見つけ、選択肢は名前で探す', async () => {
    await explains('`boardShapeOf` のテストです。設定が無い場合に、名前が `pecot-status` の欄を進行の欄にし、選択肢を表示名で探すことを確認します。')
    const shape = boardShapeOf([field({ id: '1', name: 'pecot-status', dataType: 'SINGLE_SELECT', options: [{ id: 'a', name: 'Ready' }] })], undefined)
    expect(shape.workflow?.id).toBe('1')
    expect(shape.status).toBeUndefined()
    expect(shape.column('ready')).toBe('Ready')
    expect(shape.label('todo')).toBeUndefined()
  })

  it('進行の欄も Status の欄も無ければ、どちらも undefined にする', async () => {
    await explains('`boardShapeOf` のテストです。欄が 1 つも無い場合に、進行の欄と Status の欄を undefined にし、選択肢も見つからないことを確認します。')
    const shape = boardShapeOf([], CONFIG)
    expect([shape.workflow, shape.status, shape.column('ready'), shape.label('todo')]).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('columnNames', () => {
  it('欄が読めていれば欄の名前を、無ければ既定の名前を返す', async () => {
    await explains('`columnNames` のテストです。進行の欄と Status の欄がある場合はその名前を返し、無い場合は `pecot-status` と `Status` を返すことを確認します。')
    expect(columnNames(boardShapeOf([WORKFLOW_FIELD, STATUS_FIELD], CONFIG))).toEqual({ column: 'Workflow', label: 'Status' })
    expect(columnNames(boardShapeOf([], undefined))).toEqual({ column: 'pecot-status', label: 'Status' })
  })
})

const issueRead = (number: number, extra: Readonly<Record<string, unknown>> = {}): unknown => ({ issue: { number, title: `T${String(number)}`, state: 'open', html_url: `https://github.com/acme/app/issues/${String(number)}`, ...extra } })
const pull = (number: number, head: string, base: string): IssuePullRequest => ({ repository: HOME, number, state: 'open', headRefName: head, baseRefName: base, isDraft: false, isCrossRepository: false })
const output = (): ReturnType<typeof createOutput> => createOutput(false, capture())

describe('parseReads', () => {
  const prRead = { number: 9, state: 'open', draft: false, merged: false, html_url: 'https://github.com/acme/app/pull/9', head: { ref: 'feat', repo: null }, base: { ref: 'main', repo: null } }

  it('reads が無ければ、空の結果を返す', async () => {
    await explains('`parseReads` のテストです。reads が無い場合に、Issue と PR は空で、カードとボードが undefined の結果を返すことを確認します。')
    const parsed = parseReads(output(), undefined, CONFIG)
    expect([parsed.issues.size, parsed.pullRequests.size, parsed.cards, parsed.board]).toEqual([0, 0, undefined, undefined])
  })

  it('閉じる PR を、pull_request_read で読んだ PR に差し替え、カードとボードも作る', async () => {
    await explains('`parseReads` のテストです。Issue の閉じる PR と同じ PR を pull_request_read で読んでいる場合に、head と base を持つ PR に差し替え、カード・ボードも作ることを確認します。')
    const parsed = parseReads(output(), {
      pull_requests: [prRead],
      issues: [issueRead(5, { closed_by_pull_requests: { references: [{ number: 9, state: 'OPEN', url: 'https://github.com/acme/app/pull/9', repository: 'acme/app' }, { number: 10, state: 'OPEN', url: 'https://github.com/acme/app/pull/10', repository: 'acme/app' }] } })],
      project_items: [{ items: { items: [{ content: { number: 5, repository: 'acme/app' }, fields: [{ id: 1, name: 'Workflow', value: { name: 'Ready' } }] }] } }],
      project_fields: { fields: { fields: [{ id: 10, node_id: 'WF', name: 'Workflow', data_type: 'single_select', options: [] }] } },
    }, CONFIG)
    const pullRequests = parsed.issues.get('acme/app#5')?.pullRequests
    expect(pullRequests?.map(pullRequest => [pullRequest.number, pullRequest.headRefName])).toEqual([[9, 'feat'], [10, '']])
    expect(parsed.pullRequests.get('acme/app#9')?.baseRefName).toBe('main')
    expect(parsed.cards?.get('acme/app#5')?.fields.get('workflow')).toBe('Ready')
    expect(parsed.board?.workflow?.id).toBe('10')
  })

  it.for([
    { name: 'PR', reads: { pull_requests: [{}] }, where: 'reads.pull_requests[0]' },
    { name: 'Issue', reads: { issues: [{}] }, where: 'reads.issues[0]' },
    { name: 'カード', reads: { project_items: [{}] }, where: 'reads.project_items[0]' },
    { name: '欄', reads: { project_fields: {} }, where: 'reads.project_fields' },
  ])('形が合わない $name の結果があると、github-mcp-shape で止める', async (row) => {
    await explains(`\`parseReads\` のテストです。${row.name}の結果の形が合わない場合に、置き場所 \`${row.where}\` を表示して \`github-mcp-shape\` で止めることを確認します。`)
    const io = capture()
    let kind: string | undefined
    try {
      parseReads(createOutput(false, io), row.reads, CONFIG)
    }
    catch (error: unknown) {
      if (error instanceof CommandExit) kind = error.kind
    }
    expect(kind).toBe('github-mcp-shape')
    expect(io.err.join('')).toContain(row.where)
  })
})

describe('prerequisiteFacts', () => {
  const board = boardShapeOf([WORKFLOW_FIELD, STATUS_FIELD], CONFIG)
  const reads = (): ReturnType<typeof parseReads> => parseReads(createOutput(false, capture()), {
    issues: [{ issue: { number: 5, title: 'T', state: 'closed', html_url: 'https://github.com/acme/app/issues/5' } }],
    project_items: [{ items: { items: [{ content: { number: 6, repository: 'acme/app' }, fields: [{ id: 1, name: 'Workflow', value: 'Ready' }] }] } }],
  }, CONFIG)

  it('Issue を読んでいれば、その状態から事実を作る', async () => {
    await explains('`prerequisiteFacts` のテストです。前提の Issue を読んでいる場合に、読んだ Issue の状態から事実を作ることを確認します。')
    expect(prerequisiteFacts(reference(5), 'open', reads(), board)?.state).toBe('closed')
  })

  it('Issue を読んでいなければ、渡した状態とカードの列から事実を作る', async () => {
    await explains('`prerequisiteFacts` のテストです。Issue を読まず状態だけを渡す場合に、その状態とカードの列を持つ、PR の無い事実を作ることを確認します。')
    const facts = prerequisiteFacts(reference(6), 'open', reads(), board)
    expect([facts?.state, facts?.column, facts?.pullRequests]).toEqual(['open', 'Ready', []])
  })

  it('Issue を読まず状態も渡さなければ、undefined を返す', async () => {
    await explains('`prerequisiteFacts` のテストです。Issue を読んでおらず状態も渡さない場合に、事実を作らず undefined を返すことを確認します。')
    expect(prerequisiteFacts(reference(7), undefined, reads(), board)).toBeUndefined()
  })
})

describe('developmentBranchOf', () => {
  it('設定があればリポの develop_branch を、設定が無ければ undefined を返す', async () => {
    await explains('`developmentBranchOf` のテストです。設定がある場合はリポの開発ブランチを返し、設定が無い場合は undefined を返すことを確認します。')
    expect(developmentBranchOf(CONFIG, HOME)).toBe('main')
    expect(developmentBranchOf(undefined, HOME)).toBeUndefined()
  })
})

describe('stackUndecidedHint', () => {
  const pullRequest: IssuePullRequest = { repository: HOME, number: 9, state: 'open', headRefName: '', baseRefName: '', isDraft: false, isCrossRepository: false }

  it.for<{ name: string, undecided: StackUndecided, expected: string }>([
    { name: '読んでいない PR', undecided: { kind: 'unread-pull-requests', pullRequests: [pullRequest] }, expected: 'pass the result of pull_request_read (method get) for acme/app#9 in reads.pull_requests to decide it' },
    { name: '見つからない base', undecided: { kind: 'missing-bases', branches: ['a', 'b'] }, expected: 'find the open pull request whose head is a, b (list_pull_requests with head) and pass its pull_request_read (method get) result in reads.pull_requests to decide it' },
    { name: '開発ブランチの未設定', undecided: { kind: 'no-develop-branch', repository: HOME }, expected: 'develop_branch is not set for acme/app in the project config' },
  ])('$name のとき、足りない読み取りの案内を返す', async (row) => {
    await explains(`\`stackUndecidedHint\` のテストです。${row.name}でスタックを決められない場合に、次の案内を返すことを確認します。\`${row.expected}\``)
    expect(stackUndecidedHint(row.undecided)).toBe(row.expected)
  })
})

describe('judgeMove', () => {
  const facts = (number: number, overrides: Readonly<Partial<IssueFacts>> = {}): IssueFacts => ({ ref: reference(number), state: 'open', column: 'Ready', label: undefined, kind: 'task', branches: [], pullRequests: [], ...overrides })
  const prerequisite = (number: number, pullRequest: IssuePullRequest): Prerequisite => ({ issue: facts(number, { pullRequests: [pullRequest] }), wait: 'stack', reason: undefined })
  const board: BoardShape = boardShapeOf([WORKFLOW_FIELD, STATUS_FIELD], CONFIG)
  const request = (prerequisites: readonly Prerequisite[], pullRequests: readonly IssuePullRequest[]) => ({
    target: facts(1),
    prerequisites,
    hasPrerequisites: prerequisites.length > 0,
    board,
    pullRequests: new Map(pullRequests.map(pullRequest => [`acme/app#${String(pullRequest.number)}`, pullRequest])),
    developmentBranch: 'main',
  })

  it('前提が無ければ、startable と判定し、スタックの決めを求めない', async () => {
    await explains('`judgeMove` のテストです。前提が無い Issue の場合に、startable の判定になり、スタックを決められない理由が無いことを確認します。')
    const judged = judgeMove(request([], []))
    expect(judged.readiness?.kind).toBe('startable')
    expect(judged.stackUndecided).toBeUndefined()
  })

  it('Epic の Issue には、判定も列の動きも出さない', async () => {
    await explains('`judgeMove` のテストです。対象が Epic の場合に、判定を出さず、列と札の動きも出さないことを確認します。')
    const judged = judgeMove({ ...request([], []), target: facts(1, { kind: 'epic' }) })
    expect([judged.readiness, judged.move, judged.stackUndecided]).toEqual([undefined, undefined, undefined])
  })

  it('前提の PR のブランチを読んでいなければ、読んでいない PR を理由にする', async () => {
    await explains('`judgeMove` のテストです。前提の PR の head が空の場合に、スタックを決められない理由を読んでいない PR にし、その PR を示すことを確認します。')
    const unread = pull(9, '', '')
    const judged = judgeMove(request([prerequisite(2, unread)], []))
    expect(judged.stackUndecided).toEqual({ kind: 'unread-pull-requests', pullRequests: [unread] })
  })

  it.for([undefined, ''])('開発ブランチが %j だと、開発ブランチの未設定を理由にする', async (branch) => {
    await explains('`judgeMove` のテストです。対象のリポの開発ブランチが無いか空の場合に、スタックを決められない理由を開発ブランチの未設定にすることを確認します。')
    const open = pull(9, 'a', 'main')
    const judged = judgeMove({ ...request([prerequisite(2, open)], [open]), developmentBranch: branch })
    expect(judged.stackUndecided).toEqual({ kind: 'no-develop-branch', repository: HOME })
  })

  it('前提の PR が開発ブランチに届けば、stackable と判定し、決められない理由を持たない', async () => {
    await explains('`judgeMove` のテストです。前提の PR の base が開発ブランチの場合に、stackable の判定になり、スタックを決められない理由が無いことを確認します。')
    const open = pull(9, 'a', 'main')
    const judged = judgeMove(request([prerequisite(2, open)], [open]))
    expect([judged.readiness?.kind, judged.readiness?.stackOn?.branch, judged.stackUndecided]).toEqual(['stackable', 'a', undefined])
  })

  it('前提の PR の base をたどれなければ、見つからない base を理由にする', async () => {
    await explains('`judgeMove` のテストです。前提の PR 2 本のうち 1 本の base が、読んだ PR の head に無いとします。判定が diverged になり、その base を理由に挙げることを確認します。')
    const a = pull(8, 'a', 'main')
    const b = pull(9, 'b', 'ghost')
    const judged = judgeMove(request([prerequisite(2, a), prerequisite(3, b)], [a, b]))
    expect(judged.readiness?.reason?.code).toBe('diverged')
    expect(judged.stackUndecided).toEqual({ kind: 'missing-bases', branches: ['ghost'] })
  })

  it('前提の PR の base が輪になっていれば、見つからない base を理由にしない', async () => {
    await explains('`judgeMove` のテストです。前提の PR の base が互いの head を指して輪になるとします。判定は diverged のままで、見つからない base を理由にしないことを確認します。')
    const c = pull(8, 'c', 'd')
    const d = pull(9, 'd', 'c')
    const judged = judgeMove(request([prerequisite(2, c), prerequisite(3, d)], [c, d]))
    expect(judged.readiness?.reason?.code).toBe('diverged')
    expect(judged.stackUndecided).toBeUndefined()
  })

  it('base が別の PR の head を経て開発ブランチに届けば、届かない PR の base だけを理由にする', async () => {
    await explains('`judgeMove` のテストです。前提の PR の base が別の PR の head を経て開発ブランチに届くとします。届かない 1 本の base だけを理由にすることを確認します。')
    const a = pull(8, 'a', 'main')
    const b = pull(9, 'b', 'a')
    const c = pull(10, 'c', 'ghost')
    const judged = judgeMove(request([prerequisite(2, b), prerequisite(3, c)], [a, b, c]))
    expect(judged.stackUndecided).toEqual({ kind: 'missing-bases', branches: ['ghost'] })
  })

  it('ボードに Blocked が無ければ、Blocked へ動かさず、足りない値に挙げる', async () => {
    await explains('`judgeMove` のテストです。判定が blocked でボードに Blocked の選択肢が無い場合に、列を動かさず、足りない値に Blocked を挙げることを確認します。')
    const noBlocked = boardShapeOf([field({ id: '10', nodeId: 'WF', name: 'Workflow', dataType: 'SINGLE_SELECT', options: [{ id: 'o-ready', name: 'Ready' }] })], CONFIG)
    const closed: Prerequisite = { issue: facts(2, { state: 'closed' }), wait: 'stack', reason: undefined }
    const judged = judgeMove({ ...request([closed], []), board: noBlocked })
    expect(judged.readiness?.kind).toBe('blocked')
    expect(judged.move?.column).toBeUndefined()
    expect(judged.move?.missing).toContain('Blocked')
  })
})

describe('configFor', () => {
  it('どの設定にも無いリポなら、見つからない理由の文を返す', async () => {
    await explains('`configFor` のテストです。プロジェクトの設定が 1 つも無い環境で、そのリポが設定に無いことを示す文を返すことを確認します。')
    const choice = configFor(HOME, undefined, ['issue', 'check'])
    expect(choice.kind).toBe('problem')
    expect(choice.kind === 'problem' && choice.message).toContain('acme/app is not in any project config')
  })

  it('名前を指定した設定が無ければ、その名前を示す文を返す', async () => {
    await explains('`configFor` のテストです。存在しない設定の名前を指定した場合に、設定が見つからないことを名前つきで示す文を返すことを確認します。')
    const choice = configFor(HOME, 'nope', ['issue', 'check'])
    expect(choice.kind === 'problem' && choice.message).toContain('project config not found: nope')
  })
})

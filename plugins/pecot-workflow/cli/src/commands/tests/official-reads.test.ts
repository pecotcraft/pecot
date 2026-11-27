/* eslint-disable unicorn/no-null -- 公式の結果の JSON にある null を再現する */
// 公式の GitHub MCP の読み取りの結果を、確かめて domain の型へ写す関数の振る舞い。
import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { createIssueReference } from '@pecot/workflow-core/domain/reference-parser.js'
import { createRepositoryReference } from '@pecot/workflow-core/domain/repository-resolver.js'
import {
  blockedByOf,
  cardsOf,
  collaboratorLoginsOf,
  ISSUE_DEPENDENCY_READ,
  ISSUE_READ_GET,
  ISSUE_READ_SUB_ISSUES,
  LIST_ISSUE_FIELDS,
  PROJECTS_LIST_FIELDS,
  PROJECTS_LIST_ITEMS,
  issueFactsOf,
  issueFieldDefinitionsOf,
  issueTypeNamesOf,
  parseOfficial,
  projectDefinitionsOf,
  projectFieldsOf,
  PULL_REQUEST_READ_GET,
  readIssueOf,
  readPullRequestOf,
  referenceFromUrl,
  referenceOf,
  subIssueTitlesOf,
} from '../official-reads.js'
import type { ProjectsListItems, ReadIssue } from '../official-reads.js'
import { capture } from './support.js'

const HOME = createRepositoryReference('acme', 'app')
const ISSUE_URL = 'https://github.com/acme/app/issues/5'

const readPull = (overrides: Readonly<Record<string, unknown>> = {}) => PULL_REQUEST_READ_GET.parse({
  number: 7,
  state: 'open',
  draft: false,
  merged: false,
  html_url: 'https://github.com/acme/app/pull/7',
  head: { ref: 'feat', repo: { full_name: 'Acme/App' } },
  base: { ref: 'main', repo: { full_name: 'acme/app' } },
  ...overrides,
})

const readIssue = (issue: Readonly<Record<string, unknown>>) => ISSUE_READ_GET.parse({ issue: { number: 5, title: 'T', state: 'OPEN', html_url: ISSUE_URL, ...issue } })

const items = (value: readonly unknown[]): ProjectsListItems => PROJECTS_LIST_ITEMS.parse({ items: { items: value } })

function stopOf(run: () => unknown): CommandExit {
  try {
    run()
  }
  catch (error: unknown) {
    if (error instanceof CommandExit) return error
    throw error
  }
  throw new Error('止まらなかった')
}

describe('parseOfficial', () => {
  it('形が合えば、確かめた値をそのまま返す', async () => {
    await explains('`parseOfficial` のテストです。Issue の結果が schema に合うときは、止まらず、確かめた値を返すことを確認します。')
    const io = capture()
    const value = { issue: { number: 5, title: 'T', state: 'open', html_url: ISSUE_URL } }
    expect(parseOfficial(createOutput(false, io), 'issue_read', ISSUE_READ_GET, value).issue.number).toBe(5)
    expect(io.err).toEqual([])
  })

  it('形が合わなければ、項目の path を添えて github-mcp-shape で止める', async () => {
    await explains('`parseOfficial` のテストです。入れ子の項目の型が違う場合に、ツール名・入力の置き場所・項目の path を表示し、`github-mcp-shape` で終了コード 1 になることを確認します。')
    const io = capture()
    const stop = stopOf(() => parseOfficial(createOutput(false, io), 'issue_read', ISSUE_READ_GET, { issue: { number: 'x' } }, 'reads.issues[0]'))
    expect(stop.exitCode).toBe(1)
    expect(stop.kind).toBe('github-mcp-shape')
    const text = io.err.join('')
    expect(text).toContain('the result of issue_read in reads.issues[0] is not in the shape of the official GitHub MCP server')
    expect(text).toContain('issue.number: ')
    expect(text).toContain('issue.title: ')
  })

  it('値の根が合わず置き場所も無ければ、(root) を示してツール名だけを表示する', async () => {
    await explains('`parseOfficial` のテストです。値が配列で、入力の置き場所を渡さない場合に、項目の path を `(root)` と表示し、置き場所を含まない文で止めることを確認します。')
    const io = capture()
    const stop = stopOf(() => parseOfficial(createOutput(false, io), 'issue_read', ISSUE_READ_GET, []))
    expect(stop.kind).toBe('github-mcp-shape')
    expect(io.err.join('')).toContain('the result of issue_read is not in the shape of the official GitHub MCP server\n  (root): ')
  })
})

describe('referenceFromUrl', () => {
  it.for([
    { name: 'Issue の URL', url: ISSUE_URL, expected: 'acme/app#5' },
    { name: 'PR の URL（後ろにパスが付く）', url: 'https://github.com/acme/app/pull/7/files', expected: 'acme/app#7' },
    { name: '末尾に fragment が付く URL', url: 'https://github.com/acme/app/issues/9#issuecomment-1', expected: 'acme/app#9' },
  ])('$name を渡すと、$expected の参照を返す', async (row) => {
    await explains(`\`referenceFromUrl\` のテストです。URL \`${row.url}\` から、\`${row.expected}\` の参照を取り出すことを確認します。`)
    const reference = referenceFromUrl(row.url)
    expect(reference === undefined ? undefined : `${reference.repository.owner}/${reference.repository.repository}#${String(reference.number)}`).toBe(row.expected)
  })

  it.for([
    { name: 'Issue でも PR でもない URL', url: 'https://github.com/acme/app/discussions/5' },
    { name: '番号が 0 の URL', url: 'https://github.com/acme/app/issues/0' },
    { name: 'URL でない文字列', url: 'acme/app#5' },
  ])('$name を渡すと、undefined を返す', async (row) => {
    await explains(`\`referenceFromUrl\` のテストです。\`${row.url}\` は参照として読めないので、undefined を返すことを確認します。`)
    expect(referenceFromUrl(row.url)).toBeUndefined()
  })
})

describe('referenceOf', () => {
  it('owner/name の形と番号から、参照を返す', async () => {
    await explains('`referenceOf` のテストです。`acme/app` と番号 3 から、同じ repository と番号の参照を返すことを確認します。')
    expect(referenceOf('acme/app', 3)).toEqual(createIssueReference(HOME, 3))
  })

  it.for([
    { name: 'スラッシュが無い repository', repository: 'acme', number: 3 },
    { name: 'スラッシュが 2 つある repository', repository: 'a/b/c', number: 3 },
    { name: '番号が 0 の参照', repository: 'acme/app', number: 0 },
  ])('$name を渡すと、undefined を返す', async (row) => {
    await explains(`\`referenceOf\` のテストです。repository \`${row.repository}\` と番号 ${String(row.number)} は参照にならないので、undefined を返すことを確認します。`)
    expect(referenceOf(row.repository, row.number)).toBeUndefined()
  })
})

describe('readPullRequestOf', () => {
  it('同じ repository の PR は、fork でない PR として返す', async () => {
    await explains('`readPullRequestOf` のテストです。head と base の repository が大文字小文字を除いて同じ場合に、fork でない open の PR にすることを確認します。')
    const pullRequest = readPullRequestOf(createOutput(false, capture()), readPull(), 'reads.pull_requests[0]')
    expect(pullRequest).toEqual({ repository: HOME, number: 7, state: 'open', headRefName: 'feat', baseRefName: 'main', isDraft: false, isCrossRepository: false })
  })

  it('head の repository が違えば fork の PR にし、マージ済みなら merged にする', async () => {
    await explains('`readPullRequestOf` のテストです。head の repository が base と違い、merged が true の場合に、fork の PR で状態が merged になることを確認します。')
    const pullRequest = readPullRequestOf(createOutput(false, capture()), readPull({ merged: true, state: 'closed', head: { ref: 'f', repo: { full_name: 'fork/app' } } }), 'w')
    expect(pullRequest.state).toBe('merged')
    expect(pullRequest.isCrossRepository).toBe(true)
  })

  it('repo が null なら、fork かを決めず、fork でない PR にする', async () => {
    await explains('`readPullRequestOf` のテストです。head の repo が null（削除された fork）の場合に、fork とみなさないことを確認します。')
    const pullRequest = readPullRequestOf(createOutput(false, capture()), readPull({ head: { ref: 'f', repo: null } }), 'w')
    expect(pullRequest.isCrossRepository).toBe(false)
  })

  it('html_url が PR の URL でなければ、github-mcp-shape で止める', async () => {
    await explains('`readPullRequestOf` のテストです。html_url が PR の URL でない場合に、その値を表示し、`github-mcp-shape` で止めることを確認します。')
    const io = capture()
    const stop = stopOf(() => readPullRequestOf(createOutput(false, io), readPull({ html_url: 'https://example.com/x' }), 'reads.pull_requests[2]'))
    expect(stop.kind).toBe('github-mcp-shape')
    expect(io.err.join('')).toContain('the result of pull_request_read in reads.pull_requests[2] is not in the shape of the official GitHub MCP server\n  html_url: not a pull request URL: https://example.com/x')
  })
})

describe('readIssueOf', () => {
  it('参照・題・状態・本文を写し、本文が無ければ空にする', async () => {
    await explains('`readIssueOf` のテストです。state が大文字の OPEN で本文が無い Issue から、小文字の open と空の本文を持つ Issue を作ることを確認します。')
    const issue = readIssueOf(createOutput(false, capture()), readIssue({}), 'w')
    expect(issue).toEqual({ ref: createIssueReference(HOME, 5), title: 'T', state: 'open', body: '', pullRequests: [] })
  })

  it('state が closed の Issue は closed にし、本文をそのまま写す', async () => {
    await explains('`readIssueOf` のテストです。state が CLOSED で本文がある場合に、closed の Issue になり本文が変わらないことを確認します。')
    const issue = readIssueOf(createOutput(false, capture()), readIssue({ state: 'CLOSED', body: 'text' }), 'w')
    expect(issue.state).toBe('closed')
    expect(issue.body).toBe('text')
  })

  it('閉じる PR を、状態を読み替え、置き場所の取り方を変えて写し、状態が読めない PR は飛ばす', async () => {
    await explains('`readIssueOf` のテストです。閉じる PR の状態を読み替え、不明な状態の PR は飛ばします。repository が読めない PR は、Issue と同じ repository にすることを確認します。')
    const issue = readIssueOf(createOutput(false, capture()), readIssue({
      closed_by_pull_requests: {
        references: [
          { number: 1, state: 'MERGED', url: 'https://github.com/x/y/pull/1', repository: 'other/repo' },
          { number: 2, state: 'closed', url: 'https://github.com/x/y/pull/2' },
          { number: 3, state: 'OPEN', url: 'not a url' },
          { number: 4, state: 'DRAFT', url: 'https://github.com/x/y/pull/4' },
          { number: 5, state: 'OPEN', url: 'https://github.com/x/y/pull/5', repository: 'broken' },
        ],
      },
    }), 'w')
    expect(issue.pullRequests.map(pullRequest => [pullRequest.number, pullRequest.state, `${pullRequest.repository.owner}/${pullRequest.repository.repository}`])).toEqual([
      [1, 'merged', 'other/repo'],
      [2, 'closed', 'x/y'],
      [3, 'open', 'acme/app'],
      [5, 'open', 'x/y'],
    ])
    expect(issue.pullRequests[0]).toMatchObject({ headRefName: '', baseRefName: '', isDraft: false, isCrossRepository: false })
  })

  it('html_url が Issue の URL でなければ、github-mcp-shape で止める', async () => {
    await explains('`readIssueOf` のテストです。html_url が Issue の URL でない場合に、その値を表示し、`github-mcp-shape` で止めることを確認します。')
    const io = capture()
    const stop = stopOf(() => readIssueOf(createOutput(false, io), readIssue({ html_url: 'https://example.com/x' }), 'reads.issues[1]'))
    expect(stop.kind).toBe('github-mcp-shape')
    expect(io.err.join('')).toContain('issue.html_url: not an Issue URL: https://example.com/x')
  })
})

describe('cardsOf', () => {
  it('欄の値を、文字列・数・name・title の形から取り、欄の名前は小文字にする', async () => {
    await explains('`cardsOf` のテストです。欄の値が文字列・数・name を持つ object・title を持つ object の場合に、値の名前を取り、欄の名前を小文字にしてカードに入れることを確認します。')
    const cards = cardsOf([items([{
      content: { number: 5, repository: 'acme/app' },
      fields: [
        { id: 1, name: 'Workflow', value: { name: 'Ready' } },
        { id: 2, name: 'Status', value: 'Todo' },
        { id: 3, name: 'Size', value: 3 },
        { id: 4, name: 'Sprint', value: { title: 'S1' } },
      ],
    }])])
    expect(cards.get('acme/app#5')?.fields).toEqual(new Map([['workflow', 'Ready'], ['status', 'Todo'], ['size', '3'], ['sprint', 'S1']]))
  })

  it('名前を取れない値の欄は、カードに入れない', async () => {
    await explains('`cardsOf` のテストです。null・真偽値の値と、name と title を持たない object の値と、値の無い欄は、カードに入れないことを確認します。')
    const cards = cardsOf([items([{
      content: { number: 5, repository: 'acme/app' },
      fields: [
        { id: 1, name: 'A', value: null },
        { id: 2, name: 'B', value: true },
        { id: 3, name: 'C', value: { other: 1 } },
        { id: 4, name: 'D' },
      ],
    }])])
    expect(cards.get('acme/app#5')?.fields.size).toBe(0)
  })

  it('content が無いか repository が読めないカードは飛ばし、欄が無くても空の欄でカードにする', async () => {
    await explains('`cardsOf` のテストです。content が null か無い項目と repository が読めない項目は飛ばし、fields が null の項目は空の欄を持つカードにすることを確認します。')
    const cards = cardsOf([
      items([
        { content: null, fields: [] },
        { fields: [] },
        { content: { number: 1, repository: 'broken' }, fields: [] },
        { content: { number: 2, repository: 'acme/app' }, fields: null },
      ]),
      { items: {} },
    ])
    expect(cards.size).toBe(1)
    expect(cards.has('acme/app#2')).toBe(true)
    expect(cards.get('acme/app#2')?.fields.size).toBe(0)
  })
})

describe('issueFactsOf', () => {
  const issue: ReadIssue = { ref: createIssueReference(HOME, 5), title: 'T', state: 'open', body: '', pullRequests: [] }
  const names = { column: 'Workflow', label: 'Status' }

  it('カードがあれば、欄の名前（小文字）で列と札を引く', async () => {
    await explains('`issueFactsOf` のテストです。カードが Workflow と Status の欄を持つ場合に、列と札の値を事実に入れ、種類の既定が task になることを確認します。')
    const card = { ref: issue.ref, fields: new Map([['workflow', 'Ready'], ['status', 'Todo']]) }
    expect(issueFactsOf(issue, card, names)).toEqual({ ref: issue.ref, state: 'open', column: 'Ready', label: 'Todo', kind: 'task', branches: [], pullRequests: [] })
  })

  it('カードが無ければ列と札を空にし、渡した種類を使う', async () => {
    await explains('`issueFactsOf` のテストです。カードが無い場合に、列と札が undefined になり、渡した種類 epic が事実に入ることを確認します。')
    const facts = issueFactsOf(issue, undefined, names, 'epic')
    expect(facts.column).toBeUndefined()
    expect(facts.label).toBeUndefined()
    expect(facts.kind).toBe('epic')
  })
})

describe('subIssueTitlesOf', () => {
  it('番号か題の無い子は飛ばし、状態は大文字にする', async () => {
    await explains('`subIssueTitlesOf` のテストです。null の子・番号が null の子・題が無い子は飛ばし、状態を大文字にし、状態が無ければ空の文字にすることを確認します。')
    const read = ISSUE_READ_SUB_ISSUES.parse({
      sub_issues: [null, { number: null, title: 't' }, { number: 2 }, { number: 3, title: null }, { number: 4, title: 'Four', state: 'open' }, { number: 5, title: 'Five' }],
    })
    expect(subIssueTitlesOf(read)).toEqual([{ number: 4, state: 'OPEN', title: 'Four' }, { number: 5, state: '', title: 'Five' }])
  })

  it('sub_issues が無ければ、空の配列を返す', async () => {
    await explains('`subIssueTitlesOf` のテストです。sub_issues が無い結果から、空の配列を返すことを確認します。')
    expect(subIssueTitlesOf({})).toEqual([])
  })
})

describe('blockedByOf', () => {
  it('repository か html_url から参照を取り、状態を open と closed にそろえ、取れない前提は飛ばす', async () => {
    await explains('`blockedByOf` のテストです。前提が repository を持つ場合と html_url だけの場合に、参照と状態を取ります。どちらも無い前提は飛ばすことを確認します。')
    const read = ISSUE_DEPENDENCY_READ.parse({
      issues: [
        { number: 1, state: 'CLOSED', repository: 'other/repo' },
        { number: 2, state: 'open', html_url: 'https://github.com/x/y/issues/2' },
        { number: 3, state: 'open' },
        { number: 4, state: 'open', repository: 'broken' },
      ],
    })
    expect(blockedByOf(read).map(entry => [entry.ref.number, `${entry.ref.repository.owner}/${entry.ref.repository.repository}`, entry.state])).toEqual([
      [1, 'other/repo', 'closed'],
      [2, 'x/y', 'open'],
    ])
  })

  it('issues が無ければ、空の配列を返す', async () => {
    await explains('`blockedByOf` のテストです。issues が無い結果から、空の配列を返すことを確認します。')
    expect(blockedByOf({})).toEqual([])
  })
})

describe('projectFieldsOf と projectDefinitionsOf', () => {
  const read = PROJECTS_LIST_FIELDS.parse({
    fields: {
      fields: [
        { id: 11, node_id: 'PVTSSF_w', name: 'Workflow', data_type: 'single_select', options: [{ id: 'o1', name: { raw: 'Ready' } }] },
        { id: 12, name: 'Sprint', data_type: 'iteration', configuration: { iterations: [{ id: 'i1', title: { raw: 'S1' }, start_date: '2026-01-01' }, { id: 'i2', title: { raw: 'S2' } }] } },
        { id: 13, name: 'Labels', data_type: 'labels' },
      ],
    },
  })

  it('欄の ID を文字にし、data_type を大文字にし、選択肢と反復を options にまとめる', async () => {
    await explains('`projectFieldsOf` のテストです。選択肢を持つ欄と反復を持つ欄から、ID が文字で data_type が大文字の欄を作り、開始日のある反復だけ startDate を持つことを確認します。')
    const fields = projectFieldsOf(read)
    expect(fields).toEqual([
      { id: '11', nodeId: 'PVTSSF_w', name: 'Workflow', dataType: 'SINGLE_SELECT', options: [{ id: 'o1', name: 'Ready' }] },
      { id: '12', nodeId: undefined, name: 'Sprint', dataType: 'ITERATION', options: [{ id: 'i1', name: 'S1', startDate: '2026-01-01' }, { id: 'i2', name: 'S2' }] },
      { id: '13', nodeId: undefined, name: 'Labels', dataType: 'LABELS', options: [] },
    ])
  })

  it('fields が無ければ、空の配列を返す', async () => {
    await explains('`projectFieldsOf` のテストです。fields が null の結果から、空の配列を返すことを確認します。')
    expect(projectFieldsOf({ fields: { fields: null } })).toEqual([])
  })

  it('組み込みの欄を外し、ほかの欄の数の ID を書き込み用の ID へ直した定義を返す', async () => {
    await explains('`projectDefinitionsOf` のテストです。Labels の欄は定義にせず、Workflow と Sprint の欄は定義にして、fieldId を数の ID にすることを確認します。')
    const definitions = projectDefinitionsOf(projectFieldsOf(read), 'PVTSSF_w')
    expect(definitions.map(definition => [definition.name, definition.fieldId])).toEqual([['Workflow', '11'], ['Sprint', '12']])
  })
})

describe('issueFieldDefinitionsOf', () => {
  it('full_database_id があればそれを、無ければ id を、書くときの ID にする', async () => {
    await explains('`issueFieldDefinitionsOf` のテストです。full_database_id が数の場合・無い場合に、書くときの ID を文字にした full_database_id か id にすることと、選択肢の id が無くても写すことを確認します。')
    const read = LIST_ISSUE_FIELDS.parse([
      { id: 'IF_1', name: 'Priority', data_type: 'single_select', full_database_id: 99, options: [{ id: 'p1', name: 'High' }, { name: 'Low' }] },
      { id: 'IF_2', name: 'Note', data_type: 'text' },
    ])
    const definitions = issueFieldDefinitionsOf(read)
    expect(definitions.map(definition => [definition.name, definition.fieldId])).toEqual([['Priority', '99'], ['Note', 'IF_2']])
    expect(definitions[0]?.options).toEqual([{ id: 'p1', name: 'High' }, { name: 'Low' }])
  })

  it('結果が null なら、空の配列を返す', async () => {
    await explains('`issueFieldDefinitionsOf` のテストです。結果が null の場合に、空の配列を返すことを確認します。')
    expect(issueFieldDefinitionsOf(null)).toEqual([])
  })
})

describe('issueTypeNamesOf', () => {
  it('名前の無い type と、使えない type は外す', async () => {
    await explains('`issueTypeNamesOf` のテストです。名前が null か無い type と、is_enabled が false の type を外し、使える type の名前だけを返すことを確認します。')
    expect(issueTypeNamesOf([{ name: 'Task', is_enabled: true }, { name: 'Bug' }, { name: null }, {}, { name: 'Old', is_enabled: false }])).toEqual(['Task', 'Bug'])
  })

  it('結果が null なら、空の配列を返す', async () => {
    await explains('`issueTypeNamesOf` のテストです。結果が null の場合に、空の配列を返すことを確認します。')
    expect(issueTypeNamesOf(null)).toEqual([])
  })
})

describe('collaboratorLoginsOf', () => {
  it('collaborator の login を並べ、items が無ければ空の配列を返す', async () => {
    await explains('`collaboratorLoginsOf` のテストです。items がある結果からは login を並べ、items が無い結果からは空の配列を返すことを確認します。')
    expect(collaboratorLoginsOf({ items: [{ login: 'a' }, { login: 'b' }] })).toEqual(['a', 'b'])
    expect(collaboratorLoginsOf({})).toEqual([])
  })
})

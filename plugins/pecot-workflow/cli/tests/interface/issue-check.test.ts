// issue_check の振る舞いを、MCP のツールの結果で確かめる。前後比較（FR-020）の入力は、消した issue_create・issue_edit・issue_check の golden の書き込みを写したもの。
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { step } from '../../../../../libs/interface-spec/src/vitest/step.js'
import { ISSUE_CHECK_TOOLS } from '../../src/commands/issue-check.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { setUpProject } from '../_helpers/interface-case.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'

useIsolatedEnvironment()

const CONFIG_FILE = 'ghes.example.com_acme_board_acme.json'
const WORKFLOW_OPTIONS = { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6', blocked: 'o7' }
const CONFIG = {
  host: 'ghes.example.com',
  owner: 'acme',
  project: { number: 1, id: 'PVT_1', board_url: 'https://ghes.example.com/users/acme/projects/1', fields: { workflow: { id: 'PVTSSF_workflow', options: WORKFLOW_OPTIONS } } },
  repositories: [{ owner: 'acme', name: 'demo', develop_branch: 'main' }],
}

const TASK = 'pecot-template://issue/task'
// golden の issue-create-ok-file・issue-create-ok-message の本文
const TASK_BODY = [
  '## Goal — 一覧画面から状態を確認できる',
  '',
  '利用者が一覧画面で各項目の状態を確認できる。',
  '',
  '## Acceptance — 一覧に状態の列が出る',
  '',
  '- 状態の列が一覧に出る — 確認: 一覧画面を開く',
  '',
].join('\n')
const FIRST_BODY = '## Goal — 先の Issue が作られる\n\n先の作業を終える。\n\n## Acceptance — 先の作業が終わる\n\n- 先の作業の成果が出る — 確認: 画面を開く\n'
const SECOND_BODY = '## Goal — 後の Issue が作られる\n\n{{issue:first}} の完了後に着手する。\n\n## Acceptance — 後の作業が終わる\n\n- 後の作業の成果が出る — 確認: 画面を開く\n'
const FREEFORM_FOOTER = '<!-- issue_check の自由形式で起票（テンプレートの検証なし）。起票ルール: skills/w-help/references/issue-flow-rules.md#起票時の既定-status -->'

function option(id: string, name: string): Readonly<Record<string, unknown>> {
  return { id, name: { raw: name, html: name } }
}

function boardFields(extra: readonly Readonly<Record<string, unknown>>[] = []): Readonly<Record<string, unknown>> {
  const workflow = { id: 101, node_id: 'PVTSSF_workflow', name: 'pecot-status', data_type: 'single_select', options: [
    option('o1', 'Backlog'), option('o2', 'Pending'), option('o3', 'Ready'), option('o4', 'Active'), option('o5', 'In Review'), option('o6', 'Archived'), option('o7', 'Blocked'),
  ] }
  const status = { id: 102, node_id: 'PVTSSF_status', name: 'Status', data_type: 'single_select', options: [option('s1', 'Todo'), option('s2', 'Needs Attention')] }
  const area = { id: 103, node_id: 'PVTSSF_area', name: 'Area', data_type: 'single_select', options: [option('a1', 'cli'), option('a2', 'docs')] }
  return { fields: { fields: [workflow, status, area, ...extra] } }
}

const PROJECT_FIELDS = boardFields()
const SUB_ISSUES = [{ parent: 'acme/demo/3', result: { sub_issues: [{ number: 9, state: 'open', title: '#3-01: 先の子' }] } }]
const DEMO = { owner: 'acme', repo: 'demo' }
const PARENT = { parent_owner: 'acme', parent_repo: 'demo', parent_issue_number: 3 }
const READY = [{ name: 'pecot-status', value: 'Ready' }]

// golden の issue-create-ok-file の書き込み。親 Epic acme/demo/3 の 2 番目の子
const CHILD = { kind: 'task', template: TASK, ...DEMO, title: '[Task] #3-02: 一覧に状態を出す', body: TASK_BODY, ...PARENT, project_fields: READY }
const CHILD_READS = { project_fields: PROJECT_FIELDS, sub_issues: SUB_ISSUES }

const PROBLEMS = z.array(z.record(z.string(), z.unknown()))

// 開いた Issue を issue_read（get）で読んだ結果。pullRequest があれば、その番号の開いた PR が閉じる
function prerequisiteRead(number: number, pullRequest?: number): Readonly<Record<string, unknown>> {
  const closing = pullRequest === undefined ? {} : { closed_by_pull_requests: { references: [{ number: pullRequest, state: 'OPEN', url: `https://ghes.example.com/acme/demo/pull/${String(pullRequest)}` }] } }
  return { issue: { number, title: '[Task] 先の作業', state: 'open', body: '', html_url: `https://ghes.example.com/acme/demo/issues/${String(number)}`, ...closing } }
}

// main へ向く開いた PR を pull_request_read（get）で読んだ結果
function pullRequestRead(number: number, head: string): Readonly<Record<string, unknown>> {
  const branch = (reference: string): Readonly<Record<string, unknown>> => ({ ref: reference, sha: '0123456789abcdef0123456789abcdef01234567', repo: { full_name: 'acme/demo' } })
  return { number, title: `PR ${String(number)}`, state: 'open', draft: false, merged: false, html_url: `https://ghes.example.com/acme/demo/pull/${String(number)}`, head: branch(head), base: branch('main') }
}

function useProject(): void {
  setUpProject({ files: { [`.pecot/config/projects/${CONFIG_FILE}`]: `${JSON.stringify(CONFIG)}\n` } })
}

async function check(arguments_: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  return await step('issue_check を呼ぶ', async () => await callToolOnce(ISSUE_CHECK_TOOLS, 'issue_check', arguments_))
}

async function createOne(issue: Readonly<Record<string, unknown>>, reads: Readonly<Record<string, unknown>> = CHILD_READS): Promise<ToolOutcome> {
  return await check({ method: 'create', issues: [{ ...CHILD, ...issue }], reads })
}

function problemsOf(outcome: Readonly<ToolOutcome>): readonly Readonly<Record<string, unknown>>[] {
  expect(outcome.isError).toBe(false)
  expect(outcome.structured['problems']).not.toEqual([])
  return PROBLEMS.parse(outcome.structured['problems'])
}

function codesOf(outcome: Readonly<ToolOutcome>): readonly (readonly unknown[])[] {
  return problemsOf(outcome).map(problem => [problem['field'], problem['code']])
}

describe('issue_check', () => {
  describe('消したツールの golden の書き込み', () => {
    it('issue_create が親 Epic の子として起票した書き込みを渡すと、problem の無い結果と番号の案を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-01')
      await verifies(context, 'PW-ISSUE-CHECK-02')
      await explains('消した `issue_create` の golden（`issue-create-ok-file`）が書いた題・本文・親・列を、`issue_check` の入力に写したテストです。問題の無い結果と、番号 2 の単独の進め方を返すことを確認します。')
      useProject()
      const outcome = await createOne({})
      await step('結果を確かめる', () => {
        expect(outcome).toMatchObject({ isError: false, structured: { problems: [], plan: [{ key: 'issues[0]', order: 2, blockedBy: [], approach: 'alone' }] } })
        expect(outcome.structured).not.toHaveProperty('stackableChains')
      })
    })

    it('issue_create が親 Epic の無い Issue を起票した書き込みを渡すと、problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-01')
      await explains('消した `issue_create` の golden（`issue-create-ok-message`）が書いた本文を、親 Epic の無い Issue として渡すテストです。問題の無い結果と、番号の無い単独の進め方を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'create', issues: [{ kind: 'task', template: TASK, ...DEMO, title: '[Task] 一覧に状態を出す', body: TASK_BODY, project_fields: READY }], reads: { project_fields: PROJECT_FIELDS } })
      await step('結果を確かめる', () => {
        expect(outcome).toMatchObject({ isError: false, structured: { problems: [], plan: [{ key: 'issues[0]', blockedBy: [], approach: 'alone' }] } })
      })
    })

    it('一括の起票で後の Issue が先の Issue を前提に持つと、problem の無い結果とスタックできる並びを返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-01')
      await verifies(context, 'PW-ISSUE-CHECK-02')
      await explains('消した `issue_check`・`issue_create` の golden（`issue-check-ok-files` など）の 2 件の起票を、`key` と `blocked_by` で渡すテストです。後の Issue を先の Issue にスタックする進め方と、スタックできる並びを返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'create', issues: [
        { key: 'first', kind: 'task', template: TASK, ...DEMO, title: '[Task] #3-02: 先に作る Issue', body: FIRST_BODY, ...PARENT, project_fields: READY },
        { key: 'second', kind: 'task', template: TASK, ...DEMO, title: '[Task] #3-03: 後に作る Issue', body: SECOND_BODY, ...PARENT, blocked_by: [{ issue: 'first' }], project_fields: [{ name: 'pecot-status', value: 'Blocked' }] },
      ], reads: CHILD_READS })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toEqual({
          problems: [],
          plan: [
            { key: 'first', order: 2, blockedBy: [], approach: 'alone' },
            { key: 'second', order: 3, blockedBy: [{ issue: 'first', wait: 'stack' }], approach: 'stack', stackOn: 'first' },
          ],
          stackableChains: [['first', 'second']],
        })
        expect(outcome.text).toBe('ok')
      })
    })

    it('issue_edit がボードの欄を書き換えた書き込みを渡すと、problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-01')
      await explains('消した `issue_edit` の golden（`issue-edit-ok`）がボードの欄 `Area` を `docs` に書き換えた操作を、`method` が `update` の入力に写したテストです。問題の無い結果を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'update', issues: [{ kind: 'task', ...DEMO, issue_number: 7, project_fields: [{ name: 'Area', value: 'docs' }] }], reads: { project_fields: PROJECT_FIELDS } })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toEqual({ problems: [] })
      })
    })

    it('issue_create がテンプレート違反で止めた本文を渡すと、不足している見出しを problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-05')
      await explains('消した `issue_create` の golden（`issue-create-state-template-violation`）の、`Acceptance` の見出しを持たない本文のテストです。ツールの失敗にせず、`missing-section` の問題を返すことを確認します。')
      useProject()
      const outcome = await createOne({ body: '## Goal — 一覧画面から状態を確認できる\n\n利用者が一覧画面で各項目の状態を確認できる。\n' })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['body', 'missing-section']])
      })
    })
  })

  describe('題と番号', () => {
    it('task の題が [Task] で始まらないと、接頭辞を付けた題を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-03')
      await explains('`kind` が `task` で、題が `[Task]` の接頭辞を持たない場合のテストです。`title-prefix` の問題を返し、接頭辞と番号を付けた題を候補に含めることを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ title: '#3-02: 一覧に状態を出す' }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'title', code: 'title-prefix', candidates: ['[Task] #3-02: 一覧に状態を出す'] })])
      })
    })

    it('親 Epic の子が使っている番号を題に書くと、次の空き番号を添えて problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-03')
      await explains('親 Epic の既存の子（`#3-01`）と同じ番号を題に書いた場合のテストです。`order-conflict` の問題を返し、文に次の空き番号 2 を含めることを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ title: '[Task] #3-01: 一覧に状態を出す' }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'title', code: 'order-conflict' })])
        expect(problems[0]?.['message']).toContain('the next free order is 2')
      })
    })

    it('親 Epic の子の題が番号を持たないと、空き番号を付けた題を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-03')
      await explains('親 Epic を持つ子の題に `#3-NN:` の番号が無い場合のテストです。`title-order` の問題を返し、空き番号 2 を付けた題を候補に含めることを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ title: '[Task] 一覧に状態を出す' }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'title', code: 'title-order', candidates: ['[Task] #3-02: 一覧に状態を出す'] })])
      })
    })

    it('親 Epic の子の一覧を渡さないと、issue_read の get_sub_issues で読むよう problem で案内する', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-04')
      await explains('親 Epic を持つ子の起票で、`reads.sub_issues` を渡さない場合のテストです。番号の重なりを確認できないため、`read-required` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await createOne({}, { project_fields: PROJECT_FIELDS }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'reads.sub_issues', code: 'read-required' })])
      })
    })

    it('update で題の番号を変えると、元の番号を保った題を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-03')
      await explains('`method` が `update` で、読み取った Issue の題の番号（`#3-04`）と違う番号の題を渡した場合のテストです。`title-order` の問題を返し、元の番号の題を候補に含めることを確認します。')
      useProject()
      const current = { issue: { number: 7, title: '[Task] #3-04: 一覧に状態を出す', state: 'open', body: TASK_BODY, html_url: 'https://ghes.example.com/acme/demo/issues/7' } }
      const problems = problemsOf(await check({ method: 'update', issues: [{ kind: 'task', ...DEMO, issue_number: 7, title: '[Task] #3-05: 一覧に状態の列を出す' }], reads: { issues: [current] } }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'title', code: 'title-order', candidates: ['[Task] #3-04: 一覧に状態の列を出す'] })])
      })
    })
  })

  describe('本文とテンプレート', () => {
    it.for([
      { name: 'frontmatter を残した本文', body: `---\nkind: task\n---\n\n${TASK_BODY}`, code: 'frontmatter' },
      { name: 'ガイドのコメントを残した本文', body: `<!--\n書き方\n-->\n\n${TASK_BODY}`, code: 'guide-comment' },
      { name: '後に並ぶ key を指す本文', body: `${TASK_BODY}\n{{issue:later}} を待つ。\n`, code: 'placeholder' },
    ])('$name を渡すと、body の problem にする', async ({ name, body, code }, context) => {
      await verifies(context, 'PW-ISSUE-CHECK-05')
      await explains(`${name}を、同梱の \`task\` のテンプレートで起票する場合のテストです。\`body\` の \`${code}\` の問題を返すことを確認します。`)
      useProject()
      const outcome = await createOne({ body })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toContainEqual(['body', code])
      })
    })

    it('同梱に無い Issue のテンプレートを指定すると、同梱のテンプレートを候補に添えて problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-05')
      await explains('`pecot-template://issue/` で始まるが同梱に存在しないテンプレートを指定した場合のテストです。`unknown-template` の問題を返し、同梱の 5 つのテンプレートを候補に含めることを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ template: 'pecot-template://issue/unknown' }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'template', code: 'unknown-template', candidates: [
          'pecot-template://issue/task',
          'pecot-template://issue/task-implement',
          'pecot-template://issue/bug',
          'pecot-template://issue/epic',
          'pecot-template://issue/tracker',
        ] })])
      })
    })

    it('テンプレートの種別と kind が違うと、テンプレートの種別を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-05')
      await explains('`kind` が `bug` で、`task` のテンプレートを指定した場合のテストです。`kind` の問題を返し、テンプレートの種別 `task` を候補に含めることを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ kind: 'bug', title: '[Bug] #3-02: 一覧に状態を出す' }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'kind', code: 'value', candidates: ['task'] })])
      })
    })

    it('テンプレートの無い本文が末尾の行を持たないと、行を足した本文を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-07')
      await explains('`template` を省いた自由形式の本文で、起票の決まりを指す末尾の行が存在しない場合のテストです。`freeform-footer` の問題を返し、行を足した本文を候補に含めることを確認します。')
      useProject()
      const body = '一覧に状態を出す\n\n詳しくは後で書く。'
      const problems = problemsOf(await createOne({ template: undefined, title: '[Task] #3-02: 一覧に状態を出す', body }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'body', code: 'freeform-footer', candidates: [`${body}\n\n${FREEFORM_FOOTER}`] })])
      })
    })

    it('テンプレートの無い本文の題が本文の 1 行目と違うと、1 行目から作った題を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-07')
      await explains('自由形式の本文で、題が本文の 1 行目と異なる場合のテストです。`freeform-title` の問題を返し、1 行目から作った題を候補に含めることを確認します。')
      useProject()
      const body = `一覧に状態を出す\n\n詳しくは後で書く。\n\n${FREEFORM_FOOTER}\n`
      const problems = problemsOf(await createOne({ template: undefined, title: '[Task] #3-02: 別の題', body }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'title', code: 'freeform-title', candidates: ['[Task] #3-02: 一覧に状態を出す'] })])
      })
    })

    it('差し替えたテンプレートのパスを指定すると、本文にテンプレートの決まりを当てずに problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-06')
      await explains('同梱でないテンプレート（差し替えたテンプレートのパス）を指定した場合のテストです。見出しの無い本文でも、問題の無い結果を返すことを確認します。')
      useProject()
      const outcome = await createOne({ template: '.github/ISSUE_TEMPLATE/task.md', body: '進めたい作業です。' })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toMatchObject({ problems: [] })
      })
    })
  })

  describe('ボードの欄と列', () => {
    it('列を書かないと、置く列を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-08')
      await explains('前提の無い task の起票で、`project_fields` に列（`pecot-status`）を書かない場合のテストです。`required` の問題を返し、`Ready` を候補に含めることを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ project_fields: [] }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'project_fields.pecot-status', code: 'required', candidates: ['Ready'] })])
      })
    })

    it('前提の無い task を Backlog に置くと、Ready を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-08')
      await explains('前提の無い task の起票で、列に `Backlog` を書いた場合のテストです。`column` の問題を返し、`Ready` を候補に含めることを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ project_fields: [{ name: 'pecot-status', value: 'Backlog' }] }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'project_fields.pecot-status', code: 'column', candidates: ['Ready'] })])
      })
    })

    it('列を選択肢の ID で書くと、選択肢の名前に読み替えて problem の無い結果を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-08')
      await explains('列の値を、選択肢の名前でなく `projects_write` に渡す選択肢の ID（`o3`）で書いた場合のテストです。名前の `Ready` に読み替え、問題の無い結果を返すことを確認します。')
      useProject()
      const outcome = await createOne({ project_fields: [{ id: 101, value: 'o3' }] })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toMatchObject({ problems: [] })
      })
    })

    it('Status の欄を書くと、自動処理が書く欄として problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-08')
      await explains('`project_fields` に、pecot の自動処理が書く `Status` の欄を含めた場合のテストです。`status-field` の問題を返すことを確認します。')
      useProject()
      const outcome = await createOne({ project_fields: [...READY, { name: 'Status', value: 'Todo' }] })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['project_fields.Status', 'status-field']])
      })
    })

    it('ボードの欄に無い選択肢を書くと、取りうる値を添えて problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-08')
      await explains('ボードの欄 `Area` に、選択肢に存在しない値を書いた場合のテストです。`Area` の問題を返し、文に取りうる値を含めることを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ project_fields: [...READY, { name: 'Area', value: 'web' }] }))
      await step('結果を確かめる', () => {
        expect(problems).toHaveLength(1)
        expect(problems[0]).toMatchObject({ field: 'project_fields.Area' })
        expect(problems[0]?.['message']).toContain('cli')
      })
    })

    it('Issue field を書くのに list_issue_fields の結果を渡さないと、読むよう problem で案内する', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-04')
      await explains('`issue_fields` を書くのに、`reads.issue_fields` を渡さない場合のテストです。`list_issue_fields` で読むよう案内する `read-required` の問題を返すことを確認します。')
      useProject()
      const outcome = await createOne({ issue_fields: [{ field_name: 'Effort', value: 3 }] })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['reads.issue_fields', 'read-required']])
        expect(outcome.structured['warnings']).toEqual([expect.stringContaining('sub_issue_write')])
      })
    })

    it('ボードの欄の読み取りを渡さないと、projects_list で読むよう problem で案内する', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-04')
      await explains('起票で `reads.project_fields` を渡さない場合のテストです。列と欄を確認できないため、`list_project_fields` で読むよう案内する `read-required` の問題を返すことを確認します。')
      useProject()
      const outcome = await createOne({}, { sub_issues: SUB_ISSUES })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['reads.project_fields', 'read-required']])
      })
    })

    it('pecot-lane を書かない子は、親 Epic のカードの値を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-08')
      await explains('ボードに `pecot-lane` の欄があり、親 Epic のカードが値 `web` を持つのに、子の起票で値を書かない場合のテストです。`lane` の問題を返し、`web` を候補に含めることを確認します。')
      useProject()
      const lane = { id: 104, node_id: 'PVTSSF_lane', name: 'pecot-lane', data_type: 'single_select', options: [option('l1', 'web')] }
      const items = [{ items: { items: [{ content: { number: 3, repository: 'acme/demo' }, fields: [{ id: 104, name: 'pecot-lane', value: { name: 'web' } }] }] } }]
      const problems = problemsOf(await createOne({}, { ...CHILD_READS, project_fields: boardFields([lane]), project_items: items }))
      await step('結果を確かめる', () => {
        expect(problems).toEqual([expect.objectContaining({ field: 'project_fields.pecot-lane', code: 'lane', candidates: ['web'] })])
      })
    })

    it('update で列を書くと、列は決まりで動くとして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-09')
      await explains('`method` が `update` で、`project_fields` に列（`pecot-status`）を含めた場合のテストです。列は前提と PR で動くため、`column` の問題を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'update', issues: [{ kind: 'task', ...DEMO, issue_number: 7, project_fields: READY }], reads: { project_fields: PROJECT_FIELDS } })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['project_fields.pecot-status', 'column']])
      })
    })
  })

  describe('前提', () => {
    it('wait merge の前提に理由が無いと、reason の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-10')
      await explains('`blocked_by` の前提に `wait: merge` を付け、`reason` を渡さない場合のテストです。`reason` が不足している問題を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'create', issues: [
        { key: 'first', ...CHILD, title: '[Task] #3-02: 先に作る Issue', body: FIRST_BODY },
        { key: 'second', ...CHILD, title: '[Task] #3-03: 後に作る Issue', body: SECOND_BODY, blocked_by: [{ issue: 'first', wait: 'merge' }], project_fields: [{ name: 'pecot-status', value: 'Blocked' }] },
      ], reads: CHILD_READS })
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toContainEqual(expect.objectContaining({ issue: 'second', field: 'blocked_by[0].reason', code: 'required' }))
      })
    })

    it('wait merge の前提が本文の Waits for merge の節に無いと、書く行を候補にして problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-10')
      await explains('`wait: merge` の前提と理由を渡し、本文の末尾に `## Waits for merge` の節を書かない場合のテストです。`waits-for-merge` の問題を返し、`{{issue:first}}` と理由の行を候補に含めることを確認します。')
      useProject()
      const outcome = await check({ method: 'create', issues: [
        { key: 'first', ...CHILD, title: '[Task] #3-02: 先に作る Issue', body: FIRST_BODY },
        { key: 'second', ...CHILD, title: '[Task] #3-03: 後に作る Issue', body: SECOND_BODY, blocked_by: [{ issue: 'first', wait: 'merge', reason: 'スキーマが先に要る' }], project_fields: [{ name: 'pecot-status', value: 'Blocked' }] },
      ], reads: CHILD_READS })
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toEqual([expect.objectContaining({ issue: 'second', field: 'body', code: 'waits-for-merge', candidates: ['- {{issue:first}}: スキーマが先に要る'] })])
      })
    })

    it('wait merge の前提を Waits for merge の節に挙げると、problem の無い結果と merge を待つ進め方を返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-02')
      await verifies(context, 'PW-ISSUE-CHECK-10')
      await explains('`wait: merge` の前提と理由を、本文の末尾の `## Waits for merge` の節にも同じ理由で書いた場合のテストです。問題の無い結果と、後の Issue の進め方 `wait-merge` を返すことを確認します。')
      useProject()
      const body = `${SECOND_BODY}\n## Waits for merge\n\n- {{issue:first}}: スキーマが先に要る\n`
      const outcome = await check({ method: 'create', issues: [
        { key: 'first', ...CHILD, title: '[Task] #3-02: 先に作る Issue', body: FIRST_BODY },
        { key: 'second', ...CHILD, title: '[Task] #3-03: 後に作る Issue', body, blocked_by: [{ issue: 'first', wait: 'merge', reason: 'スキーマが先に要る' }], project_fields: [{ name: 'pecot-status', value: 'Blocked' }] },
      ], reads: CHILD_READS })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toMatchObject({ problems: [], plan: [{ key: 'first' }, { key: 'second', blockedBy: [{ issue: 'first', wait: 'merge' }], approach: 'wait-merge' }] })
      })
    })

    it('既存の Issue を前提に持つのに、その Issue を読んでいないと、issue_read で読むよう problem で案内する', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-04')
      await explains('既存の Issue（`acme/demo/5`）を前提に持つ起票で、`reads.issues` にその Issue を渡さない場合のテストです。置く列を決められないため、`read-required` の問題を返すことを確認します。')
      useProject()
      const outcome = await createOne({ blocked_by: [{ issue: 'acme/demo/5' }], project_fields: [{ name: 'pecot-status', value: 'Blocked' }] })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['reads.issues', 'read-required']])
      })
    })

    it('既存の開いた Issue を前提に持つと、Blocked に置く案を problem の無い結果で返す', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-10')
      await explains('PR の無い開いた既存の Issue（`acme/demo/5`）を前提に持つ起票で、列に `Blocked` を書いた場合のテストです。問題の無い結果を返すことを確認します。')
      useProject()
      const prerequisite = { issue: { number: 5, title: '[Task] 先の作業', state: 'open', body: '', html_url: 'https://ghes.example.com/acme/demo/issues/5' } }
      const outcome = await createOne({ blocked_by: [{ issue: 'acme/demo/5' }], project_fields: [{ name: 'pecot-status', value: 'Blocked' }] }, { ...CHILD_READS, issues: [prerequisite] })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toMatchObject({ problems: [], plan: [{ blockedBy: [{ issue: '#5', wait: 'stack' }] }] })
      })
    })

    it.for([
      { name: 'Ready', column: 'Ready' },
      { name: 'Blocked', column: 'Blocked' },
    ])('開いた PR を持つ既存の Issue を前提にし、その PR を読んでいないと、$name の列も受けて pull_request_read を案内する warning を返す', async ({ name, column }, context) => {
      await verifies(context, 'PW-ISSUE-CHECK-11')
      await explains(`開いた PR を持つ既存の Issue を前提に持つ起票で、PR を \`reads.pull_requests\` に渡さず、列へ \`${name}\` を書いた場合のテストです。スタックできるかを決められないため、問題を返さず、\`pull_request_read\` の読み取りを \`warnings\` で案内することを確認します。`)
      useProject()
      const outcome = await createOne({ blocked_by: [{ issue: 'acme/demo/5' }], project_fields: [{ name: 'pecot-status', value: column }] }, { ...CHILD_READS, issues: [prerequisiteRead(5, 11)] })
      await step('結果を確かめる', () => {
        expect(outcome.structured).toMatchObject({ problems: [] })
        expect(outcome.structured['warnings']).toEqual([expect.stringContaining('pass the result of pull_request_read (method get) for acme/demo#11 in reads.pull_requests')])
      })
    })

    it('前提の PR が開発ブランチへ向いていると、スタックできる Issue として Ready を受け、Blocked を problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-12')
      await explains('開いた PR（`main` へ向く）を持つ既存の Issue を前提にし、その PR を `reads.pull_requests` に渡した起票のテストです。スタックできると判定し、`Ready` なら問題を返さず、`Blocked` なら列の問題を返すことを確認します。')
      useProject()
      const reads = { ...CHILD_READS, issues: [prerequisiteRead(5, 11)], pull_requests: [pullRequestRead(11, 'feat/5')] }
      const ready = await createOne({ blocked_by: [{ issue: 'acme/demo/5' }], project_fields: [{ name: 'pecot-status', value: 'Ready' }] }, reads)
      const blocked = await createOne({ blocked_by: [{ issue: 'acme/demo/5' }], project_fields: [{ name: 'pecot-status', value: 'Blocked' }] }, reads)
      await step('結果を確かめる', () => {
        expect(ready.structured).toMatchObject({ problems: [] })
        expect(ready.structured).not.toHaveProperty('warnings')
        expect(problemsOf(blocked)).toEqual([expect.objectContaining({ field: 'project_fields.pecot-status', code: 'column' })])
      })
    })

    it('2 つの前提の PR が別々に開発ブランチへ向いていると、1 本にスタックできない Issue として Blocked を受け、Ready を problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-12')
      await explains('どちらも `main` へ向く別々の PR を持つ 2 つの既存の Issue を前提にした起票のテストです。1 本の並びにスタックできないと判定し、`Blocked` なら問題を返さず、`Ready` なら列の問題を返すことを確認します。')
      useProject()
      const reads = { ...CHILD_READS, issues: [prerequisiteRead(5, 11), prerequisiteRead(6, 12)], pull_requests: [pullRequestRead(11, 'feat/5'), pullRequestRead(12, 'feat/6')] }
      const prerequisites = [{ issue: 'acme/demo/5' }, { issue: 'acme/demo/6' }]
      const blocked = await createOne({ blocked_by: prerequisites, project_fields: [{ name: 'pecot-status', value: 'Blocked' }] }, reads)
      const ready = await createOne({ blocked_by: prerequisites, project_fields: [{ name: 'pecot-status', value: 'Ready' }] }, reads)
      await step('結果を確かめる', () => {
        expect(blocked.structured).toMatchObject({ problems: [] })
        expect(blocked.structured).not.toHaveProperty('warnings')
        expect(problemsOf(ready)).toEqual([expect.objectContaining({ field: 'project_fields.pecot-status', code: 'column' })])
      })
    })

    it('Epic に前提を付けると、blocked_by の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-10')
      await explains('`kind` が `epic` の起票に `blocked_by` を渡した場合のテストです。Epic は前提を持たないため、`unexpected` の問題を返すことを確認します。')
      useProject()
      const epic = { kind: 'epic', ...DEMO, title: '[Epic] 一覧を作り直す', body: `一覧を作り直す\n\n${FREEFORM_FOOTER}\n`, blocked_by: [{ issue: 'acme/demo/5' }], project_fields: [{ name: 'pecot-status', value: 'Backlog' }] }
      const outcome = await check({ method: 'create', issues: [epic], reads: { project_fields: PROJECT_FIELDS } })
      await step('結果を確かめる', () => {
        expect(problemsOf(outcome)).toContainEqual(expect.objectContaining({ field: 'blocked_by', code: 'unexpected' }))
      })
    })

    it('update に blocked_by を渡すと、issue_dependency_check を案内して problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-13')
      await explains('`method` が `update` で `blocked_by` を渡した場合のテストです。前提の変更は `issue_dependency_check` で確認するよう案内する `unexpected` の問題を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'update', issues: [{ kind: 'task', ...DEMO, issue_number: 7, blocked_by: [{ issue: 'acme/demo/5' }] }] })
      await step('結果を確かめる', () => {
        const problems = problemsOf(outcome)
        expect(problems).toEqual([expect.objectContaining({ field: 'blocked_by', code: 'unexpected' })])
        expect(problems[0]?.['message']).toContain('issue_dependency_check')
      })
    })
  })

  describe('起票先と用法', () => {
    it('プロジェクトに無いリポジトリへ起票すると、not-in-project の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-14')
      await explains('プロジェクトの設定に存在しないリポジトリ（`acme/other`）へ起票する場合のテストです。`repo` の `not-in-project` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ repo: 'other' }))
      await step('結果を確かめる', () => {
        expect(problems).toContainEqual(expect.objectContaining({ field: 'repo', code: 'not-in-project' }))
      })
    })

    it('起票先を渡さないと、owner と repo の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-14')
      await explains('`owner` と `repo` を渡さない起票のテストです。起票先が不足している `required` の問題を返すことを確認します。')
      useProject()
      const problems = problemsOf(await createOne({ owner: undefined, repo: undefined }))
      await step('結果を確かめる', () => {
        expect(problems).toContainEqual(expect.objectContaining({ field: 'repo', code: 'required' }))
      })
    })

    it('update に issue_number が無いと、issue_number の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-14')
      await explains('`method` が `update` で `issue_number` を渡さない場合のテストです。書き換える Issue が不足している `required` の問題を返すことを確認します。')
      useProject()
      const outcome = await check({ method: 'update', issues: [{ kind: 'task', ...DEMO }] })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['issue_number', 'required']])
      })
    })

    it('担当を 11 人渡すと、assignees の上限の problem にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-14')
      await explains('1 つの Issue に付けられる担当の上限（10 人）を超える `assignees` を渡した場合のテストです。`limit` の問題を返すことを確認します。')
      useProject()
      const assignees = Array.from({ length: 11 }, (_, index) => `user${String(index)}`)
      const outcome = await createOne({ assignees })
      await step('結果を確かめる', () => {
        expect(codesOf(outcome)).toEqual([['assignees', 'limit']])
      })
    })

    it('reads.project_fields が公式の MCP の結果の形でないと、github-mcp-shape の失敗にする', async (context) => {
      await verifies(context, 'PW-ISSUE-CHECK-15')
      await explains('`reads.project_fields` が `list_project_fields` の結果の形と異なる場合のテストです。種別 `github-mcp-shape` のツールの失敗を返し、置き場所を `detail` に含めることを確認します。')
      useProject()
      const outcome = await createOne({}, { ...CHILD_READS, project_fields: { fields: [] } })
      await step('結果を確かめる', () => {
        expect(outcome.isError).toBe(true)
        expect(outcome.structured['kind']).toBe('github-mcp-shape')
        expect(outcome.structured['detail']).toContain('reads.project_fields')
      })
    })
  })
})

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下とリポ内の定義のみ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- フィクスチャを組み替える作業用のクラスを渡す */
/* eslint-disable unicorn/no-null -- GitHub の API の応答にある null を再現する */
// sandbox-diff.sh を、偽の gh（URL ごとのフィクスチャを返し、無ければ API 失敗）で動かして結果を確かめる。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { compareStrings } from '../parity/baseline.js'
import { fixtureName, makeSandbox, pluginScript, repositoryRoot, runScript, splitLines, type Result, type Sandbox } from './_helpers/run.js'

const THIS = 'pecotcraft/pecot'
const SANDBOX = 'pecotcraft/pecot-sandbox'
const WORKFLOWS = '.github/workflows'
const CONFIG_DIR = '.pecot/config/projects'
const CURRENT_FORM = '<host>_<owner>_<number>.json'
const LEGACY_FORM = '<host>_<owner>_<題>_<suffix>.json'
const script = pluginScript('scripts/sandbox/sandbox-diff.sh')

// GraphQL は `-F number=` の値で graphql_<番号> を返す。FAKE_GH_AUTH_FAIL が立っていれば認証の失敗を返す。
const FAKE_GH = [
  'if [ -n "${FAKE_GH_AUTH_FAIL:-}" ]; then',
  '    echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2',
  '    exit 1',
  'fi',
  'url=""; number=""',
  'while [ "$#" -gt 0 ]; do',
  '    case "$1" in',
  '        -f|-F|-X|-H)',
  '            case "$2" in number=*) number="${2#number=}" ;; esac',
  '            shift 2; continue ;;',
  '        -*|api) ;;',
  '        *) url="$1" ;;',
  '    esac',
  '    shift',
  'done',
  '[ "$url" = "graphql" ] && url="graphql_$number"',
  'f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"',
  '[ -f "$f" ] || exit 1',
  'cat "$f"',
].join('\n')

const BOARD_SYNC = 'name: pecot-board-sync\non: workflow_dispatch\njobs:\n  sync:\n    steps:\n      - run: npx -y @pecot/workflow-mcp@next\n'

const REVIEW = 'name: pecot review\non: pull_request\njobs:\n  review:\n    steps:\n      - run: npx -y @pecot/workflow-mcp@next review finish\n'

const HANDOFF = 'name: pecot handoff\non: pull_request_target\njobs:\n  handoff:\n    steps:\n      - uses: anthropics/claude-code-action@0\n'

interface Check { context: string, integration_id?: number }
interface Rule { type: string, parameters?: { required_status_checks?: Check[], [key: string]: unknown } }
interface Ruleset {
  id: number
  name: string
  rules?: Rule[]
  [key: string]: unknown
}
interface Option { id: string, name: string, color: string, description: string }
interface Field { __typename: string, id: string, name: string, dataType: string, options?: Option[] }
interface Board { data: { organization: { projectV2: { fields: { nodes: Field[] } } | null } } }
type Settings = Record<string, unknown>
interface ProjectConfig { host: string, owner: string, workflow_suffix?: string, project: { number: number } }

// #701 の前の形の設定ファイル（<host>_<owner>_<題>_<suffix>.json）
function legacyConfig(slug: string, suffix: string, number: number): [string, ProjectConfig] {
  return [`github.com_pecotcraft_${slug}_${suffix}.json`, { host: 'github.com', owner: 'pecotcraft', workflow_suffix: suffix, project: { number } }]
}

// 今の形の設定ファイル（<host>_<owner>_<number>.json）
function currentConfig(number: number): [string, ProjectConfig] {
  return [`github.com_pecotcraft_${String(number)}.json`, { host: 'github.com', owner: 'pecotcraft', project: { number } }]
}

// jq -c と同じ形（キーの順は入力のまま）
function compact(value: unknown): string {
  return JSON.stringify(value)
}

function repositorySettings(): Settings {
  return {
    id: 1,
    full_name: 'x',
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_auto_merge: true,
    delete_branch_on_merge: true,
    updated_at: '2026-11-01T00:00:00Z',
  }
}

function makeRuleset(id: number, repository: string): Ruleset {
  return {
    id,
    name: 'main',
    target: 'branch',
    source_type: 'Repository',
    source: repository,
    enforcement: 'active',
    conditions: { ref_name: { exclude: [], include: ['~DEFAULT_BRANCH'] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: { required_approving_review_count: 0, allowed_merge_methods: ['squash'] } },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            { context: 'ci-result', integration_id: 15_368 },
            { context: 'version-plan', integration_id: 15_368 },
          ],
        },
      },
      { type: 'merge_queue', parameters: { merge_method: 'SQUASH', max_entries_to_build: 1, grouping_strategy: 'ALLGREEN' } },
      { type: 'code_scanning', parameters: { code_scanning_tools: [{ tool: 'CodeQL', alerts_threshold: 'all' }] } },
    ],
    node_id: `RRS_${String(id)}`,
    created_at: '2026-11-04T14:35:37.581Z',
    updated_at: '2026-11-09T09:26:49.361Z',
    bypass_actors: [{ actor_id: 5_676_665, actor_type: 'Integration', bypass_mode: 'always' }],
    current_user_can_bypass: 'never',
    _links: { self: { href: `https://api.github.com/repos/${repository}/rulesets/${String(id)}` } },
  }
}

function makeBoard(workflowField: string): Board {
  const single = (id: string, name: string, options: readonly string[]): Field => ({
    __typename: 'ProjectV2SingleSelectField',
    id,
    name,
    dataType: 'SINGLE_SELECT',
    options: options.map((option, index) => ({ id: `${id}-${String(index)}`, name: option, color: 'GRAY', description: '' })),
  })
  const nodes: Field[] = [
    { __typename: 'ProjectV2Field', id: 'F_title', name: 'Title', dataType: 'TITLE' },
    single('F_status', 'Status', ['Todo', 'In Progress', 'Done']),
    single('F_wf', workflowField, ['Pending', 'Backlog', 'Blocked', 'Ready', 'Active', 'In Review', 'Archived']),
    single('F_pri', 'pecot-priority', ['High', 'Medium', 'Low']),
    single('F_size', 'pecot-size', ['XS', 'S', 'M', 'L']),
  ]
  return { data: { organization: { projectV2: { fields: { nodes } } } } }
}

// git の blob の sha の代わり。中身が同じなら同じ値になる
function blob(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function find<T>(items: readonly T[], isWanted: (item: T) => boolean): T {
  const found = items.find(item => isWanted(item))
  if (found === undefined) throw new Error('見つからない')
  return found
}

function writeFixture(sandbox: Sandbox, url: string, body: unknown): void {
  writeFileSync(path.join(sandbox.fake, fixtureName(url)), JSON.stringify(body))
}

class Side {
  readonly settings = repositorySettings()
  readonly rulesets: Ruleset[]
  board: Board
  readonly files: Record<string, string> = { 'ci.yml': 'name: ci\n', 'pecot-board-sync.yml': BOARD_SYNC, 'pecot-handoff.yml': HANDOFF, 'pecot-review.yml': REVIEW }
  // undefined は、設定のディレクトリが無い（一覧が 404）
  configs: Record<string, ProjectConfig> | undefined
  // 生の中身で置く設定ファイル。undefined は、応答に content が無い
  readonly rawConfigs: Record<string, string | undefined> = {}

  constructor(readonly repository: string, readonly project: number, rulesetId: number, workflowField: string, config: [string, ProjectConfig]) {
    this.rulesets = [makeRuleset(rulesetId, repository)]
    this.board = makeBoard(workflowField)
    this.configs = Object.fromEntries([config])
  }

  setConfigs(...configs: readonly [string, ProjectConfig][]): void {
    this.configs = Object.fromEntries(configs)
  }

  rules(): Rule[] {
    const rules = find(this.rulesets, ruleset => ruleset.name === 'main').rules
    if (rules === undefined) throw new Error('rules が無い')
    return rules
  }

  rule(type: string): Rule {
    return find(this.rules(), rule => rule.type === type)
  }

  withoutRule(type: string): void {
    const kept = this.rules().filter(rule => rule.type !== type)
    this.rules().splice(0, this.rules().length, ...kept)
  }

  fields(): Field[] {
    const projectV2 = this.board.data.organization.projectV2
    if (projectV2 === null) throw new Error('projectV2 が無い')
    return projectV2.fields.nodes
  }

  write(sandbox: Sandbox): void {
    const repository = this.repository
    writeFixture(sandbox, `repos/${repository}`, this.settings)
    writeFixture(sandbox, `repos/${repository}/rulesets?includes_parents=false`, this.rulesets.map(ruleset => ({ id: ruleset.id, name: ruleset.name, source_type: 'Repository' })))
    for (const ruleset of this.rulesets) writeFixture(sandbox, `repos/${repository}/rulesets/${String(ruleset.id)}`, ruleset)
    writeFixture(sandbox, `graphql_${String(this.project)}`, this.board)
    writeFixture(sandbox, `repos/${repository}/contents/${WORKFLOWS}?ref=main`, Object.entries(this.files).map(([name, text]) => ({ name, type: 'file', sha: blob(text) })))
    for (const [name, text] of Object.entries(this.files)) {
      writeFixture(sandbox, `repos/${repository}/contents/${WORKFLOWS}/${name}?ref=main`, {
        name,
        sha: blob(text),
        encoding: 'base64',
        content: Buffer.from(text).toString('base64'),
      })
    }
    if (this.configs === undefined) return
    const texts = [
      ...Object.entries(this.configs).map(([name, config]): [string, string | undefined] => [name, JSON.stringify(config, undefined, 2)]),
      ...Object.entries(this.rawConfigs),
    ]
    const listing = [{ name: '.active', type: 'file' }, ...texts.map(([name]) => ({ name, type: 'file' }))]
    writeFixture(sandbox, `repos/${repository}/contents/${CONFIG_DIR}?ref=main`, listing)
    for (const [name, text] of texts) {
      // contents API と同じく、base64 を 60 文字ごとに改行する
      const content = text === undefined ? undefined : (Buffer.from(text).toString('base64').match(/.{1,60}/gu) ?? []).join('\n')
      writeFixture(sandbox, `repos/${repository}/contents/${CONFIG_DIR}/${name}?ref=main`, { name, encoding: 'base64', content })
    }
  }
}

// このリポ（Projects 1 番）と検証用（Projects 3 番）が、比べる項目で同じ状態から始める
class Scene {
  readonly this = new Side(THIS, 1, 26_538_811, 'pecot-workflow-pecotcraft', legacyConfig('pecot-project', 'pecotcraft', 1))
  readonly sandbox = new Side(SANDBOX, 3, 27_130_266, 'pecot-workflow-sandbox', legacyConfig('pecot-sandbox', 'sandbox', 3))

  constructor(readonly workspace: Sandbox) {}

  writeAll(): void {
    this.this.write(this.workspace)
    this.sandbox.write(this.workspace)
  }

  run(extraEnvironment: Readonly<Record<string, string>> = {}): Result {
    this.writeAll()
    return runScript(this.workspace, script, [], extraEnvironment)
  }
}

function drift(name: string, thisSide: string, sandboxSide: string): string[] {
  return [name, `  このリポ: ${thisSide}`, `  検証用: ${sandboxSide}`]
}

function drifted(result: Readonly<Result>): { status: number | null, stderr: string, lines: string[] } {
  return { status: result.status, stderr: result.stderr, lines: splitLines(result.stdout) }
}

function expectedDrifts(...drifts: readonly (readonly string[])[]): { status: number, stderr: string, lines: string[] } {
  return { status: 1, stderr: '', lines: [`ずれは ${String(drifts.length)} 件`, ...drifts.flat()] }
}

function withoutIntegrationId<T extends { required_status_checks?: Check[] }>(parameters: T): T {
  const copy = structuredClone(parameters)
  const checks = copy.required_status_checks ?? []
  for (const check of checks) delete check.integration_id
  return copy
}

describe('sandbox-diff.sh', { timeout: 30_000 }, () => {
  let scene: Scene

  beforeEach(() => {
    const workspace = makeSandbox(FAKE_GH)
    // スクリプトは git の作業ツリーの .pecot/tmp に作業用の場所を作る
    execFileSync('git', ['init', '-q'], { cwd: workspace.directory, env: { PATH: process.env['PATH'] ?? '' } })
    scene = new Scene(workspace)
  })

  it('git の作業ツリーの外で打つと、error の行を出して終了コード 2 で止まる', () => {
    const outside = makeSandbox(FAKE_GH)
    const result = runScript(outside, script, [], { GIT_CEILING_DIRECTORIES: path.dirname(outside.directory) })
    expect([result.status, result.stdout, result.stderr]).toStrictEqual([2, '', 'error: git の作業ツリーの中で打ってください（作業用の場所を .pecot/tmp に作るため）\n'])
  })

  it('設定が同じなら、ずれは 0 件', () => {
    const result = scene.run()
    expect([result.status, result.stdout, result.stderr]).toStrictEqual([0, 'ずれは 0 件\n', ''])
  })

  it('必須チェックが 1 つ足りないと、required_status_checks のずれとして出す', () => {
    const checks = scene.sandbox.rule('required_status_checks')
    checks.parameters?.required_status_checks?.pop()
    const thisChecks = scene.this.rule('required_status_checks')
    const result = scene.run()
    const expectedThis = compact(withoutIntegrationId(thisChecks.parameters ?? {}))
    const expectedSandbox = compact(withoutIntegrationId(checks.parameters ?? {}))
    expect(drifted(result)).toStrictEqual(expectedDrifts(drift('ruleset main / required_status_checks', expectedThis, expectedSandbox)))
    const lines = splitLines(result.stdout)
    expect(lines[2]).toContain('version-plan')
    expect(lines[3]).not.toContain('version-plan')
  })

  it('merge_queue の規則が検証用に無いと、「なし」としてずれに出す', () => {
    scene.sandbox.withoutRule('merge_queue')
    const queue = scene.this.rule('merge_queue')
    const expected = expectedDrifts(drift('ruleset main / merge_queue', compact(queue.parameters), 'なし'))
    expect(drifted(scene.run())).toStrictEqual(expected)
  })

  it('code_scanning の規則が無くても比べない（FR-004）', () => {
    scene.sandbox.withoutRule('code_scanning')
    const result = scene.run()
    expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
  })

  it.for(['pages-store', 'release-tags'])('このリポだけの運用の ruleset %s が検証用に無くても比べない（FR-008）', (name) => {
    scene.this.rulesets.push({ ...makeRuleset(1, THIS), name })
    const result = scene.run()
    expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
  })

  it('一覧に無い名前の ruleset が検証用に無いと、ruleset のずれに出す', () => {
    scene.this.rulesets.push({ ...makeRuleset(1, THIS), name: 'other' })
    const result = scene.run()
    expect(result.status).toBe(1)
    expect(splitLines(result.stdout).slice(0, 2)).toStrictEqual(['ずれは 1 件', 'ruleset other'])
  })

  it('ボードの選択肢が 1 つ多いと、board-fields のずれに出す', () => {
    const field = find(scene.sandbox.fields(), f => f.name === 'pecot-workflow-sandbox')
    const names = (field.options ?? []).map(option => ({ name: option.name }))
    const before = { dataType: 'SINGLE_SELECT', options: names }
    field.options?.push({ id: 'x', name: 'Done', color: 'GREEN', description: '' })
    const after = { dataType: 'SINGLE_SELECT', options: [...names, { name: 'Done' }] }
    const expected = expectedDrifts(drift('board-fields / pecot-workflow-*', compact(before), compact(after)))
    expect(drifted(scene.run())).toStrictEqual(expected)
  })

  it('ボードの選択肢は順番まで比べる', () => {
    find(scene.sandbox.fields(), f => f.name === 'pecot-priority').options?.reverse()
    const result = scene.run()
    expect(result.status).toBe(1)
    expect(splitLines(result.stdout).slice(0, 2)).toStrictEqual(['ずれは 1 件', 'board-fields / pecot-priority'])
  })

  it('ID と日付だけが違うなら、ずれは 0 件', () => {
    const ruleset = scene.sandbox.rulesets[0]
    if (ruleset === undefined) throw new Error('ruleset が無い')
    Object.assign(ruleset, { node_id: 'RRS_other', created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-02T00:00:00Z', bypass_actors: [], current_user_can_bypass: 'always' })
    const checks = scene.sandbox.rule('required_status_checks').parameters?.required_status_checks ?? []
    for (const check of checks) check.integration_id = 1
    for (const field of scene.sandbox.fields()) {
      field.id = `other-${field.id}`
      const options = field.options ?? []
      for (const option of options) Object.assign(option, { id: `other-${option.id}`, color: 'RED', description: 'x' })
    }
    Object.assign(scene.sandbox.settings, { id: 99, updated_at: '2020-01-01T00:00:00Z' })
    const result = scene.run()
    expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
  })

  it('board-sync の中身が違うと、両方の blob の sha と違う最初の行を出す（FR-032）', () => {
    const other = BOARD_SYNC.replace('@next', '@6')
    scene.sandbox.files['pecot-board-sync.yml'] = other
    const line = 6
    const expectedThis = `blob ${blob(BOARD_SYNC)}、${String(line)} 行目: ${splitLines(BOARD_SYNC)[line - 1] ?? ''}`
    const expectedSandbox = `blob ${blob(other)}、${String(line)} 行目: ${splitLines(other)[line - 1] ?? ''}`
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('workflows / pecot-board-sync.yml', expectedThis, expectedSandbox)))
  })

  it('pecot-review.yml の中身が違うと、ファイルの名前で両方の blob の sha と違う最初の行を出す', () => {
    const other = REVIEW.replace('on: pull_request', 'on: push')
    scene.sandbox.files['pecot-review.yml'] = other
    const line = 2
    const expectedThis = `blob ${blob(REVIEW)}、${String(line)} 行目: ${splitLines(REVIEW)[line - 1] ?? ''}`
    const expectedSandbox = `blob ${blob(other)}、${String(line)} 行目: ${splitLines(other)[line - 1] ?? ''}`
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('workflows / pecot-review.yml', expectedThis, expectedSandbox)))
  })

  it('検証用に pecot-review.yml が無いと、検証用を「なし」としてずれに出す', () => {
    delete scene.sandbox.files['pecot-review.yml']
    const expectedThis = `blob ${blob(REVIEW)}、1 行目: ${splitLines(REVIEW)[0] ?? ''}`
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('workflows / pecot-review.yml', expectedThis, 'なし')))
  })

  it('pecot-handoff.yml の中身が違うと、ファイルの名前で両方の blob の sha と違う最初の行を出す', () => {
    const other = HANDOFF.replace('@0', '@1')
    scene.sandbox.files['pecot-handoff.yml'] = other
    const line = 6
    const expectedThis = `blob ${blob(HANDOFF)}、${String(line)} 行目: ${splitLines(HANDOFF)[line - 1] ?? ''}`
    const expectedSandbox = `blob ${blob(other)}、${String(line)} 行目: ${splitLines(other)[line - 1] ?? ''}`
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('workflows / pecot-handoff.yml', expectedThis, expectedSandbox)))
  })

  it('検証用に pecot-handoff.yml が無いと、検証用を「なし」としてずれに出す', () => {
    delete scene.sandbox.files['pecot-handoff.yml']
    const expectedThis = `blob ${blob(HANDOFF)}、1 行目: ${splitLines(HANDOFF)[0] ?? ''}`
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('workflows / pecot-handoff.yml', expectedThis, 'なし')))
  })

  it('ci.yml は在るかどうかだけを比べる', () => {
    scene.sandbox.files['ci.yml'] = 'name: other ci\n'
    const same = scene.run()
    expect([same.status, same.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    delete scene.sandbox.files['ci.yml']
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('workflows / ci.yml', 'あり', 'なし')))
  })

  it('両方の設定ファイルが今の形なら、ずれは 0 件', () => {
    scene.this.setConfigs(currentConfig(1))
    scene.sandbox.setConfigs(currentConfig(3))
    const result = scene.run()
    expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
  })

  it('検証用の設定ファイルだけが今の形だと、config-file のずれに両方の形を出す', () => {
    scene.sandbox.setConfigs(currentConfig(3))
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('config-file', LEGACY_FORM, CURRENT_FORM)))
  })

  it('検証用に比べるボードの設定ファイルが無いと、検証用を「なし」としてずれに出す', () => {
    scene.sandbox.setConfigs()
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('config-file', LEGACY_FORM, 'なし')))
  })

  it('別のボードを指す設定ファイルは比べない', () => {
    scene.sandbox.setConfigs(legacyConfig('pecot-sandbox', 'sandbox', 3), currentConfig(9))
    const result = scene.run()
    expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
  })

  it('同じボードの設定ファイルが 2 つあると、形を名前順につないでずれに出す', () => {
    scene.sandbox.setConfigs(legacyConfig('pecot-sandbox', 'sandbox', 3), currentConfig(3))
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('config-file', LEGACY_FORM, `${CURRENT_FORM}、${LEGACY_FORM}`)))
  })

  it('どちらの形にも合わない名前は、名前をそのまま出す', () => {
    const [, config] = legacyConfig('pecot-sandbox', 'sandbox', 3)
    scene.sandbox.setConfigs(['renamed.json', config])
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('config-file', LEGACY_FORM, 'renamed.json')))
  })

  it('JSON として読めない設定ファイルは飛ばし、ずれは 0 件', () => {
    scene.sandbox.rawConfigs['broken.json'] = '{'
    const result = scene.run()
    expect([result.status, result.stdout, result.stderr]).toStrictEqual([0, 'ずれは 0 件\n', ''])
  })

  it('設定ファイルの応答に content が無いと、error を出して終了コード 2 で止まる', () => {
    scene.sandbox.rawConfigs['empty.json'] = undefined
    const result = scene.run()
    expect([result.status, result.stdout]).toStrictEqual([2, ''])
    expect(splitLines(result.stderr)).toStrictEqual([`error: repos/${SANDBOX}/contents/${CONFIG_DIR}/empty.json の応答に content がありません（権限の不足とみられます）`])
  })

  it('検証用の設定のディレクトリが無いと、error を出して終了コード 2 で止まる', () => {
    scene.sandbox.configs = undefined
    const result = scene.run()
    expect([result.status, result.stdout]).toStrictEqual([2, ''])
    expect(splitLines(result.stderr)).toStrictEqual([`error: repos/${SANDBOX}/contents/${CONFIG_DIR} を読めません（gh が失敗しました）`])
  })

  it('検証用の進行の欄だけが pecot-status だと、board-fields の 2 件のずれに出す', () => {
    find(scene.sandbox.fields(), f => f.name === 'pecot-workflow-sandbox').name = 'pecot-status'
    const result = scene.run()
    expect(result.status).toBe(1)
    const lines = splitLines(result.stdout)
    expect([lines[0], lines[1], lines[2], lines[4], lines[6], lines[7]]).toStrictEqual([
      'ずれは 2 件',
      'board-fields / pecot-status',
      '  このリポ: なし',
      'board-fields / pecot-workflow-*',
      '  検証用: なし',
      undefined,
    ])
  })

  it('マージ設定が違うと、merge-settings のずれに出す', () => {
    scene.sandbox.settings['allow_rebase_merge'] = true
    expect(drifted(scene.run())).toStrictEqual(expectedDrifts(drift('merge-settings / allow_rebase_merge', 'false', 'true')))
  })

  it('認証に失敗したら、エラーを出して終了コード 2 で止まる', () => {
    const result = scene.run({ FAKE_GH_AUTH_FAIL: '1' })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(splitLines(result.stderr)).toStrictEqual([
      `error: repos/${THIS} を読めません（HTTP 401: Bad credentials (https://api.github.com/graphql)）`,
    ])
  })

  // 比べるキーが無い（null を含む）ときは、両方 null でも同じとせず error で 2 にする
  it.for([
    {
      name: 'allow_auto_merge が null',
      breaks: (s: Scene) => {
        s.sandbox.settings['allow_auto_merge'] = null
        return `error: repos/${SANDBOX} の応答に allow_auto_merge がありません（権限の不足とみられます）`
      },
    },
    {
      name: 'ruleset に rules が無い',
      breaks: (s: Scene) => {
        const ruleset = s.this.rulesets[0]
        if (ruleset === undefined) throw new Error('ruleset が無い')
        delete ruleset.rules
        return `error: repos/${THIS}/rulesets/26538811 の応答に rules がありません（権限の不足とみられます）`
      },
    },
    {
      name: 'ボードの fields が無い',
      breaks: (s: Scene) => {
        s.sandbox.board = { data: { organization: { projectV2: null } } }
        return 'error: orgs/pecotcraft/projectsV2/3 の応答に fields がありません（権限の不足とみられます）'
      },
    },
  ])('比べるキーが無いと、error を出して終了コード 2 で止まる: $name', ({ breaks }) => {
    const expected = breaks(scene)
    const result = scene.run()
    expect([result.status, result.stdout]).toStrictEqual([2, ''])
    expect(splitLines(result.stderr)).toStrictEqual([expected])
  })

  it('両方のリポで allow_auto_merge が null でも、同じとせず error で止まる', () => {
    scene.this.settings['allow_auto_merge'] = null
    scene.sandbox.settings['allow_auto_merge'] = null
    const result = scene.run()
    expect(result.status).toBe(2)
    expect(result.stderr.startsWith(`error: repos/${THIS} の応答に allow_auto_merge がありません`)).toBe(true)
  })

  it('検証用の ruleset を読めないと、gh の失敗として終了コード 2 で止まる', () => {
    scene.writeAll()
    rmSync(path.join(scene.workspace.fake, fixtureName(`repos/${SANDBOX}/rulesets/27130266`)))
    const result = runScript(scene.workspace, script, [])
    expect(result.status).toBe(2)
    expect(splitLines(result.stderr)).toStrictEqual([
      `error: repos/${SANDBOX}/rulesets/27130266 を読めません（gh が失敗しました）`,
    ])
  })
})

// spec.md の太字の見出しの下の表から、ID → 最後の列（訳）を拾う
function specTable(spec: string, heading: string): Record<string, string> {
  const block = (spec.split(`**${heading}**`, 2)[1] ?? '').split('**', 1)[0] ?? ''
  const rows = splitLines(block).filter(line => line.startsWith('| FR-')).map(line => line.split('|', 20).slice(1, -1))
  return Object.fromEntries(rows.map(cells => [(cells[0] ?? '').trim(), (cells.at(-1) ?? '').trim()]))
}

interface Item { id: string, name: string, compare: boolean, reason?: string, ignore?: unknown }

describe('sandbox-diff-items.json', { timeout: 30_000 }, () => {
  it('比べる項目と外す理由が、spec.md の 2 つの表と合う', () => {
    // eslint-disable-next-line no-restricted-syntax -- リポ内の定義ファイル。直後に項目の形を確かめて使う
    const items = JSON.parse(readFileSync(pluginScript('scripts/sandbox/sandbox-diff-items.json'), 'utf8')) as Item[]
    const spec = readFileSync(path.join(repositoryRoot, 'specs/026-pre-merge-test-env/spec.md'), 'utf8')
    const compared = [...new Set(items.filter(item => item.compare).map(item => item.id))].toSorted(compareStrings)
    expect(compared).toStrictEqual(['FR-001', 'FR-002', 'FR-003'])
    const reasons = Object.fromEntries(items.filter(item => !item.compare).map(item => [item.id, item.reason]))
    expect(reasons).toStrictEqual(specTable(spec, '同じにしなくてよいもの'))
    expect(new Set(items.filter(item => item.compare).map(item => item.name))).toStrictEqual(new Set(['merge-settings', 'ruleset', 'board-fields', 'config-file', 'workflows']))
    expect(items.filter(item => item.compare).every(item => Array.isArray(item.ignore))).toBe(true)
  })
})

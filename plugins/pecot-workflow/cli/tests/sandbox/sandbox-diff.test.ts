/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはテストの一時ディレクトリ配下とリポ内の定義のみ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- フィクスチャを組み替える作業用のクラスを渡す */
/* eslint-disable unicorn/no-null -- GitHub の API の応答にある null を再現する */
// sandbox-diff.sh を、偽の gh（URL ごとのフィクスチャを返し、無ければ API 失敗）で動かして結果を確かめる。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { stepSync } from '../_helpers/step.js'
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
// 呼ばれた先と、渡された GH_TOKEN を calls.log に書く。
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
  'printf \'%s %s\\n\' "${GH_TOKEN:-<none>}" "$url" >> "$FAKE_GH_DIR/calls.log"',
  'f="$FAKE_GH_DIR/${url//[^A-Za-z0-9]/_}"',
  '[ -f "$f" ] || exit 1',
  'cat "$f"',
].join('\n')

const BOARD_SYNC = 'name: pecot-board-sync\non: workflow_dispatch\njobs:\n  sync:\n    steps:\n      - uses: ./actions/board-sync\n'

const REVIEW = 'name: pecot review\non: pull_request\njobs:\n  review:\n    steps:\n      # このリポだけの step\n      - name: Check out the pecot actions\n        uses: actions/checkout@0\n        with:\n          path: .pecot-actions\n\n      - name: Finish\n        uses: ./.pecot-actions/actions/review-finish\n'

// 検証用の写しは、pecot の action を pecotcraft/pecot から呼び、このリポだけの step を持たない
const SANDBOX_REVIEW = 'name: pecot review\non: pull_request\njobs:\n  review:\n    steps:\n      - name: Finish\n        uses: pecotcraft/pecot/actions/review-finish@main\n'

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
type ConfigFields = Record<string, { id: string, options?: Record<string, string> }>
interface ProjectConfig { host: string, owner: string, workflow_suffix?: string, project: { number: number, fields?: ConfigFields } }

// 今の実物と同じ欄と選択肢のキー。ID は番号ごとに変える
function configFields(number: number): ConfigFields {
  const field = (name: string, keys: readonly string[]) => ({
    id: `F_${name}_${String(number)}`,
    options: Object.fromEntries(keys.map((key, index) => [key, `${String(number)}-${String(index)}`])),
  })
  return {
    workflow: field('workflow', ['backlog', 'pending', 'blocked', 'ready', 'active', 'in_review', 'archived']),
    status: field('status', ['todo', 'in_progress', 'needs_attention']),
  }
}

// #701 の前の形の設定ファイル（<host>_<owner>_<題>_<suffix>.json）
function legacyConfig(slug: string, suffix: string, number: number): [string, ProjectConfig] {
  return [`github.com_pecotcraft_${slug}_${suffix}.json`, { host: 'github.com', owner: 'pecotcraft', workflow_suffix: suffix, project: { number, fields: configFields(number) } }]
}

// 今の形の設定ファイル（<host>_<owner>_<number>.json）
function currentConfig(number: number): [string, ProjectConfig] {
  return [`github.com_pecotcraft_${String(number)}.json`, { host: 'github.com', owner: 'pecotcraft', project: { number, fields: configFields(number) } }]
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

function makeBoard(): Board {
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
    single('F_wf', 'pecot-status', ['Pending', 'Backlog', 'Blocked', 'Ready', 'Active', 'In Review', 'Archived']),
    single('F_lane', 'pecot-lane', ['pecot-workflow', 'pecot-visual', 'pecot-tools', 'repo']),
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
  readonly files: Record<string, string> = { 'ci.yml': 'name: ci\n', 'codeql.yml': 'name: codeql\n', 'pecot-board-sync.yml': BOARD_SYNC, 'pecot-handoff.yml': HANDOFF, 'pecot-review.yml': REVIEW }
  // undefined は、設定のディレクトリが無い（一覧が 404）
  configs: Record<string, ProjectConfig> | undefined
  // 生の中身で置く設定ファイル。undefined は、応答に content が無い
  readonly rawConfigs: Record<string, string | undefined> = {}

  constructor(readonly repository: string, readonly project: number, rulesetId: number, config: [string, ProjectConfig]) {
    this.rulesets = [makeRuleset(rulesetId, repository)]
    this.board = makeBoard()
    this.configs = Object.fromEntries([config])
  }

  setConfigs(...configs: readonly [string, ProjectConfig][]): void {
    this.configs = Object.fromEntries(configs)
  }

  // 設定ファイルが 1 つのときの、その欄
  configFields(): ConfigFields {
    const [config] = Object.values(this.configs ?? {})
    const fields = config?.project.fields
    if (fields === undefined) throw new Error('設定の欄が無い')
    return fields
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

  withFile(name: string, text: string): void {
    Object.assign(this.files, { [name]: text })
  }

  withoutFile(name: string): void {
    Reflect.deleteProperty(this.files, name)
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
  readonly this = new Side(THIS, 1, 26_538_811, currentConfig(1))
  readonly sandbox = new Side(SANDBOX, 3, 27_130_266, currentConfig(3))

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

  it('git の作業ツリーの外で実行すると、error の行を表示して終了コード 2 で止まる', async () => {
    await explains('`sandbox-diff.sh` を git の作業ツリーの外で実行した場合のテストです。作業用のディレクトリを作成できないため、`error:` で始まるメッセージを標準エラーに表示して、終了コード 2 で終了することを確認します。')
    const outside = makeSandbox(FAKE_GH)
    const result = stepSync('git の作業ツリーの外で sandbox-diff.sh を動かす', () => runScript(outside, script, [], { GIT_CEILING_DIRECTORIES: path.dirname(outside.directory) }))
    stepSync('終了コードと標準エラーを比べる', () => {
      expect([result.status, result.stdout, result.stderr]).toStrictEqual([2, '', 'error: git の作業ツリーの中で打ってください（作業用の場所を .pecot/tmp に作るため）\n'])
    })
  })

  it('両方の設定が同じ場合は、ずれが 0 件になる', async () => {
    await explains('本体リポジトリと検証用リポジトリの設定が同じ場合のテストです。「ずれは 0 件」と表示して、終了コード 0 で終了することを確認します。')
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout, result.stderr]).toStrictEqual([0, 'ずれは 0 件\n', ''])
    })
  })

  it('検証用の必須チェックが 1 つ不足していると、required_status_checks の差異として表示する', async () => {
    await explains('必須のステータスチェックの比較のテストです。検証用の ruleset から `version-plan` を除くと、`required_status_checks` の差異が表示され、検証用だけ `version-plan` を含まないことを確認します。')
    const checks = scene.sandbox.rule('required_status_checks')
    checks.parameters?.required_status_checks?.pop()
    const thisChecks = scene.this.rule('required_status_checks')
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      const expectedThis = compact(withoutIntegrationId(thisChecks.parameters ?? {}))
      const expectedSandbox = compact(withoutIntegrationId(checks.parameters ?? {}))
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('ruleset main / required_status_checks', expectedThis, expectedSandbox)))
      const lines = splitLines(result.stdout)
      expect(lines[2]).toContain('version-plan')
      expect(lines[3]).not.toContain('version-plan')
    })
  })

  it('merge_queue の規則が検証用に存在しないと、検証用を「なし」として差異に表示する', async () => {
    await explains('ruleset の `merge_queue` の規則の比較のテストです。検証用に規則が存在しない場合に、検証用の値を「なし」として差異に表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.withoutRule('merge_queue')
    })
    const queue = scene.this.rule('merge_queue')
    const expected = expectedDrifts(drift('ruleset main / merge_queue', compact(queue.parameters), 'なし'))
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expected)
    })
  })

  it('code_scanning の規則が検証用に存在しなくても、比較の対象にしない', async () => {
    await explains('ruleset の `code_scanning` の規則の扱いのテストです。検証用にこの規則が存在しなくても差異にならず、「ずれは 0 件」と表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.withoutRule('code_scanning')
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    })
  })

  it.for(['pages-store', 'release-tags'])('本体リポジトリだけで使う ruleset %s が検証用に存在しなくても、比較の対象にしない', async (name) => {
    await explains(`本体リポジトリだけで使う ruleset の扱いのテストです。\`${name}\` が検証用に存在しなくても差異にならず、「ずれは 0 件」と表示することを確認します。`)
    stepSync('偽の GitHub の状態を整える', () => {
      scene.this.rulesets.push({ ...makeRuleset(1, THIS), name })
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    })
  })

  it('除外の一覧にない名前の ruleset が検証用に存在しないと、ruleset の差異として表示する', async () => {
    await explains('ruleset の比較のテストです。本体リポジトリだけに `other` という ruleset がある場合に、「ずれは 1 件」と `ruleset other` を表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.this.rulesets.push({ ...makeRuleset(1, THIS), name: 'other' })
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(result.status).toBe(1)
      expect(splitLines(result.stdout).slice(0, 2)).toStrictEqual(['ずれは 1 件', 'ruleset other'])
    })
  })

  it('検証用のボードの選択肢が 1 つ多いと、board-fields の差異として表示する', async () => {
    await explains('ボードの欄の比較のテストです。検証用の `pecot-status` に選択肢 `Done` を追加すると、`board-fields / pecot-status` の差異として、両方の選択肢の一覧を表示することを確認します。')
    const field = find(scene.sandbox.fields(), f => f.name === 'pecot-status')
    const names = (field.options ?? []).map(option => ({ name: option.name }))
    const before = { dataType: 'SINGLE_SELECT', options: names }
    field.options?.push({ id: 'x', name: 'Done', color: 'GREEN', description: '' })
    const after = { dataType: 'SINGLE_SELECT', options: [...names, { name: 'Done' }] }
    const expected = expectedDrifts(drift('board-fields / pecot-status', compact(before), compact(after)))
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expected)
    })
  })

  it('ボードの選択肢は、順序の違いも差異として扱う', async () => {
    await explains('ボードの選択肢の順序のテストです。検証用の `pecot-lane` の選択肢を逆順にすると、`board-fields / pecot-lane` の差異として表示することを確認します。')
    find(scene.sandbox.fields(), f => f.name === 'pecot-lane').options?.reverse()
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(result.status).toBe(1)
      expect(splitLines(result.stdout).slice(0, 2)).toStrictEqual(['ずれは 1 件', 'board-fields / pecot-lane'])
    })
  })

  it('ID や日付など比較しない項目だけが違う場合は、ずれが 0 件になる', async () => {
    await explains('比較から除外する項目のテストです。ruleset・ボード・リポジトリ設定の ID、日付、色などだけが違う場合に、「ずれは 0 件」と表示することを確認します。')
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
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    })
  })

  it('board-sync の中身が違うと、両方の blob の sha と違う最初の行を出す（FR-032）', async () => {
    await explains('ワークフローのファイルの比較のテストです。検証用の `pecot-board-sync.yml` の内容が違う場合に、両方の blob の sha と、内容が違う最初の行を差異として表示することを確認します。')
    const other = BOARD_SYNC.replace('workflow_dispatch', 'push')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.files['pecot-board-sync.yml'] = other
    })
    const line = 2
    const expectedThis = `blob ${blob(BOARD_SYNC)}、${String(line)} 行目: ${splitLines(BOARD_SYNC)[line - 1] ?? ''}`
    const expectedSandbox = `blob ${blob(other)}、${String(line)} 行目: ${splitLines(other)[line - 1] ?? ''}`
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('workflows / pecot-board-sync.yml', expectedThis, expectedSandbox)))
    })
  })

  it('pecot-review.yml の内容が違うと、ファイル名の項目に両方の blob の sha と違う最初の行を表示する', async () => {
    await explains('ワークフローのファイルの比較のテストです。`pecot-review.yml` の内容が違う場合に、`workflows / pecot-review.yml` の差異として、blob の sha と違う最初の行を表示することを確認します。')
    const other = REVIEW.replace('on: pull_request', 'on: push')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.files['pecot-review.yml'] = other
    })
    const line = 2
    const expectedThis = `blob ${blob(REVIEW)}、${String(line)} 行目: ${splitLines(REVIEW)[line - 1] ?? ''}`
    const expectedSandbox = `blob ${blob(other)}、${String(line)} 行目: ${splitLines(other)[line - 1] ?? ''}`
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('workflows / pecot-review.yml', expectedThis, expectedSandbox)))
    })
  })

  it('pecot の action を pecotcraft/pecot から呼び、このリポだけの step が無い写しは、ずれに出さない', async () => {
    await explains('ワークフローのファイルの比較のテストです。検証用の写しが pecot の action を `pecotcraft/pecot` から呼び、このリポジトリだけの step を持たない場合に、差異にせず「ずれは 0 件」と表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.files['pecot-review.yml'] = SANDBOX_REVIEW
      scene.sandbox.files['pecot-board-sync.yml'] = BOARD_SYNC.replace('./actions/board-sync', 'pecotcraft/pecot/actions/board-sync@0123456789abcdef0123456789abcdef01234567 # pecot-actions/v1.0.0')
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    })
  })

  it('検証用に pecot-review.yml が無いと、検証用を「なし」としてずれに出す', async () => {
    await explains('ワークフローのファイルの存在の比較のテストです。検証用に `pecot-review.yml` が存在しない場合は、検証用の値を「なし」と表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      delete scene.sandbox.files['pecot-review.yml']
    })
    const expectedThis = `blob ${blob(REVIEW)}、1 行目: ${splitLines(REVIEW)[0] ?? ''}`
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('workflows / pecot-review.yml', expectedThis, 'なし')))
    })
  })

  it('pecot-handoff.yml の内容が違うと、ファイル名の項目に両方の blob の sha と違う最初の行を表示する', async () => {
    await explains('ワークフローのファイルの比較のテストです。`pecot-handoff.yml` の内容が違う場合に、`workflows / pecot-handoff.yml` の差異として、blob の sha と違う最初の行を表示することを確認します。')
    const other = HANDOFF.replace('@0', '@1')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.files['pecot-handoff.yml'] = other
    })
    const line = 6
    const expectedThis = `blob ${blob(HANDOFF)}、${String(line)} 行目: ${splitLines(HANDOFF)[line - 1] ?? ''}`
    const expectedSandbox = `blob ${blob(other)}、${String(line)} 行目: ${splitLines(other)[line - 1] ?? ''}`
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('workflows / pecot-handoff.yml', expectedThis, expectedSandbox)))
    })
  })

  it('検証用に pecot-handoff.yml が存在しないと、検証用を「なし」として差異に表示する', async () => {
    await explains('ワークフローのファイルの存在の比較のテストです。検証用に `pecot-handoff.yml` が存在しない場合は、検証用の値を「なし」と表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      delete scene.sandbox.files['pecot-handoff.yml']
    })
    const expectedThis = `blob ${blob(HANDOFF)}、1 行目: ${splitLines(HANDOFF)[0] ?? ''}`
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('workflows / pecot-handoff.yml', expectedThis, 'なし')))
    })
  })

  it.for(['ci.yml', 'codeql.yml'])('%s は、存在するかどうかだけを比較する', async (name) => {
    await explains(`\`${name}\` の比較のテストです。内容が違っても差異にならず、検証用に存在しない場合だけ、「あり」と「なし」の差異として表示することを確認します。`)
    stepSync('検証用に、内容が違うファイルを置く', () => {
      scene.sandbox.withFile(name, 'name: other\n')
    })
    const same = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれが 0 件であることを確かめる', () => {
      expect([same.status, same.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    })
    stepSync('検証用からファイルを除く', () => {
      scene.sandbox.withoutFile(name)
    })
    const missing = stepSync('もう一度 sandbox-diff.sh を動かす', () => scene.run())
    stepSync('あり・なしの差異を比べる', () => {
      expect(drifted(missing)).toStrictEqual(expectedDrifts(drift(`workflows / ${name}`, 'あり', 'なし')))
    })
  })

  it('両方の設定ファイルが旧い名前の形式なら、ずれが 0 件になる', async () => {
    await explains('ボードの設定ファイル名の比較のテストです。両方が旧い形式（`<host>_<owner>_<題>_<suffix>.json`）の名前である場合に、「ずれは 0 件」と表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.this.setConfigs(legacyConfig('pecot-project', 'pecotcraft', 1))
      scene.sandbox.setConfigs(legacyConfig('pecot-sandbox', 'sandbox', 3))
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    })
  })

  it('検証用の設定ファイルだけが旧い名前の形式だと、config-file の差異に両方の形式を表示する', async () => {
    await explains('ボードの設定ファイル名の比較のテストです。検証用だけが旧い形式の場合に、`config-file` の差異として、現在の形式と旧い形式の両方を表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.setConfigs(legacyConfig('pecot-sandbox', 'sandbox', 3))
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('config-file', CURRENT_FORM, LEGACY_FORM)))
    })
  })

  it('検証用に比較対象のボードの設定ファイルが存在しないと、検証用を「なし」として差異に表示する', async () => {
    await explains('ボードの設定ファイルの存在のテストです。検証用に設定ファイルが 1 つも存在しない場合に、`config-file` の差異として検証用の値を「なし」と表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.setConfigs()
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('config-file', CURRENT_FORM, 'なし')))
    })
  })

  it('別のボードを指す設定ファイルは、比較の対象にしない', async () => {
    await explains('ボードの設定ファイルの選択のテストです。検証用に別のボード（番号 9）を指す設定ファイルがあっても差異にならず、「ずれは 0 件」と表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.setConfigs(currentConfig(3), currentConfig(9))
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    })
  })

  it('同じボードの設定ファイルが 2 つあると、形式を名前順につないで差異に表示する', async () => {
    await explains('ボードの設定ファイルの重複のテストです。検証用に同じボードの設定ファイルが現在の形式と旧い形式で 2 つある場合に、`config-file` の差異として 2 つの形式を名前順に並べて表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.setConfigs(legacyConfig('pecot-sandbox', 'sandbox', 3), currentConfig(3))
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('config-file', CURRENT_FORM, `${CURRENT_FORM}、${LEGACY_FORM}`)))
    })
  })

  it('どちらの形式にも合わない名前は、名前をそのまま表示する', async () => {
    await explains('ボードの設定ファイル名の比較のテストです。検証用の設定ファイルの名前がどちらの形式にも合わない場合に、`config-file` の差異として `renamed.json` をそのまま表示することを確認します。')
    const [, config] = currentConfig(3)
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.setConfigs(['renamed.json', config])
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('config-file', CURRENT_FORM, 'renamed.json')))
    })
  })

  it('検証用の設定の status に in_progress が存在しないと、config-options の差異に両方のキーを表示する', async () => {
    await explains('設定ファイルの選択肢のキーの比較のテストです。検証用の `status` から `in_progress` を除くと、`config-options / status` の差異として両方のキーの一覧を表示することを確認します。')
    const status = scene.sandbox.configFields()['status']
    if (status?.options === undefined) throw new Error('status が無い')
    delete status.options['in_progress']
    const expected = expectedDrifts(drift('config-options / status', compact(['in_progress', 'needs_attention', 'todo']), compact(['needs_attention', 'todo'])))
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expected)
    })
  })

  it('検証用の workflow の選択肢のキーが 1 つ多いと、config-options / workflow の差異として表示する', async () => {
    await explains('設定ファイルの選択肢のキーの比較のテストです。検証用の `workflow` にキー `done` を追加すると、`config-options / workflow` の差異として両方のキーの一覧を表示することを確認します。')
    const workflow = scene.sandbox.configFields()['workflow']
    if (workflow?.options === undefined) throw new Error('workflow が無い')
    workflow.options['done'] = 'x'
    const keys = compact(['active', 'archived', 'backlog', 'blocked', 'in_review', 'pending', 'ready'])
    const added = compact(['active', 'archived', 'backlog', 'blocked', 'done', 'in_review', 'pending', 'ready'])
    const expected = expectedDrifts(drift('config-options / workflow', keys, added))
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expected)
    })
  })

  it('検証用の設定に欄 status が存在しないと、検証用を「なし」として差異に表示する', async () => {
    await explains('設定ファイルの欄の比較のテストです。検証用の設定に `status` の欄が存在しない場合に、`config-options / status` の差異として検証用の値を「なし」と表示することを確認します。')
    const fields = scene.sandbox.configFields()
    delete fields['status']
    const expected = expectedDrifts(drift('config-options / status', compact(['in_progress', 'needs_attention', 'todo']), 'なし'))
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expected)
    })
  })

  it('検証用の設定に project.fields が存在しないと、欄ごとの差異を表示して終了コード 1 で終了する', async () => {
    await explains('設定ファイルの `project.fields` のテストです。検証用の設定にこれが存在しない場合に、`status` と `workflow` の 2 件の差異を表示して、終了コード 1 で終了することを確認します。')
    const [name, config] = currentConfig(3)
    delete config.project.fields
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.setConfigs([name, config])
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stderr]).toStrictEqual([1, ''])
      const lines = splitLines(result.stdout)
      expect([lines[0], ...lines.filter(line => line.startsWith('config-options / '))]).toStrictEqual([
        'ずれは 2 件',
        'config-options / status',
        'config-options / workflow',
      ])
    })
  })

  it('選択肢の ID とキーの並び順だけが違う場合は、ずれが 0 件になる', async () => {
    await explains('設定ファイルの選択肢の比較のテストです。選択肢の ID とキーの並び順だけが違う場合に、キーの集合が同じなら「ずれは 0 件」と表示することを確認します。')
    const status = scene.sandbox.configFields()['status']
    if (status === undefined) throw new Error('status が無い')
    status.options = { needs_attention: 'a', todo: 'b', in_progress: 'c' }
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([0, 'ずれは 0 件\n'])
    })
  })

  it('同じボードの設定ファイルが 2 つあると、選択肢のキーを比較せず、config-options の差異を表示しない', async () => {
    await explains('ボードの設定ファイルの重複時のテストです。欄を持たない設定ファイルが一覧の先頭にあっても、`config-options` の差異を表示せず、`config-file` の差異だけを表示することを確認します。')
    // 欄の無いファイルを一覧の先頭に置く。先頭だけを読む形に崩れると、config-options のずれが出る
    const [name, config] = legacyConfig('pecot-sandbox', 'sandbox', 3)
    delete config.project.fields
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.setConfigs([name, config], currentConfig(3))
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('config-file', CURRENT_FORM, `${CURRENT_FORM}、${LEGACY_FORM}`)))
    })
  })

  it('JSON として読み込めない設定ファイルは無視し、ずれが 0 件になる', async () => {
    await explains('不正な設定ファイルの扱いのテストです。検証用に JSON として読み込めない設定ファイルがあっても、それを無視して「ずれは 0 件」と表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.rawConfigs['broken.json'] = '{'
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect([result.status, result.stdout, result.stderr]).toStrictEqual([0, 'ずれは 0 件\n', ''])
    })
  })

  it('設定ファイルの応答に content が存在しないと、error を表示して終了コード 2 で止まる', async () => {
    await explains('設定ファイルの応答の検証のテストです。応答に `content` が存在しない場合は、権限の不足を示す `error:` を標準エラーに表示し、終了コード 2 で終了することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.rawConfigs['empty.json'] = undefined
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('終了コードと標準エラーを比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([2, ''])
      expect(splitLines(result.stderr)).toStrictEqual([`error: repos/${SANDBOX}/contents/${CONFIG_DIR}/empty.json の応答に content がありません（権限の不足とみられます）`])
    })
  })

  it('検証用の設定のディレクトリが存在しないと、error を表示して終了コード 2 で止まる', async () => {
    await explains('設定のディレクトリを読み込めない場合のテストです。検証用のディレクトリの一覧が 404 になると、「gh が失敗しました」を含む `error:` のメッセージを標準エラーに表示して、終了コード 2 で終了することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.configs = undefined
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('終了コードと標準エラーを比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([2, ''])
      expect(splitLines(result.stderr)).toStrictEqual([`error: repos/${SANDBOX}/contents/${CONFIG_DIR} を読めません（gh が失敗しました）`])
    })
  })

  it('検証用のボードの進行の欄だけが旧い名前だと、board-fields の 2 件の差異として表示する', async () => {
    await explains('ボードの欄名の比較のテストです。検証用の `pecot-status` の欄が旧い名前 `pecot-workflow-sandbox` の場合に、それぞれの欄が片側に存在しない 2 件の差異として表示することを確認します。')
    find(scene.sandbox.fields(), f => f.name === 'pecot-status').name = 'pecot-workflow-sandbox'
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(result.status).toBe(1)
      const lines = splitLines(result.stdout)
      expect([lines[0], lines[1], lines[3], lines[4], lines[5], lines[7]]).toStrictEqual([
        'ずれは 2 件',
        'board-fields / pecot-status',
        '  検証用: なし',
        'board-fields / pecot-workflow-sandbox',
        '  このリポ: なし',
        undefined,
      ])
    })
  })

  it('マージ設定が違うと、merge-settings の差異として表示する', async () => {
    await explains('リポジトリのマージ設定の比較のテストです。検証用の `allow_rebase_merge` だけが違う場合に、`merge-settings / allow_rebase_merge` の差異として両方の値を表示することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.sandbox.settings['allow_rebase_merge'] = true
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('ずれの表示を比べる', () => {
      expect(drifted(result)).toStrictEqual(expectedDrifts(drift('merge-settings / allow_rebase_merge', 'false', 'true')))
    })
  })

  it('2 つの token を渡すと、このリポの先にはこのリポの token を、検証用とボードには検証用の token を使う', async () => {
    await explains('`sandbox-ops.yml` が渡す 2 つの token の選び分けのテストです。`repos/pecotcraft/pecot` の先にはこのリポの token を `GH_TOKEN` として渡すことを確認します。検証用のリポと GraphQL（ボード）には、検証用の token を渡します。')
    const result = scene.run({ SANDBOX_DIFF_THIS_REPO_TOKEN: 'this-token', SANDBOX_DIFF_SANDBOX_TOKEN: 'sandbox-token' })
    expect(result.status).toBe(0)
    const calls = splitLines(readFileSync(path.join(scene.workspace.fake, 'calls.log'), 'utf8')).map(line => line.split(' ', 2))
    const tokensOf = (isWanted: (url: string) => boolean): string[] => [...new Set(calls.filter(([, url = '']) => isWanted(url)).map(([token = '']) => token))]
    expect(tokensOf(url => url.startsWith(`repos/${THIS}/`) || url === `repos/${THIS}`)).toStrictEqual(['this-token'])
    expect(tokensOf(url => url.startsWith(`repos/${SANDBOX}`) || url.startsWith('graphql_'))).toStrictEqual(['sandbox-token'])
  })

  it('token の環境変数が無いと、GH_TOKEN を渡さず gh の認証を使う', async () => {
    await explains('端末で打つ場合のテストです。2 つの token の環境変数が無いと、どの先にも `GH_TOKEN` を渡さず、`gh` の認証のまま読むことを確認します。')
    const result = scene.run({ GH_TOKEN: '' })
    expect(result.status).toBe(0)
    const log = readFileSync(path.join(scene.workspace.fake, 'calls.log'), 'utf8')
    const tokens = new Set(splitLines(log).map(line => line.split(' ', 1)[0]))
    expect([...tokens]).toStrictEqual(['<none>'])
  })

  it('認証に失敗すると、エラーを表示して終了コード 2 で止まる', async () => {
    await explains('gh の認証に失敗した場合のテストです。`HTTP 401` のメッセージを含む `error:` を標準エラーに表示し、標準出力は空のまま、終了コード 2 で終了することを確認します。')
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run({ FAKE_GH_AUTH_FAIL: '1' }))
    stepSync('終了コードと標準エラーを比べる', () => {
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(splitLines(result.stderr)).toStrictEqual([
        `error: repos/${THIS} を読めません（HTTP 401: Bad credentials (https://api.github.com/graphql)）`,
      ])
    })
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
  ])('比較するキーが存在しないと、error を表示して終了コード 2 で止まる: $name', async ({ name, breaks }) => {
    await explains(`比較するキーが存在しない応答のテストです。「${name}」の場合に、同じ値とみなさず、権限の不足を示す \`error:\` のメッセージを表示して終了コード 2 で終了することを確認します。`)
    const expected = stepSync('応答のキーを欠かす', () => breaks(scene))
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('終了コードと標準エラーを比べる', () => {
      expect([result.status, result.stdout]).toStrictEqual([2, ''])
      expect(splitLines(result.stderr)).toStrictEqual([expected])
    })
  })

  it('両方のリポジトリで allow_auto_merge が null でも、同じとみなさず error で止まる', async () => {
    await explains('両方のリポジトリで比較するキーが `null` の場合のテストです。`allow_auto_merge` が両方とも `null` でも、同じ値とみなさず、`error:` を表示して終了コード 2 で終了することを確認します。')
    stepSync('偽の GitHub の状態を整える', () => {
      scene.this.settings['allow_auto_merge'] = null
      scene.sandbox.settings['allow_auto_merge'] = null
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => scene.run())
    stepSync('終了コードと標準エラーを比べる', () => {
      expect(result.status).toBe(2)
      expect(result.stderr.startsWith(`error: repos/${THIS} の応答に allow_auto_merge がありません`)).toBe(true)
    })
  })

  it('検証用の ruleset を取得できないと、gh の失敗として終了コード 2 で止まる', async () => {
    await explains('ruleset の取得に失敗した場合のテストです。検証用の ruleset の応答が存在しないと、「gh が失敗しました」を含む `error:` を標準エラーに表示して、終了コード 2 で終了することを確認します。')
    stepSync('検証用の ruleset の応答を消す', () => {
      scene.writeAll()
      rmSync(path.join(scene.workspace.fake, fixtureName(`repos/${SANDBOX}/rulesets/27130266`)))
    })
    const result = stepSync('sandbox-diff.sh を動かす', () => runScript(scene.workspace, script, []))
    stepSync('終了コードと標準エラーを比べる', () => {
      expect(result.status).toBe(2)
      expect(splitLines(result.stderr)).toStrictEqual([
        `error: repos/${SANDBOX}/rulesets/27130266 を読めません（gh が失敗しました）`,
      ])
    })
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
  it('比較する項目と除外する理由が、spec.md の 2 つの表と一致する', async () => {
    await explains('`sandbox-diff-items.json` と仕様書の対応のテストです。比較する項目が 3 つの要件に対応し、比較から除外する項目の理由が `spec.md` の表の内容と一致することを確認します。')
    const { items, spec } = stepSync('項目の定義と spec.md を読む', () => ({
      // eslint-disable-next-line no-restricted-syntax -- リポ内の定義ファイル。直後に項目の形を確かめて使う
      items: JSON.parse(readFileSync(pluginScript('scripts/sandbox/sandbox-diff-items.json'), 'utf8')) as Item[],
      spec: readFileSync(path.join(repositoryRoot, 'specs/026-pre-merge-test-env/spec.md'), 'utf8'),
    }))
    stepSync('項目と spec.md の表を比べる', () => {
      const compared = [...new Set(items.filter(item => item.compare).map(item => item.id))].toSorted(compareStrings)
      expect(compared).toStrictEqual(['FR-001', 'FR-002', 'FR-003'])
      const reasons = Object.fromEntries(items.filter(item => !item.compare).map(item => [item.id, item.reason]))
      expect(reasons).toStrictEqual(specTable(spec, '同じにしなくてよいもの'))
      expect(new Set(items.filter(item => item.compare).map(item => item.name))).toStrictEqual(new Set(['merge-settings', 'ruleset', 'board-fields', 'config-file', 'config-options', 'workflows']))
      expect(items.filter(item => item.compare).every(item => Array.isArray(item.ignore))).toBe(true)
    })
  })
})

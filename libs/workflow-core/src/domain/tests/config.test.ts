import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { parseJson } from '../../../tests/_helpers/json.js'
import { validationErrorOutput } from '../../../tests/_helpers/python-output.js'
import {
  aggregationRepositoryReference,
  ConfigError,
  configuredRepositoryFullName,
  effectiveReleaseType,
  findPackage,
  findRepository,
  getDevelopBranch,
  getFieldId,
  getOptionId,
  getReleaseBranch,
  isRepositoryInProject,
  parseProjectConfig,
  serializeProjectConfig,
  WORKFLOW_STATUSES,
  parsePackage,
  withAggregationRepository,
  withRepositoryAppended,
  withRepositoryReplaced,
  projectConfigFileName,
  workflowFieldId,
} from '../config.js'
import type { ProjectConfig, RepositoryMembership } from '../config.js'
import { InvalidValueError } from '../errors.js'
import type { JsonValue } from '../python-format.js'

function sampleConfigData(): Record<string, JsonValue> {
  return {
    host: 'ghes.example.com',
    owner: 'test-owner',
    project: {
      number: 1,
      id: 'PVT_test123',
      board_url: 'https://ghes.example.com/users/test-owner/projects/1',
      fields: {
        workflow: {
          id: 'FIELD_workflow',
          options: { backlog: 'opt_backlog', ready: 'opt_ready', active: 'opt_active', in_review: 'opt_in_review', archived: 'opt_archived' },
        },
        priority: { id: 'FIELD_priority', options: { high: 'opt_high', medium: 'opt_medium', low: 'opt_low' } },
        size: { id: 'FIELD_size', options: { xs: 'opt_xs', s: 'opt_s', m: 'opt_m', l: 'opt_l' } },
      },
    },
    repositories: [
      { owner: 'test-owner', name: 'test-repo', develop_branch: 'develop' },
      { owner: 'test-owner', name: 'another-repo' },
    ],
  }
}

function sampleConfig(): ProjectConfig {
  return parseProjectConfig(sampleConfigData())
}

function withRepositories(repositories: readonly JsonValue[]): ProjectConfig {
  return parseProjectConfig({ ...sampleConfigData(), repositories })
}

function validationMessage(data: JsonValue): string {
  try {
    parseProjectConfig(data)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) return error.message
    throw error
  }
  throw new Error('例外が出なかった')
}

describe('列挙値', () => {
  it('ワークフローのステータスの列挙値は、backlog から archived までの 7 つを順に返す', async () => {
    await explains('ワークフローのステータスの定数（`WORKFLOW_STATUSES`）のテストです。`backlog` から `archived` までの 7 つの値が、決まった順序で並んでいることを確認します。')
    expect(WORKFLOW_STATUSES).toEqual(['backlog', 'pending', 'blocked', 'ready', 'active', 'in_review', 'archived'])
  })
})

describe('parseProjectConfig（モデルの値）', () => {
  it('ホスト・持ち主・プロジェクト・リポジトリを持つ辞書から、設定を読み取る', async () => {
    await explains('プロジェクトの設定を読み取る関数（`parseProjectConfig`）のテストです。ホスト・持ち主・プロジェクトの番号・リポジトリを持つ辞書から、それぞれの値を読み取ることを確認します。')
    const config = sampleConfig()
    expect(config.host).toBe('ghes.example.com')
    expect(config.owner).toBe('test-owner')
    expect(config.project.number).toBe(1)
    expect(config.repositories).toHaveLength(2)
  })

  it('workflow だけのフィールド定義も、設定として読み取る', async () => {
    await explains('`workflow` のフィールドだけを持つ辞書のテストです。ほかのフィールドと `board_url` は `undefined`、リポジトリは空の配列として読み取ることを確認します。')
    const config = parseProjectConfig({
      host: 'github.com',
      owner: 'test',
      project: { number: 1, id: 'PVT', fields: { workflow: { id: 'WF', options: {} } } },
    })
    expect(config.project.fields.workflow).toEqual({ id: 'WF', options: {} })
    expect(config.project.fields.status).toBeUndefined()
    expect(config.project.board_url).toBeUndefined()
    expect(config.repositories).toEqual([])
  })

  it('任意の項目が null の場合は、undefined として読み取る', async () => {
    await explains('リポジトリの任意の項目（`develop_branch`・`release_branch`・`packages`）が `null` の場合のテストです。それらの項目は存在しないものとして、`undefined` になることを確認します。')
    const config = withRepositories([{ owner: 'a', name: 'b', develop_branch: parseJson('null'), release_branch: parseJson('null'), packages: parseJson('null') }])
    expect(config.repositories[0]).toEqual({ owner: 'a', name: 'b' })
  })

  it('release_branch・changelog_file・packages を指定した場合は値を読み取り、指定しない場合の packages は undefined にする', async () => {
    await explains('リポジトリに、`release_branch`・`changelog_file`・`packages` を指定した場合のテストです。指定した値をそのまま読み取り、指定しなかったリポジトリの `packages` は `undefined` になることを確認します。')
    const config = withRepositories([
      { owner: 'o', name: 'r1', develop_branch: 'develop', release_branch: 'main' },
      { owner: 'o', name: 'r2', changelog_file: 'AIST-CHANGELOG.md' },
      { owner: 'o', name: 'r3', packages: [{ name: 'pecot', changelog: 'plugins/pecot-workflow/CHANGELOG.md' }, { name: 'pecotv', changelog: 'plugins/pecot-visual/CHANGELOG.md' }] },
    ])
    expect(config.repositories[0]?.release_branch).toBe('main')
    expect(config.repositories[1]?.changelog_file).toBe('AIST-CHANGELOG.md')
    expect(config.repositories[1]?.packages).toBeUndefined()
    expect(config.repositories[2]?.packages?.map(item => item.name)).toEqual(['pecot', 'pecotv'])
  })

  it('未知のキーは読み捨てる（Python の既定と同じ）', async () => {
    await explains('設定に未知のキー（`extra`）が含まれる場合のテストです。Python の既定の動作と同じく、読み取った設定にそのキーが含まれないことを確認します。')
    const config = parseProjectConfig({ ...sampleConfigData(), extra: 1 })
    expect(Object.keys(config)).not.toContain('extra')
  })

  it('読み取った設定は、読み取り専用（凍結）にする', async () => {
    await explains('読み取った設定のテストです。設定とリポジトリの配列が、変更できない状態（凍結）になっていることを確認します。')
    const config = sampleConfig()
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.repositories)).toBe(true)
  })
})

describe('parseProjectConfig（旧い形）', () => {
  it('旧い設定の workflow_suffix は読み捨て、保存する内容にも含めない', async () => {
    await explains('旧い設定の項目（`workflow_suffix`）を含む辞書のテストです。読み取った設定にその項目は含まれず、保存する内容にも出力されないことを確認します。')
    const config = parseProjectConfig({ ...sampleConfigData(), workflow_suffix: 'test' })
    expect(Object.keys(config)).not.toContain('workflow_suffix')
    expect(serializeProjectConfig(config)).not.toContain('workflow_suffix')
  })

  it('旧い設定の fields.priority・fields.size は読み捨て、保存し直す内容にも含めない', async () => {
    await explains('旧い設定の項目（`fields.priority`・`fields.size`）を含む辞書のテストです。読み取った設定にそれらの項目は含まれず、保存し直した内容にも名前と ID が出力されないことを確認します。')
    const config = parseProjectConfig(sampleConfigData())
    expect(Object.keys(config.project.fields)).not.toContain('priority')
    expect(Object.keys(config.project.fields)).not.toContain('size')
    const saved = serializeProjectConfig(config)
    expect(saved).not.toContain('"priority"')
    expect(saved).not.toContain('"size"')
    expect(saved).not.toContain('FIELD_priority')
    expect(saved).not.toContain('FIELD_size')
  })

  it('workflow_suffix が存在しない設定も、読み取る', async () => {
    await explains('旧い項目の `workflow_suffix` が存在しない設定のテストです。エラーにならず、`workflow` のフィールドの ID を読み取ることを確認します。')
    expect(parseProjectConfig(sampleConfigData()).project.fields.workflow.id).toBe('FIELD_workflow')
  })
})

describe('parseProjectConfig（検証エラー）', () => {
  it.each(['config-exclusive', 'config-aggregation-single-segment', 'config-nine-errors'])('検証エラーのメッセージは、%s の入力で Python の実出力と同じになる', async (id) => {
    await explains('検証エラーのメッセージのテストです。不正な設定を読み取ったときに、Python の実際の出力（`validationErrorOutput`）と同じメッセージの例外を投げることを確認します。')
    const { input, message } = validationErrorOutput(id)
    expect(validationMessage(input)).toBe(message)
  })

  it('number が整数ではない場合は、小数の入力と、リストではない入力の検証エラーを返す', async () => {
    await explains('プロジェクトの番号が小数で、リポジトリがリストではない設定のテストです。2 件の検証エラーとして、`int_from_float` と `list_type` のメッセージを含めて返すことを確認します。')
    const base = sampleConfigData()
    const project = parseJson('{"number": 1.5, "id": "a", "fields": {"workflow": {"id": "x", "options": {}}}}')
    const message = validationMessage({ ...base, project, repositories: 'no' })
    expect(message).toContain('2 validation errors for ProjectConfig\nproject.number\n  Input should be a valid integer, got a number with a fractional part [type=int_from_float, input_value=1.5, input_type=float]')
    expect(message).toContain('repositories\n  Input should be a valid list [type=list_type, input_value=\'no\', input_type=str]')
  })

  it('設定がオブジェクトではない場合は、model_type の検証エラーを返す', async () => {
    await explains('設定として配列を渡した場合のテストです。辞書ではないため、`model_type` の検証エラーを、Python の出力と同じメッセージで返すことを確認します。')
    expect(validationMessage([1, 2, 3])).toBe([
      '1 validation error for ProjectConfig',
      '  Input should be a valid dictionary or instance of ProjectConfig [type=model_type, input_value=[1, 2, 3], input_type=list]',
      '    For further information visit https://errors.pydantic.dev/2.14/v/model_type',
    ].join('\n'))
  })

  it('入力値の表記が 50 文字を超える場合は、途中を省略して表示する（Python の実出力）', async () => {
    await explains('75 文字の値を持つ設定のテストです。検証エラーの `input_value` が、Python の実際の出力と同じく 50 文字を超える部分を省略した表記になることを確認します。')
    expect(validationMessage({ host: 'h'.repeat(75) })).toContain('input_value={\'host\': \'hhhhhhhhhhhhhhh...hhhhhhhhhhhhhhhhhhhhhh\'}, input_type=dict]')
  })

  it('options が辞書ではない場合は、dict_type の検証エラーを返す', async () => {
    await explains('`workflow` の `options` が配列の設定のテストです。辞書ではないため、`dict_type` の検証エラーを返すことを確認します。')
    const data = sampleConfigData()
    const project = parseJson('{"number": 1, "id": "a", "fields": {"workflow": {"id": "x", "options": [1]}}}')
    expect(validationMessage({ ...data, project })).toContain('project.fields.workflow.options\n  Input should be a valid dictionary [type=dict_type, input_value=[1], input_type=list]')
  })

  it('配列の要素がオブジェクトではない場合は、クラス名を含む model_type の検証エラーを返す', async () => {
    await explains('リポジトリの配列に、数値が含まれる設定のテストです。要素の位置とクラス名（`Repository`）を含む、`model_type` の検証エラーを返すことを確認します。')
    expect(validationMessage({ ...sampleConfigData(), repositories: [1] })).toContain('repositories.0\n  Input should be a valid dictionary or instance of Repository [type=model_type, input_value=1, input_type=int]')
  })
})

function numberOf(value: JsonValue): number {
  const project = { number: value, id: 'a', fields: { workflow: { id: 'x', options: {} } } }
  return parseProjectConfig({ ...sampleConfigData(), project }).project.number
}

describe('number の lax な変換（Python の実出力どおり）', () => {
  it.each([
    ['"12"', 12],
    ['" 12 "', 12],
    ['"+5"', 5],
    ['"-7"', -7],
    ['"1_000"', 1000],
    ['"1.0"', 1],
    ['"1.00"', 1],
    ['" 1.0 "', 1],
    ['"-0.0"', 0],
    ['true', 1],
    ['false', 0],
    ['2.0', 2],
  ])('number に %s を渡した場合は、整数 %d として読み取る', async (json, expected) => {
    await explains(`プロジェクトの番号の変換のテストです。文字列や真偽値など、\`${json}\` を渡した場合に、Python の既定と同じ変換で整数として読み取ることを確認します。`)
    expect(numberOf(parseJson(json))).toBe(expected)
  })

  it.each([
    ['"\u{FF11}\u{FF12}\u{FF13}"', 'int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['"1.5"', 'int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['"1."', 'int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['".0"', 'int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['"1e3"', 'int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['""', 'int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['"abc"', 'int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['"0x10"', 'int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['1.5', 'int_from_float', 'Input should be a valid integer, got a number with a fractional part'],
    ['null', 'int_type', 'Input should be a valid integer'],
    ['[1]', 'int_type', 'Input should be a valid integer'],
    ['{"a": 1}', 'int_type', 'Input should be a valid integer'],
  ])('number に %s を渡した場合は、検証エラー %s を返す', async (json, type, text) => {
    await explains(`プロジェクトの番号の変換のテストです。整数に変換できない値（\`${json}\`）を渡した場合に、\`${type}\` の検証エラーと、Python と同じメッセージを返すことを確認します。`)
    const project = { number: parseJson(json), id: 'a', fields: { workflow: { id: 'x', options: {} } } }
    expect(validationMessage({ ...sampleConfigData(), project })).toContain(`${text} [type=${type}, `)
  })
})

function aggregationData(extra: Readonly<Record<string, JsonValue>>): JsonValue {
  return {
    host: 'github.com',
    owner: 'acme-labs',
    project: { number: 1, id: 'PVT_xxx', fields: { workflow: { id: 'F_workflow', options: { backlog: 'o1', active: 'o2' } } } },
    repositories: [],
    ...extra,
  }
}

describe('aggregation_repo', () => {
  it('aggregation_repo を指定しない場合は、undefined にする', async () => {
    await explains('`aggregation_repo` を指定しない設定のテストです。読み取った値が `undefined` になることを確認します。')
    expect(parseProjectConfig(aggregationData({})).aggregation_repo).toBeUndefined()
  })

  it('aggregation_repo が null の場合も、undefined にする', async () => {
    await explains('`aggregation_repo` が `null` の設定のテストです。読み取った値が `undefined` になることを確認します。')
    const config = parseProjectConfig(aggregationData({ aggregation_repo: parseJson('null') }))
    expect(config.aggregation_repo).toBeUndefined()
  })

  it('aggregation_repo が owner/repo の形式の場合は、受け付ける', async () => {
    await explains('`aggregation_repo` に `a/b` を指定した場合のテストです。検証を通り、指定した値のまま読み取ることを確認します。')
    expect(parseProjectConfig(aggregationData({ aggregation_repo: 'a/b' })).aggregation_repo).toBe('a/b')
  })

  it.each(['a', 'owner/repo/extra', ''])('aggregation_repo が %j の場合は、検証エラーを返す', async (value) => {
    await explains('`aggregation_repo` が `owner/repo` の形式ではない場合のテストです。要素が不足する値や、多すぎる値、空文字の場合に、形式を案内するメッセージの検証エラーを返すことを確認します。')
    expect(() => parseProjectConfig(aggregationData({ aggregation_repo: value }))).toThrow(InvalidValueError)
    expect(() => parseProjectConfig(aggregationData({ aggregation_repo: value }))).toThrow('aggregation_repo must be in \'owner/repo\' form')
  })

  it('aggregation_repo が配列の場合は、文字列ではないため検証エラーを返す', async () => {
    await explains('`aggregation_repo` に配列を指定した場合のテストです。文字列ではないため、検証エラーを返すことを確認します。')
    expect(() => parseProjectConfig(aggregationData({ aggregation_repo: ['a/b'] }))).toThrow('Input should be a valid string')
  })
})

describe('フィールドの検索', () => {
  const config = sampleConfig()

  const withStatus = parseProjectConfig({
    ...sampleConfigData(),
    project: { number: 1, id: 'a', fields: { workflow: { id: 'FIELD_workflow', options: { active: 'opt_active' } }, status: { id: 'FIELD_status', options: { in_progress: 'opt_in_progress' } } } },
  })

  it('フィールド名から ID を求め、存在しない名前の場合は undefined を返す', async () => {
    await explains('フィールドの ID を求める関数（`getFieldId`）のテストです。`workflow` と `status` はそれぞれの ID を返し、存在しない名前の場合は `undefined` を返すことを確認します。')
    expect(getFieldId(withStatus, 'workflow')).toBe('FIELD_workflow')
    expect(getFieldId(withStatus, 'status')).toBe('FIELD_status')
    expect(getFieldId(withStatus, 'nonexistent')).toBeUndefined()
  })

  it('フィールド名と選択肢の名前から選択肢の ID を求め、存在しない組み合わせの場合は undefined を返す', async () => {
    await explains('選択肢の ID を求める関数（`getOptionId`）のテストです。存在するフィールドと選択肢の組み合わせはその ID を返し、存在しない選択肢やフィールドの場合は `undefined` を返すことを確認します。')
    expect(getOptionId(withStatus, 'workflow', 'active')).toBe('opt_active')
    expect(getOptionId(withStatus, 'status', 'in_progress')).toBe('opt_in_progress')
    expect(getOptionId(withStatus, 'workflow', 'nonexistent')).toBeUndefined()
    expect(getOptionId(withStatus, 'nonexistent', 'active')).toBeUndefined()
  })

  it('旧い設定に fields.priority・fields.size があっても、priority・size のフィールドの ID は undefined を返す', async () => {
    await explains('旧い設定の項目（`fields.priority`・`fields.size`）を含む設定のテストです。それらは読み捨てられているため、フィールドの ID も選択肢の ID も `undefined` を返すことを確認します。')
    expect(getFieldId(config, 'priority')).toBeUndefined()
    expect(getFieldId(config, 'size')).toBeUndefined()
    expect(getOptionId(config, 'priority', 'high')).toBeUndefined()
  })

  it('進行の欄は、設定の workflow のフィールドの ID で指す', async () => {
    await explains('進行の欄の ID を求める関数（`workflowFieldId`）のテストです。設定の `workflow` のフィールドの ID（`FIELD_workflow`）を返すことを確認します。')
    expect(workflowFieldId(config)).toBe('FIELD_workflow')
  })
})

describe('projectConfigFileName', () => {
  it('ホスト・持ち主・番号から設定ファイルの名前を作成し、ボードの題は使わない', async () => {
    await explains('設定ファイルの名前を作成する関数（`projectConfigFileName`）のテストです。ホスト・持ち主・プロジェクトの番号を `_` でつないだ名前（`github.com_pecotcraft_3.json`）を返すことを確認します。')
    expect(projectConfigFileName('github.com', 'pecotcraft', 3)).toBe('github.com_pecotcraft_3.json')
  })
})

describe('リポジトリの検索', () => {
  const config = sampleConfig()

  it('owner と名前からリポジトリを探し、存在しない場合は undefined を返す', async () => {
    await explains('リポジトリを探す関数（`findRepository`）のテストです。設定にあるリポジトリはその設定を返し、存在しない名前の場合は `undefined` を返すことを確認します。')
    expect(findRepository(config, 'test-owner', 'test-repo')?.name).toBe('test-repo')
    expect(findRepository(config, 'test-owner', 'nonexistent')).toBeUndefined()
  })

  it('リポジトリの develop ブランチを返し、未設定の場合や、リポジトリが存在しない場合は undefined を返す', async () => {
    await explains('develop ブランチを求める関数（`getDevelopBranch`）のテストです。設定したリポジトリはそのブランチ名を返し、未設定のリポジトリや存在しないリポジトリの場合は `undefined` を返すことを確認します。')
    expect(getDevelopBranch(config, 'test-owner', 'test-repo')).toBe('develop')
    expect(getDevelopBranch(config, 'test-owner', 'another-repo')).toBeUndefined()
    expect(getDevelopBranch(config, 'test-owner', 'nonexistent')).toBeUndefined()
  })

  it('リポジトリの release ブランチを返し、未設定の場合や、リポジトリが存在しない場合は undefined を返す', async () => {
    await explains('release ブランチを求める関数（`getReleaseBranch`）のテストです。設定したリポジトリはそのブランチ名を返し、未設定のリポジトリや存在しないリポジトリの場合は `undefined` を返すことを確認します。')
    const withRelease = withRepositories([{ owner: 'test-owner', name: 'test-repo', develop_branch: 'develop', release_branch: 'main' }, { owner: 'test-owner', name: 'another-repo' }])
    expect(getReleaseBranch(withRelease, 'test-owner', 'test-repo')).toBe('main')
    expect(getReleaseBranch(withRelease, 'test-owner', 'another-repo')).toBeUndefined()
    expect(getReleaseBranch(withRelease, 'test-owner', 'nonexistent')).toBeUndefined()
  })

  it('リポジトリの設定から、owner/name の形の名前を作成する', async () => {
    await explains('リポジトリの完全な名前を作成する関数（`configuredRepositoryFullName`）のテストです。`owner/name` の形（`test-owner/test-repo`）の名前を返すことを確認します。')
    const [first] = config.repositories
    expect(first && configuredRepositoryFullName(first)).toBe('test-owner/test-repo')
  })

  it('名前からリポジトリ内のパッケージを探し、存在しない名前の場合や、パッケージを持たないリポジトリの場合は undefined を返す', async () => {
    await explains('パッケージを探す関数（`findPackage`）のテストです。存在する名前はそのパッケージの変更履歴のパスを返し、存在しない名前や、パッケージを持たないリポジトリの場合は `undefined` を返すことを確認します。')
    const monorepo = withRepositories([{ owner: 'o', name: 'r', packages: [{ name: 'pecot', changelog: 'plugins/pecot-workflow/CHANGELOG.md' }] }, { owner: 'o', name: 'plain' }])
    const [repository, plain] = monorepo.repositories
    expect(repository && findPackage(repository, 'pecot')?.changelog).toBe('plugins/pecot-workflow/CHANGELOG.md')
    expect(repository && findPackage(repository, 'unknown')).toBeUndefined()
    expect(plain && findPackage(plain, 'pecot')).toBeUndefined()
  })

  it('effectiveReleaseType は、指定した値があればその値、なければ packages の有無で決める', async () => {
    await explains('リリースの種類を決める関数（`effectiveReleaseType`）のテストです。`release_type` を指定したリポジトリはその値（`nx`）、指定せず `packages` を持つ場合は `multi`、持たない場合は `single` を返すことを確認します。')
    const configWith = withRepositories([
      { owner: 'o', name: 'a', release_type: 'nx' },
      { owner: 'o', name: 'b', packages: [{ name: 'p', changelog: 'c' }] },
      { owner: 'o', name: 'c' },
    ])
    expect(configWith.repositories.map(repository => effectiveReleaseType(repository))).toEqual(['nx', 'multi', 'single'])
  })
})

function membership(linked: readonly { readonly owner: string, readonly name: string }[]): RepositoryMembership & { readonly calls: (readonly [string, number])[] } {
  const calls: (readonly [string, number])[] = []
  return {
    calls,
    linkedRepositories: (owner, projectNumber) => {
      calls.push([owner, projectNumber])
      return Promise.resolve(linked)
    },
  }
}

describe('isRepositoryInProject', () => {
  const config = sampleConfig()

  it('リポジトリがプロジェクトにリンクされている場合は true、されていない場合は false を返す', async () => {
    await explains('リポジトリがプロジェクトに含まれるか判定する関数（`isRepositoryInProject`）のテストです。リンクされているリポジトリは `true`、リンクされていないリポジトリは `false` を返すことを確認します。')
    const source = membership([{ owner: 'test-owner', name: 'test-repo' }, { owner: 'test-owner', name: 'another-repo' }])
    await expect(isRepositoryInProject(config, 'test-owner', 'test-repo', source)).resolves.toBe(true)
    await expect(isRepositoryInProject(config, 'test-owner', 'nonexistent', source)).resolves.toBe(false)
  })

  it('リンクの問い合わせは、プロジェクトの owner と番号を使って行う', async () => {
    await explains('リンクされたリポジトリを問い合わせる処理のテストです。引数のリポジトリの owner ではなく、設定のプロジェクトの owner と番号で問い合わせることを確認します。')
    const source = membership([])
    await isRepositoryInProject(config, 'x', 'y', source)
    expect(source.calls).toEqual([['test-owner', 1]])
  })
})

describe('ConfigError', () => {
  it('ConfigError は、渡したメッセージを持つ', async () => {
    await explains('設定の例外クラス（`ConfigError`）のテストです。投げた例外が、渡したメッセージを持つことを確認します。')
    expect(() => {
      throw new ConfigError('テストエラー')
    }).toThrow('テストエラー')
  })
})

describe('serializeProjectConfig', () => {
  it('2 スペースのインデントと末尾の改行で保存し、存在しない項目は出力しない', async () => {
    await explains('設定を保存する内容に変換する関数（`serializeProjectConfig`）のテストです。2 スペースのインデントで整形し、末尾に改行を付け、Python の `None` に当たる項目は出力しないことを確認します。')
    const config = parseProjectConfig({
      host: 'github.com',
      owner: 'test',
      project: { number: 1, id: 'PVT', fields: { workflow: { id: 'WF', options: {} } } },
    })
    expect(serializeProjectConfig(config)).toBe([
      '{',
      '  "host": "github.com",',
      '  "owner": "test",',
      '  "project": {',
      '    "number": 1,',
      '    "id": "PVT",',
      '    "fields": {',
      '      "workflow": {',
      '        "id": "WF",',
      '        "options": {}',
      '      }',
      '    }',
      '  },',
      '  "repositories": []',
      '}',
      '',
    ].join('\n'))
  })

  it('キーの順序はモデルの定義順にし、入力の順序には依存しない', async () => {
    await explains('キーを入力と違う順序で書いた設定のテストです。保存する内容では、`host` から `aggregation_repo` までのキーが、モデルで定義した順序に並ぶことを確認します。')
    const config = parseProjectConfig({
      repositories: [{ release_branch: 'main', name: 'r', owner: 'o' }],
      project: { fields: { workflow: { options: {}, id: 'WF' } }, id: 'PVT', number: 1 },
      owner: 'o',
      host: 'h',
      aggregation_repo: 'a/b',
    })
    const keys = Object.keys(parseJsonObject(serializeProjectConfig(config)))
    expect(keys).toEqual(['host', 'owner', 'project', 'repositories', 'aggregation_repo'])
    expect(serializeProjectConfig(config)).toContain('"owner": "o",\n      "name": "r",\n      "release_branch": "main"')
  })

  it('日本語は \\u エスケープせず、そのまま書き出す（ensure_ascii=False）', async () => {
    await explains('日本語の値を持つ設定のテストです。Python の `ensure_ascii=False` と同じく、`\\u` のエスケープをせず、日本語のまま保存する内容に出力することを確認します。')
    const config = withRepositories([{ owner: 'o', name: 'r', develop_branch: '開発' }])
    expect(serializeProjectConfig(config)).toContain('"develop_branch": "開発"')
  })

  it('保存した内容を読み直した場合は、元と同じ設定になる', async () => {
    await explains('設定を保存する内容に変換し、読み直した場合のテストです。ブランチやパッケージを含めて、元の設定と同じ内容になることを確認します。')
    const config = withRepositories([{ owner: 'o', name: 'r', develop_branch: 'develop', release_branch: 'main', packages: [{ name: 'pecot', changelog: 'plugins/pecot-workflow/CHANGELOG.md' }] }])
    const reloaded = parseProjectConfig(parseJson(serializeProjectConfig(config)))
    expect(reloaded).toEqual(config)
  })
})

function parseJsonObject(text: string): Readonly<Record<string, JsonValue>> {
  const value = parseJson(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('オブジェクトではない')
  return Object.fromEntries(Object.entries(value))
}

describe('aggregationRepositoryReference', () => {
  it('集約先のリポジトリが未設定の場合は undefined、設定済みの場合は owner と名前の参照を返す', async () => {
    await explains('集約先のリポジトリの参照を求める関数（`aggregationRepositoryReference`）のテストです。未設定の場合は `undefined`、`a/b` を設定した場合は owner と名前を分けた参照を返すことを確認します。')
    expect(aggregationRepositoryReference(sampleConfig())).toBeUndefined()
    const config = parseProjectConfig({ ...sampleConfigData(), aggregation_repo: 'a/b' })
    expect(aggregationRepositoryReference(config)).toEqual({ owner: 'a', repository: 'b' })
  })
})

describe('更新（コピーを作る）', () => {
  it('withAggregationRepository は、値を差し替えたコピーを返し、元の設定は変えない', async () => {
    await explains('集約先のリポジトリを差し替える関数（`withAggregationRepository`）のテストです。差し替えた値を持つ凍結したコピーを返し、元の設定は変更しないことを確認します。')
    const config = sampleConfig()
    const updated = withAggregationRepository(config, 'a/b')
    expect(updated.aggregation_repo).toBe('a/b')
    expect(config.aggregation_repo).toBeUndefined()
    expect(Object.isFrozen(updated)).toBe(true)
  })

  it('withAggregationRepository に undefined を渡した場合は、設定が外れ、保存する内容にも出力しない', async () => {
    await explains('集約先のリポジトリを設定済みの設定に、`undefined` を渡した場合のテストです。集約先の設定が外れ、保存する内容にも `aggregation_repo` が出力されないことを確認します。')
    const config = withAggregationRepository(parseProjectConfig({ ...sampleConfigData(), aggregation_repo: 'a/b' }), undefined)
    expect(config.aggregation_repo).toBeUndefined()
    expect(serializeProjectConfig(config)).not.toContain('aggregation_repo')
  })

  it('保存する内容では、aggregation_repo をキーの末尾に置く（モデルの定義順）', async () => {
    await explains('集約先のリポジトリを設定した設定のテストです。保存する内容の最後のキーが、モデルの定義順どおり `aggregation_repo` になることを確認します。')
    const text = serializeProjectConfig(withAggregationRepository(sampleConfig(), 'a/b'))
    expect(Object.keys(parseJsonObject(text)).at(-1)).toBe('aggregation_repo')
  })

  it('withRepositoryAppended は、末尾に追加したコピーを返し、元の設定は変えない', async () => {
    await explains('リポジトリを追加する関数（`withRepositoryAppended`）のテストです。末尾にリポジトリを追加した凍結のコピーを返し、元の設定のリポジトリの数は変わらないことを確認します。')
    const config = sampleConfig()
    const extra = withRepositories([{ owner: 'o', name: 'new' }]).repositories[0]
    expect(extra).toBeDefined()
    if (extra === undefined) return
    const updated = withRepositoryAppended(config, extra)
    expect(updated.repositories.map(repository => repository.name)).toEqual(['test-repo', 'another-repo', 'new'])
    expect(config.repositories).toHaveLength(2)
    expect(Object.isFrozen(updated.repositories)).toBe(true)
  })

  it('withRepositoryReplaced は、同じ owner と name の 1 件を差し替えたコピーを返し、元の設定は変えない', async () => {
    await explains('リポジトリを差し替える関数（`withRepositoryReplaced`）のテストです。同じ owner と name を持つ 1 件を差し替えた凍結のコピーを返し、元の設定は変更しないことを確認します。')
    const config = sampleConfig()
    const edited = withRepositories([{ owner: 'test-owner', name: 'test-repo', develop_branch: 'edited' }]).repositories[0]
    expect(edited).toBeDefined()
    if (edited === undefined) return
    const updated = withRepositoryReplaced(config, edited)
    expect(updated.repositories.map(repository => repository.name)).toEqual(['test-repo', 'another-repo'])
    expect(updated.repositories[0]?.develop_branch).toBe('edited')
    expect(config.repositories[0]?.develop_branch).not.toBe('edited')
    expect(Object.isFrozen(updated.repositories)).toBe(true)
  })

  it('withRepositoryReplaced は、同じリポジトリが存在しない場合は、元と同じ並びを返す', async () => {
    await explains('設定に存在しないリポジトリを渡した場合のテストです。差し替えと追加はせず、元と同じリポジトリの並びを返すことを確認します。')
    const config = sampleConfig()
    const other = withRepositories([{ owner: 'o', name: 'absent' }]).repositories[0]
    expect(other).toBeDefined()
    if (other === undefined) return
    expect(withRepositoryReplaced(config, other).repositories.map(repository => repository.name)).toEqual(['test-repo', 'another-repo'])
  })

  it('withRepositoryReplaced は、同じ owner と name が重複していても、最初の 1 件だけを差し替える', async () => {
    await explains('同じ owner と name のリポジトリが 2 件ある設定のテストです。最初の 1 件だけを差し替え、2 件目はそのまま残すことを確認します。')
    const config = withRepositories([
      { owner: 'o', name: 'dup', develop_branch: 'first' },
      { owner: 'o', name: 'other' },
      { owner: 'o', name: 'dup', develop_branch: 'second' },
    ])
    const edited = withRepositories([{ owner: 'o', name: 'dup', develop_branch: 'edited' }]).repositories[0]
    expect(edited).toBeDefined()
    if (edited === undefined) return
    const updated = withRepositoryReplaced(config, edited)
    expect(updated.repositories.map(repository => repository.develop_branch)).toEqual(['edited', undefined, 'second'])
  })

  it('parsePackage は、名前の形が不正な場合は、表題が Package の ValidationFailure を投げる', async () => {
    await explains('パッケージを読み取る関数（`parsePackage`）のテストです。正しい名前はそのまま読み取り、使えない文字を含む名前の場合は、表題が `Package` の検証エラーを投げることを確認します。')
    expect(parsePackage({ name: 'good.name-1_x', changelog: 'a.md' })).toEqual({ name: 'good.name-1_x', changelog: 'a.md' })
    expect(() => parsePackage({ name: 'b!d', changelog: 'a.md' })).toThrow(/^1 validation error for Package\nname\n {2}String should match pattern '\^\[A-Za-z0-9_\.-\]\+\$'/u)
  })
})

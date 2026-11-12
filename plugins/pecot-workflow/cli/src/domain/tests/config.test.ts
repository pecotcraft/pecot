import { describe, expect, it } from 'vitest'

import { parseJson } from '../../tests/_helpers/json.js'
import { validationErrorOutput } from '../../tests/_helpers/python-output.js'
import {
  aggregationRepositoryReference,
  ConfigError,
  configuredRepositoryFullName,
  effectiveReleaseType,
  findPackage,
  findRepository,
  findRepositoryByName,
  getDevelopBranch,
  getFieldId,
  getOptionId,
  getReleaseBranch,
  isRepositoryInProject,
  MultipleConfigsError,
  parseProjectConfig,
  PRIORITIES,
  serializeProjectConfig,
  SIZES,
  WORKFLOW_STATUSES,
  parsePackage,
  withAggregationRepository,
  withRepositoryAppended,
  withRepositoryReplaced,
  workflowFieldName,
} from '../config.js'
import type { ProjectConfig, RepositoryMembership } from '../config.js'
import { InvalidValueError } from '../errors.js'
import type { JsonValue } from '../python-format.js'

function sampleConfigData(): Record<string, JsonValue> {
  return {
    host: 'ghes.example.com',
    owner: 'test-owner',
    workflow_suffix: 'test',
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
  it('ワークフローのステータスの列挙値は、backlog から archived までの 7 つを並べて返す', () => {
    expect(WORKFLOW_STATUSES).toEqual(['backlog', 'pending', 'blocked', 'ready', 'active', 'in_review', 'archived'])
  })

  it('優先度の列挙値は、high・medium・low の 3 つを並べて返す', () => {
    expect(PRIORITIES).toEqual(['high', 'medium', 'low'])
  })

  it('サイズの列挙値は、xs から l までの 4 つを並べて返す', () => {
    expect(SIZES).toEqual(['xs', 's', 'm', 'l'])
  })
})

describe('parseProjectConfig（モデルの値）', () => {
  it('辞書から読める', () => {
    const config = sampleConfig()
    expect(config.host).toBe('ghes.example.com')
    expect(config.owner).toBe('test-owner')
    expect(config.project.number).toBe(1)
    expect(config.repositories).toHaveLength(2)
  })

  it('workflow だけのフィールド定義。priority・size は undefined', () => {
    const config = parseProjectConfig({
      host: 'github.com',
      owner: 'test',
      workflow_suffix: 'test',
      project: { number: 1, id: 'PVT', fields: { workflow: { id: 'WF', options: {} } } },
    })
    expect(config.project.fields.workflow).toEqual({ id: 'WF', options: {} })
    expect(config.project.fields.priority).toBeUndefined()
    expect(config.project.fields.size).toBeUndefined()
    expect(config.project.board_url).toBeUndefined()
    expect(config.repositories).toEqual([])
  })

  it('null の任意項目は undefined になる', () => {
    const config = withRepositories([{ owner: 'a', name: 'b', develop_branch: parseJson('null'), release_branch: parseJson('null'), packages: parseJson('null') }])
    expect(config.repositories[0]).toEqual({ owner: 'a', name: 'b' })
  })

  it('release_branch・changelog_file・packages を指定すると値を読み取り、指定しないと packages は undefined になる', () => {
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

  it('未知のキーは落とす（Python の既定と同じ）', () => {
    const config = parseProjectConfig({ ...sampleConfigData(), extra: 1 })
    expect(Object.keys(config)).not.toContain('extra')
  })

  it('読んだ値は読み取り専用（凍結）', () => {
    const config = sampleConfig()
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.repositories)).toBe(true)
  })
})

describe('parseProjectConfig（検証エラー）', () => {
  it('workflow_suffix が無いと検証エラー', () => {
    const data = sampleConfigData()
    Reflect.deleteProperty(data, 'workflow_suffix')
    expect(() => parseProjectConfig(data)).toThrow(InvalidValueError)
    // 入力が 50 文字を超えるので、input_value は前 25 文字 + ... + 後ろ 24 文字（Python の実出力と同じ切り方）
    expect(validationMessage(data)).toBe([
      '1 validation error for ProjectConfig',
      'workflow_suffix',
      '  Field required [type=missing, input_value={\'host\': \'ghes.example.co...name\': \'another-repo\'}]}, input_type=dict]',
      '    For further information visit https://errors.pydantic.dev/2.14/v/missing',
    ].join('\n'))
  })

  it.each(['config-exclusive', 'config-aggregation-single-segment', 'config-nine-errors'])('文は Python の実出力と同じ: %s', (id) => {
    const { input, message } = validationErrorOutput(id)
    expect(validationMessage(input)).toBe(message)
  })

  it('整数でない number: 小数・リスト・文字列の数', () => {
    const base = sampleConfigData()
    const project = parseJson('{"number": 1.5, "id": "a", "fields": {"workflow": {"id": "x", "options": {}}}}')
    const message = validationMessage({ ...base, project, repositories: 'no' })
    expect(message).toContain('2 validation errors for ProjectConfig\nproject.number\n  Input should be a valid integer, got a number with a fractional part [type=int_from_float, input_value=1.5, input_type=float]')
    expect(message).toContain('repositories\n  Input should be a valid list [type=list_type, input_value=\'no\', input_type=str]')
  })

  it('オブジェクトでない入力は model_type', () => {
    expect(validationMessage([1, 2, 3])).toBe([
      '1 validation error for ProjectConfig',
      '  Input should be a valid dictionary or instance of ProjectConfig [type=model_type, input_value=[1, 2, 3], input_type=list]',
      '    For further information visit https://errors.pydantic.dev/2.14/v/model_type',
    ].join('\n'))
  })

  it('入力値の repr は 50 文字を超えると切る（Python の実出力）', () => {
    expect(validationMessage({ host: 'h'.repeat(75) })).toContain('input_value={\'host\': \'hhhhhhhhhhhhhhh...hhhhhhhhhhhhhhhhhhhhhh\'}, input_type=dict]')
  })

  it('options が辞書でなければ dict_type', () => {
    const data = sampleConfigData()
    const project = parseJson('{"number": 1, "id": "a", "fields": {"workflow": {"id": "x", "options": [1]}}}')
    expect(validationMessage({ ...data, project })).toContain('project.fields.workflow.options\n  Input should be a valid dictionary [type=dict_type, input_value=[1], input_type=list]')
  })

  it('配列の要素がオブジェクトでなければ model_type（クラス名つき）', () => {
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
  ])('%s は %d', (json, expected) => {
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
  ])('%s は %s', (json, type, text) => {
    const project = { number: parseJson(json), id: 'a', fields: { workflow: { id: 'x', options: {} } } }
    expect(validationMessage({ ...sampleConfigData(), project })).toContain(`${text} [type=${type}, `)
  })
})

function aggregationData(extra: Readonly<Record<string, JsonValue>>): JsonValue {
  return {
    host: 'github.com',
    owner: 'acme-labs',
    workflow_suffix: 'pecot',
    project: { number: 1, id: 'PVT_xxx', fields: { workflow: { id: 'F_workflow', options: { backlog: 'o1', active: 'o2' } } } },
    repositories: [],
    ...extra,
  }
}

describe('aggregation_repo', () => {
  it('未指定は undefined', () => {
    expect(parseProjectConfig(aggregationData({})).aggregation_repo).toBeUndefined()
  })

  it('null も undefined', () => {
    const config = parseProjectConfig(aggregationData({ aggregation_repo: parseJson('null') }))
    expect(config.aggregation_repo).toBeUndefined()
  })

  it('owner/repo 形式は通る', () => {
    expect(parseProjectConfig(aggregationData({ aggregation_repo: 'a/b' })).aggregation_repo).toBe('a/b')
  })

  it.each(['a', 'owner/repo/extra', ''])('%j は検証エラー', (value) => {
    expect(() => parseProjectConfig(aggregationData({ aggregation_repo: value }))).toThrow(InvalidValueError)
    expect(() => parseProjectConfig(aggregationData({ aggregation_repo: value }))).toThrow('aggregation_repo must be in \'owner/repo\' form')
  })

  it('配列は検証エラー（文字列でない）', () => {
    expect(() => parseProjectConfig(aggregationData({ aggregation_repo: ['a/b'] }))).toThrow('Input should be a valid string')
  })
})

describe('フィールドの検索', () => {
  const config = sampleConfig()

  it('フィールド名から ID を引き、無い名前には undefined を返す', () => {
    expect(getFieldId(config, 'workflow')).toBe('FIELD_workflow')
    expect(getFieldId(config, 'priority')).toBe('FIELD_priority')
    expect(getFieldId(config, 'size')).toBe('FIELD_size')
    expect(getFieldId(config, 'nonexistent')).toBeUndefined()
  })

  it('フィールド名と選択肢名から選択肢の ID を引き、無い組には undefined を返す', () => {
    expect(getOptionId(config, 'workflow', 'active')).toBe('opt_active')
    expect(getOptionId(config, 'priority', 'high')).toBe('opt_high')
    expect(getOptionId(config, 'workflow', 'nonexistent')).toBeUndefined()
    expect(getOptionId(config, 'nonexistent', 'active')).toBeUndefined()
  })

  it('priority が無い設定では、priority のフィールドの ID は undefined を返す', () => {
    const noPriority = parseProjectConfig({ ...sampleConfigData(), project: { number: 1, id: 'a', fields: { workflow: { id: 'x', options: {} } } } })
    expect(getFieldId(noPriority, 'priority')).toBeUndefined()
  })

  it('設定の workflow のフィールドから、その名前を返す', () => {
    expect(workflowFieldName(config)).toBe('pecot-workflow-test')
  })
})

describe('リポジトリの検索', () => {
  const config = sampleConfig()

  it('owner と名前からリポジトリを探し、無ければ undefined を返す', () => {
    expect(findRepository(config, 'test-owner', 'test-repo')?.name).toBe('test-repo')
    expect(findRepository(config, 'test-owner', 'nonexistent')).toBeUndefined()
  })

  it('名前だけでリポジトリを探し、無ければ undefined を返す', () => {
    expect(findRepositoryByName(config, 'test-repo')?.owner).toBe('test-owner')
    expect(findRepositoryByName(config, 'nonexistent')).toBeUndefined()
  })

  it('リポジトリの develop ブランチを返し、未設定や無いリポジトリには undefined を返す', () => {
    expect(getDevelopBranch(config, 'test-owner', 'test-repo')).toBe('develop')
    expect(getDevelopBranch(config, 'test-owner', 'another-repo')).toBeUndefined()
    expect(getDevelopBranch(config, 'test-owner', 'nonexistent')).toBeUndefined()
  })

  it('リポジトリの release ブランチを返し、未設定や無いリポジトリには undefined を返す', () => {
    const withRelease = withRepositories([{ owner: 'test-owner', name: 'test-repo', develop_branch: 'develop', release_branch: 'main' }, { owner: 'test-owner', name: 'another-repo' }])
    expect(getReleaseBranch(withRelease, 'test-owner', 'test-repo')).toBe('main')
    expect(getReleaseBranch(withRelease, 'test-owner', 'another-repo')).toBeUndefined()
    expect(getReleaseBranch(withRelease, 'test-owner', 'nonexistent')).toBeUndefined()
  })

  it('リポジトリの設定から、owner/name の形の名前を返す', () => {
    const [first] = config.repositories
    expect(first && configuredRepositoryFullName(first)).toBe('test-owner/test-repo')
  })

  it('名前からリポジトリ内のパッケージを探し、無い名前やパッケージの無いリポジトリには undefined を返す', () => {
    const monorepo = withRepositories([{ owner: 'o', name: 'r', packages: [{ name: 'pecot', changelog: 'plugins/pecot-workflow/CHANGELOG.md' }] }, { owner: 'o', name: 'plain' }])
    const [repository, plain] = monorepo.repositories
    expect(repository && findPackage(repository, 'pecot')?.changelog).toBe('plugins/pecot-workflow/CHANGELOG.md')
    expect(repository && findPackage(repository, 'unknown')).toBeUndefined()
    expect(plain && findPackage(plain, 'pecot')).toBeUndefined()
  })

  it('effectiveReleaseType は明示値、無ければ packages の有無', () => {
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

  it('リンクされていれば true、いなければ false', async () => {
    const source = membership([{ owner: 'test-owner', name: 'test-repo' }, { owner: 'test-owner', name: 'another-repo' }])
    await expect(isRepositoryInProject(config, 'test-owner', 'test-repo', source)).resolves.toBe(true)
    await expect(isRepositoryInProject(config, 'test-owner', 'nonexistent', source)).resolves.toBe(false)
  })

  it('問い合わせはプロジェクトの owner と番号で行う', async () => {
    const source = membership([])
    await isRepositoryInProject(config, 'x', 'y', source)
    expect(source.calls).toEqual([['test-owner', 1]])
  })
})

describe('ConfigError / MultipleConfigsError', () => {
  it('ConfigError はメッセージを持つ', () => {
    expect(() => {
      throw new ConfigError('テストエラー')
    }).toThrow('テストエラー')
  })

  it('MultipleConfigsError の文にファイル名が含まれる（Python のリスト表記）', () => {
    const error = new MultipleConfigsError(['/tmp/config1.json', '/tmp/config2.json'])
    expect(error.message).toBe('multiple config files found: [\'config1.json\', \'config2.json\']')
    expect(error.files).toEqual(['/tmp/config1.json', '/tmp/config2.json'])
    expect(error).toBeInstanceOf(ConfigError)
  })
})

describe('serializeProjectConfig', () => {
  it('2 スペースのインデントと末尾改行。None に当たる項目は出さない', () => {
    const config = parseProjectConfig({
      host: 'github.com',
      owner: 'test',
      workflow_suffix: 'test',
      project: { number: 1, id: 'PVT', fields: { workflow: { id: 'WF', options: {} } } },
    })
    expect(serializeProjectConfig(config)).toBe([
      '{',
      '  "host": "github.com",',
      '  "owner": "test",',
      '  "workflow_suffix": "test",',
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

  it('キー順はモデルの定義順。入力の順に依らない', () => {
    const config = parseProjectConfig({
      repositories: [{ release_branch: 'main', name: 'r', owner: 'o' }],
      project: { fields: { workflow: { options: {}, id: 'WF' } }, id: 'PVT', number: 1 },
      workflow_suffix: 's',
      owner: 'o',
      host: 'h',
      aggregation_repo: 'a/b',
    })
    const keys = Object.keys(parseJsonObject(serializeProjectConfig(config)))
    expect(keys).toEqual(['host', 'owner', 'workflow_suffix', 'project', 'repositories', 'aggregation_repo'])
    expect(serializeProjectConfig(config)).toContain('"owner": "o",\n      "name": "r",\n      "release_branch": "main"')
  })

  it('日本語は \\u エスケープしない（ensure_ascii=False）', () => {
    const config = withRepositories([{ owner: 'o', name: 'r', develop_branch: '開発' }])
    expect(serializeProjectConfig(config)).toContain('"develop_branch": "開発"')
  })

  it('保存した内容を読み直すと同じ設定になる', () => {
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
  it('未設定なら undefined、あれば owner/repo の参照', () => {
    expect(aggregationRepositoryReference(sampleConfig())).toBeUndefined()
    const config = parseProjectConfig({ ...sampleConfigData(), aggregation_repo: 'a/b' })
    expect(aggregationRepositoryReference(config)).toEqual({ owner: 'a', repository: 'b' })
  })
})

describe('更新（コピーを作る）', () => {
  it('withAggregationRepository は値を差し替えたコピーを返し、元は変えない', () => {
    const config = sampleConfig()
    const updated = withAggregationRepository(config, 'a/b')
    expect(updated.aggregation_repo).toBe('a/b')
    expect(config.aggregation_repo).toBeUndefined()
    expect(Object.isFrozen(updated)).toBe(true)
  })

  it('withAggregationRepository に undefined を渡すと外れ、保存の内容に出ない', () => {
    const config = withAggregationRepository(parseProjectConfig({ ...sampleConfigData(), aggregation_repo: 'a/b' }), undefined)
    expect(config.aggregation_repo).toBeUndefined()
    expect(serializeProjectConfig(config)).not.toContain('aggregation_repo')
  })

  it('保存の内容で aggregation_repo はキーの末尾（モデルの定義順）', () => {
    const text = serializeProjectConfig(withAggregationRepository(sampleConfig(), 'a/b'))
    expect(Object.keys(parseJsonObject(text)).at(-1)).toBe('aggregation_repo')
  })

  it('withRepositoryAppended は末尾に足したコピーを返し、元は変えない', () => {
    const config = sampleConfig()
    const extra = withRepositories([{ owner: 'o', name: 'new' }]).repositories[0]
    expect(extra).toBeDefined()
    if (extra === undefined) return
    const updated = withRepositoryAppended(config, extra)
    expect(updated.repositories.map(repository => repository.name)).toEqual(['test-repo', 'another-repo', 'new'])
    expect(config.repositories).toHaveLength(2)
    expect(Object.isFrozen(updated.repositories)).toBe(true)
  })

  it('withRepositoryReplaced は同じ owner と name の 1 件を差し替えたコピーを返し、元は変えない', () => {
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

  it('withRepositoryReplaced は同じリポジトリが無いと、元と同じ並びを返す', () => {
    const config = sampleConfig()
    const other = withRepositories([{ owner: 'o', name: 'absent' }]).repositories[0]
    expect(other).toBeDefined()
    if (other === undefined) return
    expect(withRepositoryReplaced(config, other).repositories.map(repository => repository.name)).toEqual(['test-repo', 'another-repo'])
  })

  it('withRepositoryReplaced は同じ owner と name が重複していても、最初の 1 件だけを差し替える', () => {
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

  it('parsePackage は NAME の形が不正だと、表題が Package の ValidationFailure を投げる', () => {
    expect(parsePackage({ name: 'good.name-1_x', changelog: 'a.md' })).toEqual({ name: 'good.name-1_x', changelog: 'a.md' })
    expect(() => parsePackage({ name: 'b!d', changelog: 'a.md' })).toThrow(/^1 validation error for Package\nname\n {2}String should match pattern '\^\[A-Za-z0-9_\.-\]\+\$'/u)
  })
})

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ConfigError, parseProjectConfig, serializeProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import type { JsonValue } from '../../domain/python-format.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import {
  configDirectory,
  configSourcePath,
  findConfigFor,
  findConfigsForRepository,
  getActiveConfigPath,
  listProjectConfigEntries,
  loadActiveConfig,
  loadConfig,
  loadNamedConfig,
  projectsDirectory,
  removeConfig,
  saveConfig,
  setActiveConfig,
} from '../config-store.js'
import { explains } from '../../../tests/_helpers/explains.js'

useIsolatedEnvironment()

function sampleData(): Record<string, JsonValue> {
  return {
    host: 'ghes.example.com',
    owner: 'test-owner',
    workflow_suffix: 'test',
    project: {
      number: 1,
      id: 'PVT_test123',
      fields: { workflow: { id: 'FIELD_workflow', options: { active: 'opt_active' } } },
    },
    repositories: [
      { owner: 'test-owner', name: 'test-repo', develop_branch: 'develop', release_branch: 'main' },
      { owner: 'test-owner', name: 'another-repo' },
    ],
  }
}

function sampleConfig(): ProjectConfig {
  return parseProjectConfig(sampleData())
}

/**
一時のプロジェクトルートを作り、CLAUDE_PROJECT_DIR に向ける
*/
function useProject(): { readonly root: string, readonly projects: string } {
  const root = makeTemporaryDirectory()
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  const projects = path.join(root, '.pecot', 'config', 'projects')
  mkdirSync(projects, { recursive: true })
  return { root, projects }
}

describe('ディレクトリ', () => {
  it('設定ディレクトリは .pecot/config、プロジェクト設定ディレクトリはその下の projects を返す', async () => {
    await explains('プロジェクトの設定の置き場所（`configDirectory`・`projectsDirectory`）のテストです。`CLAUDE_PROJECT_DIR` を指定した場合に、`.pecot/config` とその下の `projects` のパスを返すことを確認します。')
    const { root } = useProject()
    expect(configDirectory()).toBe(path.join(root, '.pecot', 'config'))
    expect(projectsDirectory()).toBe(path.join(root, '.pecot', 'config', 'projects'))
  })
})

describe('loadConfig', () => {
  it('有効な設定ファイルを読み込むと、設定の内容を返す', async () => {
    await explains('設定ファイルを読み込む `loadConfig` のテストです。有効な JSON の場合に、`host` や `owner` などの値を持つ設定を返すことを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'test.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    const config = loadConfig(file)
    expect(config.host).toBe('ghes.example.com')
    expect(config.owner).toBe('test-owner')
  })

  it('存在しないファイルを読み込むと、ConfigError を発生させる', async () => {
    await explains('`loadConfig` のテストです。存在しないファイルを指定した場合に、`config file not found` を含む `ConfigError` が発生することを確認します。')
    const { projects } = useProject()
    expect(() => loadConfig(path.join(projects, 'nonexistent.json'))).toThrow(ConfigError)
    expect(() => loadConfig(path.join(projects, 'nonexistent.json'))).toThrow('config file not found')
  })

  it('JSON として不正なファイルを読み込むと、invalid config file の ConfigError を発生させる', async () => {
    await explains('`loadConfig` のテストです。JSON として解釈できないファイルの場合に、`invalid config file` とファイルのパスを含む `ConfigError` が発生することを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'invalid.json')
    writeFileSync(file, 'not valid json')
    expect(() => loadConfig(file)).toThrow(ConfigError)
    expect(() => loadConfig(file)).toThrow(`invalid config file: ${file}: `)
  })

  it('必須の項目が不足している設定ファイルを読み込むと、不足している項目を含む ConfigError を発生させる', async () => {
    await explains('`loadConfig` のテストです。必須の項目が存在しない設定ファイルの場合に、`host` や `owner` などの項目ごとのエラーを `;` でつないだ `ConfigError` が発生することを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'bad.json')
    writeFileSync(file, '{}')
    expect(() => loadConfig(file)).toThrow(ConfigError)
    expect(() => loadConfig(file)).toThrow(`invalid config file: ${file}: host: Field required; owner: Field required;`)
  })
})

describe('saveConfig', () => {
  it('設定を保存すると、シリアライズした内容のファイルを作成する', async () => {
    await explains('設定を保存する `saveConfig` のテストです。保存したファイルの内容が、`serializeProjectConfig` の出力と一致することを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'output.json')
    saveConfig(sampleConfig(), file)
    expect(readFileSync(file, 'utf8')).toBe(serializeProjectConfig(sampleConfig()))
  })

  it('保存先の親ディレクトリが存在しない場合は、作成してから保存する', async () => {
    await explains('`saveConfig` のテストです。親ディレクトリが存在しないパスを指定した場合に、ディレクトリを作成してファイルが保存されることを確認します。')
    const { root } = useProject()
    const file = path.join(root, 'subdir', 'output.json')
    saveConfig(sampleConfig(), file)
    expect(existsSync(file)).toBe(true)
  })

  it('release_branch を含む設定を保存すると、読み込み直しても値が保持される', async () => {
    await explains('`saveConfig` と `loadConfig` のテストです。保存した設定を読み込み直した場合に、リポジトリの `release_branch` の値が `main` のまま保持されることを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'output.json')
    saveConfig(sampleConfig(), file)
    expect(loadConfig(file).repositories[0]?.release_branch).toBe('main')
  })

  it('値を持たない項目は、保存したファイルに含めない', async () => {
    await explains('`saveConfig` のテストです。値を設定していない `priority` や `board_url` が、保存したファイルに含まれないことを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'output.json')
    saveConfig(sampleConfig(), file)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('priority')
    expect(text).not.toContain('board_url')
  })
})

describe('アクティブ設定', () => {
  it('.active が存在しない場合は、アクティブな設定のパスを返さない', async () => {
    await explains('アクティブな設定のパスを取得する `getActiveConfigPath` のテストです。`.active` ファイルが存在しない場合に、`undefined` を返すことを確認します。')
    useProject()
    expect(getActiveConfigPath()).toBeUndefined()
  })

  it('.active に絶対パスが書かれている場合は、そのパスを返す', async () => {
    await explains('`getActiveConfigPath` のテストです。`.active` に設定ファイルの絶対パスが書かれている場合に、そのパスを返すことを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), file)
    expect(getActiveConfigPath()).toBe(file)
  })

  it('.active に相対パスが書かれている場合は、.active のあるディレクトリを基準に解決する', async () => {
    await explains('`getActiveConfigPath` のテストです。`.active` に相対パスが書かれている場合に、`.active` のあるディレクトリを基準に解決した絶対パスを返すことを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), 'config.json\n')
    expect(getActiveConfigPath()).toBe(file)
  })

  it('.active が空の場合は、アクティブな設定のパスを返さない', async () => {
    await explains('`getActiveConfigPath` のテストです。`.active` が空白と改行だけの場合に、`undefined` を返すことを確認します。')
    const { projects } = useProject()
    writeFileSync(path.join(projects, '.active'), ' \n')
    expect(getActiveConfigPath()).toBeUndefined()
  })

  it('.active の指す先が存在しない場合は、アクティブな設定のパスを返さない', async () => {
    await explains('`getActiveConfigPath` のテストです。`.active` が存在しないファイルを指している場合に、`undefined` を返すことを確認します。')
    const { projects } = useProject()
    writeFileSync(path.join(projects, '.active'), '/nonexistent/path.json')
    expect(getActiveConfigPath()).toBeUndefined()
  })

  it('アクティブな設定が存在する場合は、その設定を読み込んで返す', async () => {
    await explains('アクティブな設定を読み込む `loadActiveConfig` のテストです。`.active` が有効な設定ファイルを指している場合に、その設定の `host` を持つ設定を返すことを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), file)
    expect(loadActiveConfig()?.host).toBe('ghes.example.com')
  })

  it('アクティブな設定が存在しない場合は、undefined を返す', async () => {
    await explains('`loadActiveConfig` のテストです。`.active` が存在しない場合に、`undefined` を返すことを確認します。')
    useProject()
    expect(loadActiveConfig()).toBeUndefined()
  })

  it('アクティブな設定を指定すると、.active に相対パスを書き込む', async () => {
    await explains('アクティブな設定を指定する `setActiveConfig` のテストです。設定ファイルのパスを指定した場合に、`.active` に相対パス（`config.json`）が書き込まれ、`getActiveConfigPath` が同じファイルを返すことを確認します。')
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    setActiveConfig(file)
    expect(readFileSync(path.join(projects, '.active'), 'utf8')).toBe('config.json\n')
    expect(getActiveConfigPath()).toBe(file)
  })

  it('projects ディレクトリが存在しない場合は、作成してから .active を書き込む', async () => {
    await explains('`setActiveConfig` のテストです。`projects` ディレクトリが存在しない場合に、ディレクトリを作成し、`.active` に外部ファイルへの相対パスが書き込まれることを確認します。')
    const root = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: root })
    const file = path.join(root, 'elsewhere.json')
    writeFileSync(file, '{}')
    setActiveConfig(file)
    expect(readFileSync(path.join(root, '.pecot', 'config', 'projects', '.active'), 'utf8')).toBe('../../../elsewhere.json\n')
  })

  it('存在しないファイルをアクティブな設定に指定すると、ConfigError を発生させる', async () => {
    await explains('`setActiveConfig` のテストです。存在しないファイルを指定した場合に、`config file not found` を含む `ConfigError` が発生することを確認します。')
    const { projects } = useProject()
    expect(() => {
      setActiveConfig(path.join(projects, 'nonexistent.json'))
    }).toThrow(ConfigError)
    expect(() => {
      setActiveConfig(path.join(projects, 'nonexistent.json'))
    }).toThrow('config file not found')
  })
})

/**
projects/ に名前の設定を書く。repositories と aggregation_repo を差し替えられる
*/
function writeProject(projects: string, name: string, repositories: readonly string[], aggregation?: string): string {
  const file = path.join(projects, `${name}.json`)
  const data = {
    ...sampleData(),
    repositories: repositories.map(full => ({ owner: full.split('/', 2)[0] ?? '', name: full.split('/', 2)[1] ?? '' })),
    ...aggregation !== undefined && { aggregation_repo: aggregation },
  }
  writeFileSync(file, JSON.stringify(data))
  return file
}

const TARGET = { owner: 'acme', repository: 'app' }

describe('listProjectConfigEntries', () => {
  it('設定ファイルの名前とボードの情報を名前順に返し、読み込めないファイルは対象から外す', async () => {
    await explains('プロジェクト設定の一覧を返す `listProjectConfigEntries` のテストです。複数の設定ファイルが存在する場合に、ファイル名の順に `fileName` や `host` などを返し、不正なファイルを除外することを確認します。')
    const { projects } = useProject()
    writeProject(projects, 'b', ['acme/app'])
    writeProject(projects, 'a', ['acme/app'])
    writeFileSync(path.join(projects, 'broken.json'), '{}')
    expect(listProjectConfigEntries()).toEqual([
      { fileName: 'a.json', host: 'ghes.example.com', owner: 'test-owner', number: 1 },
      { fileName: 'b.json', host: 'ghes.example.com', owner: 'test-owner', number: 1 },
    ])
  })
})

describe('removeConfig', () => {
  it('指定した設定ファイルを削除する', async () => {
    await explains('設定ファイルを削除する `removeConfig` のテストです。指定したファイルが削除され、存在しなくなることを確認します。')
    const { projects } = useProject()
    const file = writeProject(projects, 'board', ['acme/app'])
    removeConfig(file)
    expect(existsSync(file)).toBe(false)
  })
})

describe('loadNamedConfig', () => {
  it('名前で設定を読み込み、.json は省略でき、存在しない名前は undefined を返す', async () => {
    await explains('名前を指定して設定を読み込む `loadNamedConfig` のテストです。`board` と `board.json` のどちらでも同じ設定を返し、存在しない名前の場合に `undefined` を返すことを確認します。')
    const { projects } = useProject()
    writeProject(projects, 'board', ['acme/app'])
    expect(loadNamedConfig('board')?.name).toBe('board')
    expect(loadNamedConfig('board.json')?.name).toBe('board')
    expect(loadNamedConfig('missing')).toBeUndefined()
  })
})

describe('findConfigsForRepository', () => {
  it('対象のリポジトリを含む設定だけを、名前順に返す', async () => {
    await explains('リポジトリを含む設定を探す `findConfigsForRepository` のテストです。対象のリポジトリを含む設定だけが、名前の順に返されることを確認します。')
    const { projects } = useProject()
    writeProject(projects, 'b', ['acme/app'])
    writeProject(projects, 'a', ['acme/app', 'acme/lib'])
    writeProject(projects, 'c', ['acme/lib'])
    expect(findConfigsForRepository(TARGET).map(found => found.name)).toEqual(['a', 'b'])
  })

  it('repositories に存在しなくても、aggregation_repo が一致する場合は含める', async () => {
    await explains('`findConfigsForRepository` のテストです。`repositories` に存在せず `aggregation_repo` だけが対象と一致する設定も、結果に含まれることを確認します。')
    const { projects } = useProject()
    writeProject(projects, 'board', ['acme/lib'], 'acme/app')
    expect(findConfigsForRepository(TARGET).map(found => found.name)).toEqual(['board'])
  })

  it('.active が projects/ の外の設定を指す場合は、候補に含め、名前をパスにする', async () => {
    await explains('`findConfigsForRepository` のテストです。`.active` が `projects` ディレクトリの外の設定を指している場合に、その設定が候補に含まれ、名前が実パスになることを確認します。')
    const { root, projects } = useProject()
    const outside = writeProject(root, 'outside', ['acme/app'])
    writeFileSync(path.join(projects, '.active'), outside)
    const [found] = findConfigsForRepository(TARGET)
    expect(found?.path).toBe(realpathSync(outside))
    expect(found?.name).toBe(realpathSync(outside))
  })

  it('不正な形式の設定を含む場合は、対象と無関係でも、パスを含む ConfigError を発生させる', async () => {
    await explains('`findConfigsForRepository` のテストです。不正な形式の設定ファイルが存在する場合に、そのパスを含む `ConfigError` を発生させることを確認します。')
    const { projects } = useProject()
    writeProject(projects, 'good', ['acme/app'])
    writeFileSync(path.join(projects, 'broken.json'), '{}')
    expect(() => findConfigsForRepository(TARGET)).toThrow(ConfigError)
    expect(() => findConfigsForRepository(TARGET)).toThrow(path.join(projects, 'broken.json'))
  })
})

describe('findConfigFor', () => {
  it('候補が 1 つの場合はその設定を返し、0 個の場合は none を返す', async () => {
    await explains('リポジトリに対応する設定を選ぶ `findConfigFor` のテストです。候補が 1 つの場合に `found` を返し、0 個の場合に `none` を返すことを確認します。')
    const { projects } = useProject()
    writeProject(projects, 'board', ['acme/app'])
    expect(findConfigFor(TARGET)).toMatchObject({ kind: 'found', found: { name: 'board' } })
    expect(findConfigFor({ owner: 'acme', repository: 'other' })).toEqual({ kind: 'none' })
  })

  it('候補が 2 つ以上の場合は、.active の指す候補を使い、指していなければ ambiguous を返す', async () => {
    await explains('`findConfigFor` のテストです。候補が 2 つ以上で `.active` を設定していない場合は `ambiguous` を返し、`.active` で候補の 1 つを指定した場合は、その設定を `found` として返すことを確認します。')
    const { projects } = useProject()
    writeProject(projects, 'a', ['acme/app'])
    const second = writeProject(projects, 'b', ['acme/app'])
    expect(findConfigFor(TARGET)).toMatchObject({ kind: 'ambiguous', candidates: [{ name: 'a' }, { name: 'b' }] })
    writeFileSync(path.join(projects, '.active'), second)
    expect(findConfigFor(TARGET)).toMatchObject({ kind: 'found', found: { name: 'b' } })
  })

  it('project を指定した場合は、その名前の設定を使い、存在しない名前と対象を含まない設定を区別する', async () => {
    await explains('`findConfigFor` のテストです。`project` を指定した場合に、設定が存在すれば `found`、名前が存在しなければ `unknown-project`、対象を含まなければ `not-in-project` を返すことを確認します。')
    const { projects } = useProject()
    writeProject(projects, 'a', ['acme/app'])
    writeProject(projects, 'b', ['acme/app'])
    writeProject(projects, 'c', ['acme/lib'])
    expect(findConfigFor(TARGET, 'b')).toMatchObject({ kind: 'found', found: { name: 'b' } })
    expect(findConfigFor(TARGET, 'missing')).toEqual({ kind: 'unknown-project', project: 'missing' })
    expect(findConfigFor(TARGET, '')).toEqual({ kind: 'unknown-project', project: '' })
    expect(findConfigFor(TARGET, 'c')).toMatchObject({ kind: 'not-in-project', found: { name: 'c' } })
  })
})

describe('configSourcePath', () => {
  it('loadConfig で読み込んだ設定は、元のファイルの実パスを返す', async () => {
    await explains('設定の読み込み元を返す `configSourcePath` のテストです。`loadConfig` で読み込んだ設定の場合に実パスを返し、メモリ上で作成した設定の場合に `undefined` を返すことを確認します。')
    const { projects } = useProject()
    const file = writeProject(projects, 'board', ['acme/app'])
    expect(configSourcePath(loadConfig(file))).toBe(realpathSync(file))
    expect(configSourcePath(sampleConfig())).toBeUndefined()
  })
})

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
import { stepSync } from '../../../tests/_helpers/step.js'

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
    const { root } = stepSync('プロジェクトを用意する', () => useProject())
    const directories = stepSync('置き場所を求める', () => ({ config: configDirectory(), projects: projectsDirectory() }))
    stepSync('置き場所を比べる', () => {
      expect(directories.config).toBe(path.join(root, '.pecot', 'config'))
      expect(directories.projects).toBe(path.join(root, '.pecot', 'config', 'projects'))
    })
  })
})

describe('loadConfig', () => {
  it('有効な設定ファイルを読み込むと、設定の内容を返す', async () => {
    await explains('設定ファイルを読み込む `loadConfig` のテストです。有効な JSON の場合に、`host` や `owner` などの値を持つ設定を返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'test.json')
    stepSync('設定ファイルを置く', () => {
      writeFileSync(file, JSON.stringify(sampleData()))
    })
    const config = stepSync('設定を読み込む', () => loadConfig(file))
    stepSync('設定の内容を比べる', () => {
      expect(config.host).toBe('ghes.example.com')
      expect(config.owner).toBe('test-owner')
    })
  })

  it('存在しないファイルを読み込むと、ConfigError を発生させる', async () => {
    await explains('`loadConfig` のテストです。存在しないファイルを指定した場合に、`config file not found` を含む `ConfigError` が発生することを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('エラーの種類とメッセージを確かめる', () => {
      expect(() => loadConfig(path.join(projects, 'nonexistent.json'))).toThrow(ConfigError)
      expect(() => loadConfig(path.join(projects, 'nonexistent.json'))).toThrow('config file not found')
    })
  })

  it('JSON として不正なファイルを読み込むと、invalid config file の ConfigError を発生させる', async () => {
    await explains('`loadConfig` のテストです。JSON として解釈できないファイルの場合に、`invalid config file` とファイルのパスを含む `ConfigError` が発生することを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'invalid.json')
    stepSync('不正な JSON のファイルを置く', () => {
      writeFileSync(file, 'not valid json')
    })
    stepSync('エラーの種類とメッセージを確かめる', () => {
      expect(() => loadConfig(file)).toThrow(ConfigError)
      expect(() => loadConfig(file)).toThrow(`invalid config file: ${file}: `)
    })
  })

  it('必須の項目が不足している設定ファイルを読み込むと、不足している項目を含む ConfigError を発生させる', async () => {
    await explains('`loadConfig` のテストです。必須の項目が存在しない設定ファイルの場合に、`host` や `owner` などの項目ごとのエラーを `;` でつないだ `ConfigError` が発生することを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'bad.json')
    stepSync('項目の無い設定ファイルを置く', () => {
      writeFileSync(file, '{}')
    })
    stepSync('エラーの種類とメッセージを確かめる', () => {
      expect(() => loadConfig(file)).toThrow(ConfigError)
      expect(() => loadConfig(file)).toThrow(`invalid config file: ${file}: host: Field required; owner: Field required;`)
    })
  })
})

describe('saveConfig', () => {
  it('設定を保存すると、シリアライズした内容のファイルを作成する', async () => {
    await explains('設定を保存する `saveConfig` のテストです。保存したファイルの内容が、`serializeProjectConfig` の出力と一致することを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'output.json')
    stepSync('設定を保存する', () => {
      saveConfig(sampleConfig(), file)
    })
    stepSync('保存した内容を比べる', () => {
      expect(readFileSync(file, 'utf8')).toBe(serializeProjectConfig(sampleConfig()))
    })
  })

  it('保存先の親ディレクトリが存在しない場合は、作成してから保存する', async () => {
    await explains('`saveConfig` のテストです。親ディレクトリが存在しないパスを指定した場合に、ディレクトリを作成してファイルが保存されることを確認します。')
    const { root } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(root, 'subdir', 'output.json')
    stepSync('親ディレクトリの無い場所へ設定を保存する', () => {
      saveConfig(sampleConfig(), file)
    })
    stepSync('ファイルが作られたことを確かめる', () => {
      expect(existsSync(file)).toBe(true)
    })
  })

  it('release_branch を含む設定を保存すると、読み込み直しても値が保持される', async () => {
    await explains('`saveConfig` と `loadConfig` のテストです。保存した設定を読み込み直した場合に、リポジトリの `release_branch` の値が `main` のまま保持されることを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'output.json')
    stepSync('設定を保存する', () => {
      saveConfig(sampleConfig(), file)
    })
    const loaded = stepSync('保存した設定を読み込み直す', () => loadConfig(file))
    stepSync('release_branch を比べる', () => {
      expect(loaded.repositories[0]?.release_branch).toBe('main')
    })
  })

  it('値を持たない項目は、保存したファイルに含めない', async () => {
    await explains('`saveConfig` のテストです。値を設定していない `priority` や `board_url` が、保存したファイルに含まれないことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'output.json')
    stepSync('設定を保存する', () => {
      saveConfig(sampleConfig(), file)
    })
    const text = stepSync('保存したファイルを読む', () => readFileSync(file, 'utf8'))
    stepSync('値の無い項目が含まれないことを確かめる', () => {
      expect(text).not.toContain('priority')
      expect(text).not.toContain('board_url')
    })
  })
})

describe('アクティブ設定', () => {
  it('.active が存在しない場合は、アクティブな設定のパスを返さない', async () => {
    await explains('アクティブな設定のパスを取得する `getActiveConfigPath` のテストです。`.active` ファイルが存在しない場合に、`undefined` を返すことを確認します。')
    stepSync('プロジェクトを用意する', () => {
      useProject()
    })
    const active = stepSync('アクティブな設定のパスを求める', () => getActiveConfigPath())
    stepSync('パスが無いことを確かめる', () => {
      expect(active).toBeUndefined()
    })
  })

  it('.active に絶対パスが書かれている場合は、そのパスを返す', async () => {
    await explains('`getActiveConfigPath` のテストです。`.active` に設定ファイルの絶対パスが書かれている場合に、そのパスを返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'config.json')
    stepSync('設定ファイルと .active を置く', () => {
      writeFileSync(file, JSON.stringify(sampleData()))
      writeFileSync(path.join(projects, '.active'), file)
    })
    const active = stepSync('アクティブな設定のパスを求める', () => getActiveConfigPath())
    stepSync('パスを比べる', () => {
      expect(active).toBe(file)
    })
  })

  it('.active に相対パスが書かれている場合は、.active のあるディレクトリを基準に解決する', async () => {
    await explains('`getActiveConfigPath` のテストです。`.active` に相対パスが書かれている場合に、`.active` のあるディレクトリを基準に解決した絶対パスを返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'config.json')
    stepSync('設定ファイルと相対パスの .active を置く', () => {
      writeFileSync(file, JSON.stringify(sampleData()))
      writeFileSync(path.join(projects, '.active'), 'config.json\n')
    })
    const active = stepSync('アクティブな設定のパスを求める', () => getActiveConfigPath())
    stepSync('パスを比べる', () => {
      expect(active).toBe(file)
    })
  })

  it('.active が空の場合は、アクティブな設定のパスを返さない', async () => {
    await explains('`getActiveConfigPath` のテストです。`.active` が空白と改行だけの場合に、`undefined` を返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('空の .active を置く', () => {
      writeFileSync(path.join(projects, '.active'), ' \n')
    })
    const active = stepSync('アクティブな設定のパスを求める', () => getActiveConfigPath())
    stepSync('パスが無いことを確かめる', () => {
      expect(active).toBeUndefined()
    })
  })

  it('.active の指す先が存在しない場合は、アクティブな設定のパスを返さない', async () => {
    await explains('`getActiveConfigPath` のテストです。`.active` が存在しないファイルを指している場合に、`undefined` を返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('存在しないファイルを指す .active を置く', () => {
      writeFileSync(path.join(projects, '.active'), '/nonexistent/path.json')
    })
    const active = stepSync('アクティブな設定のパスを求める', () => getActiveConfigPath())
    stepSync('パスが無いことを確かめる', () => {
      expect(active).toBeUndefined()
    })
  })

  it('アクティブな設定が存在する場合は、その設定を読み込んで返す', async () => {
    await explains('アクティブな設定を読み込む `loadActiveConfig` のテストです。`.active` が有効な設定ファイルを指している場合に、その設定の `host` を持つ設定を返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'config.json')
    stepSync('設定ファイルと .active を置く', () => {
      writeFileSync(file, JSON.stringify(sampleData()))
      writeFileSync(path.join(projects, '.active'), file)
    })
    const config = stepSync('アクティブな設定を読み込む', () => loadActiveConfig())
    stepSync('host を比べる', () => {
      expect(config?.host).toBe('ghes.example.com')
    })
  })

  it('アクティブな設定が存在しない場合は、undefined を返す', async () => {
    await explains('`loadActiveConfig` のテストです。`.active` が存在しない場合に、`undefined` を返すことを確認します。')
    stepSync('プロジェクトを用意する', () => {
      useProject()
    })
    const config = stepSync('アクティブな設定を読み込む', () => loadActiveConfig())
    stepSync('設定が無いことを確かめる', () => {
      expect(config).toBeUndefined()
    })
  })

  it('アクティブな設定を指定すると、.active に相対パスを書き込む', async () => {
    await explains('アクティブな設定を指定する `setActiveConfig` のテストです。設定ファイルのパスを指定した場合に、`.active` に相対パス（`config.json`）が書き込まれ、`getActiveConfigPath` が同じファイルを返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = path.join(projects, 'config.json')
    stepSync('設定ファイルを置く', () => {
      writeFileSync(file, JSON.stringify(sampleData()))
    })
    stepSync('アクティブな設定を指定する', () => {
      setActiveConfig(file)
    })
    stepSync('.active の内容とパスを比べる', () => {
      expect(readFileSync(path.join(projects, '.active'), 'utf8')).toBe('config.json\n')
      expect(getActiveConfigPath()).toBe(file)
    })
  })

  it('projects ディレクトリが存在しない場合は、作成してから .active を書き込む', async () => {
    await explains('`setActiveConfig` のテストです。`projects` ディレクトリが存在しない場合に、ディレクトリを作成し、`.active` に外部ファイルへの相対パスが書き込まれることを確認します。')
    const root = makeTemporaryDirectory()
    const file = path.join(root, 'elsewhere.json')
    stepSync('プロジェクトルートと外部の設定ファイルを用意する', () => {
      setEnvironment({ CLAUDE_PROJECT_DIR: root })
      writeFileSync(file, '{}')
    })
    stepSync('アクティブな設定を指定する', () => {
      setActiveConfig(file)
    })
    stepSync('.active の内容を比べる', () => {
      expect(readFileSync(path.join(root, '.pecot', 'config', 'projects', '.active'), 'utf8')).toBe('../../../elsewhere.json\n')
    })
  })

  it('存在しないファイルをアクティブな設定に指定すると、ConfigError を発生させる', async () => {
    await explains('`setActiveConfig` のテストです。存在しないファイルを指定した場合に、`config file not found` を含む `ConfigError` が発生することを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('エラーの種類とメッセージを確かめる', () => {
      expect(() => {
        setActiveConfig(path.join(projects, 'nonexistent.json'))
      }).toThrow(ConfigError)
      expect(() => {
        setActiveConfig(path.join(projects, 'nonexistent.json'))
      }).toThrow('config file not found')
    })
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
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('設定ファイルと不正なファイルを置く', () => {
      writeProject(projects, 'b', ['acme/app'])
      writeProject(projects, 'a', ['acme/app'])
      writeFileSync(path.join(projects, 'broken.json'), '{}')
    })
    const entries = stepSync('設定の一覧を求める', () => listProjectConfigEntries())
    stepSync('一覧を比べる', () => {
      expect(entries).toEqual([
        { fileName: 'a.json', host: 'ghes.example.com', owner: 'test-owner', number: 1 },
        { fileName: 'b.json', host: 'ghes.example.com', owner: 'test-owner', number: 1 },
      ])
    })
  })
})

describe('removeConfig', () => {
  it('指定した設定ファイルを削除する', async () => {
    await explains('設定ファイルを削除する `removeConfig` のテストです。指定したファイルが削除され、存在しなくなることを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = stepSync('設定ファイルを置く', () => writeProject(projects, 'board', ['acme/app']))
    stepSync('設定ファイルを削除する', () => {
      removeConfig(file)
    })
    stepSync('ファイルが無いことを確かめる', () => {
      expect(existsSync(file)).toBe(false)
    })
  })
})

describe('loadNamedConfig', () => {
  it('名前で設定を読み込み、.json は省略でき、存在しない名前は undefined を返す', async () => {
    await explains('名前を指定して設定を読み込む `loadNamedConfig` のテストです。`board` と `board.json` のどちらでも同じ設定を返し、存在しない名前の場合に `undefined` を返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('設定ファイルを置く', () => {
      writeProject(projects, 'board', ['acme/app'])
    })
    const loaded = stepSync('名前で設定を読み込む', () => ({ plain: loadNamedConfig('board'), withExtension: loadNamedConfig('board.json'), missing: loadNamedConfig('missing') }))
    stepSync('読み込んだ設定を比べる', () => {
      expect(loaded.plain?.name).toBe('board')
      expect(loaded.withExtension?.name).toBe('board')
      expect(loaded.missing).toBeUndefined()
    })
  })
})

describe('findConfigsForRepository', () => {
  it('対象のリポジトリを含む設定だけを、名前順に返す', async () => {
    await explains('リポジトリを含む設定を探す `findConfigsForRepository` のテストです。対象のリポジトリを含む設定だけが、名前の順に返されることを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('設定ファイルを 3 つ置く', () => {
      writeProject(projects, 'b', ['acme/app'])
      writeProject(projects, 'a', ['acme/app', 'acme/lib'])
      writeProject(projects, 'c', ['acme/lib'])
    })
    const found = stepSync('リポジトリを含む設定を探す', () => findConfigsForRepository(TARGET))
    stepSync('設定の名前を比べる', () => {
      expect(found.map(entry => entry.name)).toEqual(['a', 'b'])
    })
  })

  it('repositories に存在しなくても、aggregation_repo が一致する場合は含める', async () => {
    await explains('`findConfigsForRepository` のテストです。`repositories` に存在せず `aggregation_repo` だけが対象と一致する設定も、結果に含まれることを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('aggregation_repo だけが一致する設定を置く', () => {
      writeProject(projects, 'board', ['acme/lib'], 'acme/app')
    })
    const found = stepSync('リポジトリを含む設定を探す', () => findConfigsForRepository(TARGET))
    stepSync('設定の名前を比べる', () => {
      expect(found.map(entry => entry.name)).toEqual(['board'])
    })
  })

  it('.active が projects/ の外の設定を指す場合は、候補に含め、名前をパスにする', async () => {
    await explains('`findConfigsForRepository` のテストです。`.active` が `projects` ディレクトリの外の設定を指している場合に、その設定が候補に含まれ、名前が実パスになることを確認します。')
    const { root, projects } = stepSync('プロジェクトを用意する', () => useProject())
    const outside = stepSync('projects の外に設定を置き、.active から指す', () => {
      const file = writeProject(root, 'outside', ['acme/app'])
      writeFileSync(path.join(projects, '.active'), file)
      return file
    })
    const [found] = stepSync('リポジトリを含む設定を探す', () => findConfigsForRepository(TARGET))
    stepSync('パスと名前を比べる', () => {
      expect(found?.path).toBe(realpathSync(outside))
      expect(found?.name).toBe(realpathSync(outside))
    })
  })

  it('不正な形式の設定を含む場合は、対象と無関係でも、パスを含む ConfigError を発生させる', async () => {
    await explains('`findConfigsForRepository` のテストです。不正な形式の設定ファイルが存在する場合に、そのパスを含む `ConfigError` を発生させることを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('正しい設定と不正な設定を置く', () => {
      writeProject(projects, 'good', ['acme/app'])
      writeFileSync(path.join(projects, 'broken.json'), '{}')
    })
    stepSync('エラーの種類とメッセージを確かめる', () => {
      expect(() => findConfigsForRepository(TARGET)).toThrow(ConfigError)
      expect(() => findConfigsForRepository(TARGET)).toThrow(path.join(projects, 'broken.json'))
    })
  })
})

describe('findConfigFor', () => {
  it('候補が 1 つの場合はその設定を返し、0 個の場合は none を返す', async () => {
    await explains('リポジトリに対応する設定を選ぶ `findConfigFor` のテストです。候補が 1 つの場合に `found` を返し、0 個の場合に `none` を返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('設定ファイルを置く', () => {
      writeProject(projects, 'board', ['acme/app'])
    })
    const results = stepSync('設定を選ぶ', () => ({ single: findConfigFor(TARGET), none: findConfigFor({ owner: 'acme', repository: 'other' }) }))
    stepSync('選んだ結果を比べる', () => {
      expect(results.single).toMatchObject({ kind: 'found', found: { name: 'board' } })
      expect(results.none).toEqual({ kind: 'none' })
    })
  })

  it('候補が 2 つ以上の場合は、.active の指す候補を使い、指していなければ ambiguous を返す', async () => {
    await explains('`findConfigFor` のテストです。候補が 2 つ以上で `.active` を設定していない場合は `ambiguous` を返し、`.active` で候補の 1 つを指定した場合は、その設定を `found` として返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const second = stepSync('候補になる設定を 2 つ置く', () => {
      writeProject(projects, 'a', ['acme/app'])
      return writeProject(projects, 'b', ['acme/app'])
    })
    const withoutActive = stepSync('.active が無い状態で設定を選ぶ', () => findConfigFor(TARGET))
    stepSync('ambiguous を確かめる', () => {
      expect(withoutActive).toMatchObject({ kind: 'ambiguous', candidates: [{ name: 'a' }, { name: 'b' }] })
    })
    stepSync('.active で候補の 1 つを指す', () => {
      writeFileSync(path.join(projects, '.active'), second)
    })
    const withActive = stepSync('.active がある状態で設定を選ぶ', () => findConfigFor(TARGET))
    stepSync('found を確かめる', () => {
      expect(withActive).toMatchObject({ kind: 'found', found: { name: 'b' } })
    })
  })

  it('project を指定した場合は、その名前の設定を使い、存在しない名前と対象を含まない設定を区別する', async () => {
    await explains('`findConfigFor` のテストです。`project` を指定した場合に、設定が存在すれば `found`、名前が存在しなければ `unknown-project`、対象を含まなければ `not-in-project` を返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    stepSync('設定ファイルを 3 つ置く', () => {
      writeProject(projects, 'a', ['acme/app'])
      writeProject(projects, 'b', ['acme/app'])
      writeProject(projects, 'c', ['acme/lib'])
    })
    const results = stepSync('project を指定して設定を選ぶ', () => ({
      existing: findConfigFor(TARGET, 'b'),
      missing: findConfigFor(TARGET, 'missing'),
      empty: findConfigFor(TARGET, ''),
      notIn: findConfigFor(TARGET, 'c'),
    }))
    stepSync('選んだ結果を比べる', () => {
      expect(results.existing).toMatchObject({ kind: 'found', found: { name: 'b' } })
      expect(results.missing).toEqual({ kind: 'unknown-project', project: 'missing' })
      expect(results.empty).toEqual({ kind: 'unknown-project', project: '' })
      expect(results.notIn).toMatchObject({ kind: 'not-in-project', found: { name: 'c' } })
    })
  })
})

describe('configSourcePath', () => {
  it('loadConfig で読み込んだ設定は、元のファイルの実パスを返す', async () => {
    await explains('設定の読み込み元を返す `configSourcePath` のテストです。`loadConfig` で読み込んだ設定の場合に実パスを返し、メモリ上で作成した設定の場合に `undefined` を返すことを確認します。')
    const { projects } = stepSync('プロジェクトを用意する', () => useProject())
    const file = stepSync('設定ファイルを置く', () => writeProject(projects, 'board', ['acme/app']))
    const paths = stepSync('読み込み元を求める', () => ({ loaded: configSourcePath(loadConfig(file)), inMemory: configSourcePath(sampleConfig()) }))
    stepSync('読み込み元を比べる', () => {
      expect(paths.loaded).toBe(realpathSync(file))
      expect(paths.inMemory).toBeUndefined()
    })
  })
})

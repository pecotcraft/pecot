/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ConfigError, parseProjectConfig, serializeProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import type { JsonValue } from '../../domain/python-format.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import {
  configDirectory,
  configSourcePath,
  findConfigFor,
  findConfigsForRepository,
  getActiveConfigPath,
  loadActiveConfig,
  loadConfig,
  loadNamedConfig,
  projectsDirectory,
  saveConfig,
  setActiveConfig,
} from '../config-store.js'

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
  it('設定ディレクトリは .pecot/config、プロジェクト設定ディレクトリはその下の projects を返す', () => {
    const { root } = useProject()
    expect(configDirectory()).toBe(path.join(root, '.pecot', 'config'))
    expect(projectsDirectory()).toBe(path.join(root, '.pecot', 'config', 'projects'))
  })
})

describe('loadConfig', () => {
  it('有効な設定ファイルを読む', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'test.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    const config = loadConfig(file)
    expect(config.host).toBe('ghes.example.com')
    expect(config.owner).toBe('test-owner')
  })

  it('存在しないファイルは ConfigError', () => {
    const { projects } = useProject()
    expect(() => loadConfig(path.join(projects, 'nonexistent.json'))).toThrow(ConfigError)
    expect(() => loadConfig(path.join(projects, 'nonexistent.json'))).toThrow('config file not found')
  })

  it('不正な JSON は invalid config file の ConfigError（詳細は JSON パーサーの文で、Python とは違う）', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'invalid.json')
    writeFileSync(file, 'not valid json')
    expect(() => loadConfig(file)).toThrow(ConfigError)
    expect(() => loadConfig(file)).toThrow(`invalid config file: ${file}: `)
  })

  it('形が不正なら invalid config file の ConfigError（詳細は 場所: 本文 を ; でつなぐ）', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'bad.json')
    writeFileSync(file, '{}')
    expect(() => loadConfig(file)).toThrow(ConfigError)
    expect(() => loadConfig(file)).toThrow(`invalid config file: ${file}: host: Field required; owner: Field required;`)
  })
})

describe('saveConfig', () => {
  it('設定を保存する', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'output.json')
    saveConfig(sampleConfig(), file)
    expect(readFileSync(file, 'utf8')).toBe(serializeProjectConfig(sampleConfig()))
  })

  it('親ディレクトリが無ければ作る', () => {
    const { root } = useProject()
    const file = path.join(root, 'subdir', 'output.json')
    saveConfig(sampleConfig(), file)
    expect(existsSync(file)).toBe(true)
  })

  it('release_branch を保存して読み直せる', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'output.json')
    saveConfig(sampleConfig(), file)
    expect(loadConfig(file).repositories[0]?.release_branch).toBe('main')
  })

  it('値の無い項目は出力しない', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'output.json')
    saveConfig(sampleConfig(), file)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('priority')
    expect(text).not.toContain('board_url')
  })
})

describe('アクティブ設定', () => {
  it('.active が無ければ undefined', () => {
    useProject()
    expect(getActiveConfigPath()).toBeUndefined()
  })

  it('.active が絶対パスならそのパスを返す', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), file)
    expect(getActiveConfigPath()).toBe(file)
  })

  it('.active が相対パスなら .active のあるディレクトリ基準で解決する', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), 'config.json\n')
    expect(getActiveConfigPath()).toBe(file)
  })

  it('.active が空なら undefined', () => {
    const { projects } = useProject()
    writeFileSync(path.join(projects, '.active'), ' \n')
    expect(getActiveConfigPath()).toBeUndefined()
  })

  it('.active の指す先が無ければ undefined', () => {
    const { projects } = useProject()
    writeFileSync(path.join(projects, '.active'), '/nonexistent/path.json')
    expect(getActiveConfigPath()).toBeUndefined()
  })

  it('loadActiveConfig: アクティブ設定を読む', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), file)
    expect(loadActiveConfig()?.host).toBe('ghes.example.com')
  })

  it('loadActiveConfig: 無ければ undefined', () => {
    useProject()
    expect(loadActiveConfig()).toBeUndefined()
  })

  it('setActiveConfig: .active に相対パスを書く', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    setActiveConfig(file)
    expect(readFileSync(path.join(projects, '.active'), 'utf8')).toBe('config.json\n')
    expect(getActiveConfigPath()).toBe(file)
  })

  it('setActiveConfig: projects ディレクトリが無ければ作る', () => {
    const root = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PROJECT_DIR: root })
    const file = path.join(root, 'elsewhere.json')
    writeFileSync(file, '{}')
    setActiveConfig(file)
    expect(readFileSync(path.join(root, '.pecot', 'config', 'projects', '.active'), 'utf8')).toBe('../../../elsewhere.json\n')
  })

  it('setActiveConfig: 存在しないファイルは ConfigError', () => {
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

describe('loadNamedConfig', () => {
  it('名前で読み、.json は省ける。無い名前は undefined', () => {
    const { projects } = useProject()
    writeProject(projects, 'board', ['acme/app'])
    expect(loadNamedConfig('board')?.name).toBe('board')
    expect(loadNamedConfig('board.json')?.name).toBe('board')
    expect(loadNamedConfig('missing')).toBeUndefined()
  })
})

describe('findConfigsForRepository', () => {
  it('対象のリポを含む設定だけを名前順に返す', () => {
    const { projects } = useProject()
    writeProject(projects, 'b', ['acme/app'])
    writeProject(projects, 'a', ['acme/app', 'acme/lib'])
    writeProject(projects, 'c', ['acme/lib'])
    expect(findConfigsForRepository(TARGET).map(found => found.name)).toEqual(['a', 'b'])
  })

  it('repositories に無くても aggregation_repo が一致すれば含む', () => {
    const { projects } = useProject()
    writeProject(projects, 'board', ['acme/lib'], 'acme/app')
    expect(findConfigsForRepository(TARGET).map(found => found.name)).toEqual(['board'])
  })

  it('.active が projects/ の外の設定を指せば、それも候補にし、名前はパスにする', () => {
    const { root, projects } = useProject()
    const outside = writeProject(root, 'outside', ['acme/app'])
    writeFileSync(path.join(projects, '.active'), outside)
    const [found] = findConfigsForRepository(TARGET)
    expect(found?.path).toBe(realpathSync(outside))
    expect(found?.name).toBe(realpathSync(outside))
  })

  it('形の誤った設定は、関係が無くても、パスを文に出して ConfigError', () => {
    const { projects } = useProject()
    writeProject(projects, 'good', ['acme/app'])
    writeFileSync(path.join(projects, 'broken.json'), '{}')
    expect(() => findConfigsForRepository(TARGET)).toThrow(ConfigError)
    expect(() => findConfigsForRepository(TARGET)).toThrow(path.join(projects, 'broken.json'))
  })
})

describe('findConfigFor', () => {
  it('候補が 1 つならそれ、0 個なら none', () => {
    const { projects } = useProject()
    writeProject(projects, 'board', ['acme/app'])
    expect(findConfigFor(TARGET)).toMatchObject({ kind: 'found', found: { name: 'board' } })
    expect(findConfigFor({ owner: 'acme', repository: 'other' })).toEqual({ kind: 'none' })
  })

  it('候補が 2 つ以上なら、.active の指す候補を使い、無ければ ambiguous', () => {
    const { projects } = useProject()
    writeProject(projects, 'a', ['acme/app'])
    const second = writeProject(projects, 'b', ['acme/app'])
    expect(findConfigFor(TARGET)).toMatchObject({ kind: 'ambiguous', candidates: [{ name: 'a' }, { name: 'b' }] })
    writeFileSync(path.join(projects, '.active'), second)
    expect(findConfigFor(TARGET)).toMatchObject({ kind: 'found', found: { name: 'b' } })
  })

  it('project を渡せば、その名前の設定を使う。無い名前（空の名前も含む）と、対象のリポを含まない設定を分ける', () => {
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
  it('loadConfig で読んだ設定のファイルの実パスを返す', () => {
    const { projects } = useProject()
    const file = writeProject(projects, 'board', ['acme/app'])
    expect(configSourcePath(loadConfig(file))).toBe(realpathSync(file))
    expect(configSourcePath(sampleConfig())).toBeUndefined()
  })
})

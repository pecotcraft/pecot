/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ConfigError, MultipleConfigsError, parseProjectConfig, serializeProjectConfig } from '../../domain/config.js'
import type { ProjectConfig } from '../../domain/config.js'
import { InvalidValueError } from '../../domain/errors.js'
import type { JsonValue } from '../../domain/python-format.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import {
  configDirectory,
  findConfigFile,
  getActiveConfigPath,
  getProjectConfig,
  loadActiveConfig,
  loadConfig,
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

  it('不正な JSON は値の不正（文言は JSON パーサーのもの。Python とは違う）', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'invalid.json')
    writeFileSync(file, 'not valid json')
    expect(() => loadConfig(file)).toThrow(InvalidValueError)
  })

  it('形が不正なら検証エラーの文', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'bad.json')
    writeFileSync(file, '{}')
    expect(() => loadConfig(file)).toThrow(/^4 validation errors for ProjectConfig\nhost\n/u)
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

describe('findConfigFile', () => {
  it('host_owner_*.json を探す', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'ghes.example.com_test-owner_project1.json')
    writeFileSync(file, '{}')
    expect(findConfigFile({ host: 'ghes.example.com', owner: 'test-owner' })).toBe(file)
  })

  it('見つからなければ undefined', () => {
    useProject()
    expect(findConfigFile({ host: 'github.com', owner: 'test' })).toBeUndefined()
  })

  it('host か owner が無ければ undefined', () => {
    const { projects } = useProject()
    writeFileSync(path.join(projects, 'github.com_test_p.json'), '{}')
    expect(findConfigFile({ host: 'github.com' })).toBeUndefined()
    expect(findConfigFile({ owner: 'test' })).toBeUndefined()
    expect(findConfigFile({})).toBeUndefined()
  })

  it('複数見つかったら MultipleConfigsError（名前順）', () => {
    const { projects } = useProject()
    writeFileSync(path.join(projects, 'ghes.example.com_test-owner_project2.json'), '{}')
    writeFileSync(path.join(projects, 'ghes.example.com_test-owner_project1.json'), '{}')
    expect(() => findConfigFile({ host: 'ghes.example.com', owner: 'test-owner' })).toThrow(MultipleConfigsError)
    expect(() => findConfigFile({ host: 'ghes.example.com', owner: 'test-owner' }))
      .toThrow('multiple config files found: '
        + '[\'ghes.example.com_test-owner_project1.json\', \'ghes.example.com_test-owner_project2.json\']')
  })

  it('接頭辞が似ていて owner が長い別のファイルは拾わない', () => {
    const { projects } = useProject()
    writeFileSync(path.join(projects, 'github.com_test2_p.json'), '{}')
    expect(findConfigFile({ host: 'github.com', owner: 'test' })).toBeUndefined()
  })

  it('.json でないファイルは拾わない', () => {
    const { projects } = useProject()
    writeFileSync(path.join(projects, 'github.com_test_p.json.bak'), '{}')
    expect(findConfigFile({ host: 'github.com', owner: 'test' })).toBeUndefined()
  })

  it('projects ディレクトリが無ければ undefined', () => {
    setEnvironment({ CLAUDE_PROJECT_DIR: makeTemporaryDirectory() })
    expect(findConfigFile({ host: 'github.com', owner: 'test' })).toBeUndefined()
  })
})

describe('getProjectConfig', () => {
  it('引数なしならアクティブ設定', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), file)
    expect(getProjectConfig()?.host).toBe('ghes.example.com')
  })

  it('repo 名だけならアクティブ設定の repositories を確かめる', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), file)
    expect(getProjectConfig({ repository: 'test-repo' })?.host).toBe('ghes.example.com')
  })

  it('repo 名がアクティブ設定に無ければ undefined', () => {
    const { projects } = useProject()
    const file = path.join(projects, 'config.json')
    writeFileSync(file, JSON.stringify(sampleData()))
    writeFileSync(path.join(projects, '.active'), file)
    expect(getProjectConfig({ repository: 'unknown-repo' })).toBeUndefined()
  })

  it('host と owner で検索する', () => {
    const { projects } = useProject()
    writeFileSync(path.join(projects, 'ghes.example.com_test-owner_project.json'), JSON.stringify(sampleData()))
    expect(getProjectConfig({ host: 'ghes.example.com', owner: 'test-owner' })?.host).toBe('ghes.example.com')
  })

  it('見つからなければ undefined', () => {
    useProject()
    expect(getProjectConfig({ host: 'github.com', owner: 'nobody' })).toBeUndefined()
  })
})

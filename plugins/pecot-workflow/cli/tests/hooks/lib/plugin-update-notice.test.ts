/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// plugin-update-notice.sh のテスト。
// installed が marketplace の clone の最新版より古いときだけ、更新の案内を出すことを確かめる。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { EnvironmentOverrides, HookCase } from '../_helpers/environment.js'
import { hooksDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import type { RunResult } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

const NOTICE_SCRIPT = path.join(hooksDirectory, 'lib', 'session-start', 'plugin-update-notice.sh')
const COMMON_SCRIPT = path.join(hooksDirectory, 'lib', 'session-start-common.sh')

// プラグイン名からリポ内のディレクトリ名を引く。
const PLUGIN_DIRECTORIES = new Map([['pecot-w', 'pecot-workflow'], ['pecot-v', 'pecot-visual']])

// hooks-config.json が無い前提（既定値の true で有効）に固定する。
function noConfigPath(hookCase: HookCase): string {
  const file = path.join(hookCase.temporaryPath, 'no-such-hooks-config.json')
  hookCase.setEnv('PECOT_HOOKS_CONFIG_PATH', file)
  return file
}

interface FixtureOptions {
  readonly marketplace?: string
  readonly name?: string
  readonly source?: unknown
  readonly pluginsRoot?: string
  readonly knownMarketplaces?: boolean
  readonly installLocation?: string
  readonly copilotCache?: boolean
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, jsonDumps(value))
}

// installed と latest の version 木を作り、ルートを返す。
// latest が空文字なら、clone 側の plugin.json を作らない（clone が無い状態）。
function makeFixture(hookCase: HookCase, installed: string, latest: string, flavor: 'claude' | 'copilot', options: FixtureOptions = {}): string {
  const marketplace = options.marketplace ?? 'pecot'
  const name = options.name ?? 'pecot-w'
  const isKnownMarketplaces = options.knownMarketplaces ?? true
  const home = path.join(hookCase.temporaryPath, 'home')
  const claudePlugins = options.pluginsRoot ?? path.join(home, '.claude', 'plugins')
  let root: string
  let cloneDirectory: string
  if (flavor === 'claude') {
    root = path.join(claudePlugins, 'cache', marketplace, name, installed)
    cloneDirectory = path.join(claudePlugins, 'marketplaces', marketplace)
  }
  else {
    root = path.join(home, '.copilot', 'installed-plugins', marketplace, name)
    cloneDirectory = options.copilotCache === true
      ? path.join(home, '.copilot', '.cache', 'copilot', 'marketplaces', 'https---example-com-o-r-git')
      : path.join(claudePlugins, 'marketplaces', marketplace)
  }
  // ディレクトリ名とプラグイン名は一致しない。marketplace.json の source が clone 内の場所を決める
  const pluginDirectory = PLUGIN_DIRECTORIES.get(name) ?? ''
  if (options.installLocation !== undefined) cloneDirectory = options.installLocation
  const cloneRoot = path.join(cloneDirectory, 'plugins', pluginDirectory)
  const source = options.source ?? `./plugins/${pluginDirectory}`

  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), `{"version":"${installed}"}\n`)
  if (flavor === 'claude' && isKnownMarketplaces) {
    const entry = { installLocation: options.installLocation ?? cloneDirectory }
    writeJson(path.join(claudePlugins, 'known_marketplaces.json'), { [marketplace]: entry })
  }
  if (latest !== '') {
    writeJson(path.join(cloneDirectory, '.claude-plugin', 'marketplace.json'), { name: marketplace, plugins: [{ name, source }] })
    mkdirSync(path.join(cloneRoot, '.claude-plugin'), { recursive: true })
    writeFileSync(path.join(cloneRoot, '.claude-plugin', 'plugin.json'), `{"version":"${latest}"}\n`)
  }
  return root
}

interface NoticeOptions {
  readonly pluginRoot: string | undefined
  readonly configPath?: string
  readonly extraEnvironment?: EnvironmentOverrides
}

function runNotice(hookCase: HookCase, options: NoticeOptions): RunResult {
  return run(hookCase, NOTICE_SCRIPT, [], {
    env: {
      CLAUDE_CONFIG_DIR: undefined,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: undefined,
      ...options.extraEnvironment,
      CLAUDE_PLUGIN_ROOT: options.pluginRoot,
      ...(options.configPath !== undefined && { PECOT_HOOKS_CONFIG_PATH: options.configPath }),
    },
  })
}

function writePluginJson(directory: string, content: string): void {
  mkdirSync(path.join(directory, '.claude-plugin'), { recursive: true })
  writeFileSync(path.join(directory, '.claude-plugin', 'plugin.json'), content)
}

describe('plugin-update-notice.sh', () => {
  describe('Claude Code 形', () => {
    it('installed が古いとき、更新の案内を出す', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
      expect(result.stdout).toContain('-s project')
    })

    it('version が同じとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.3.0', '1.3.0', 'claude')
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('installed が新しいとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.4.0', '1.3.0', 'claude')
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })

  describe('Copilot 形', () => {
    it('installed が古いとき、更新の案内を出し、-s project の注記は付けない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'copilot', { marketplace: 'pecot', name: 'pecot-v' })
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('copilot plugin update pecot-v@pecot')
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      // copilot 形では -s project の注記は付かない
      expect(result.stdout).not.toContain('-s project')
    })
  })

  describe('案内を出さない条件', () => {
    it('CLAUDE_PLUGIN_ROOT が未設定のとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const result = runNotice(hookCase, { pluginRoot: undefined })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('開発用のパスのとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = path.join(hookCase.temporaryPath, 'dev', 'aist-plugin', 'plugins', 'pecot-workflow')
      writePluginJson(root, '{"version":"1.2.0"}\n')
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('marketplace の clone が無いとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      // latest を空にして、clone 側の plugin.json を作らない
      const root = makeFixture(hookCase, '1.2.0', '', 'claude')
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('installed 側の plugin.json に version が無いとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      // installed 側の plugin.json を version 欠落に差し替える
      writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), '{}\n')
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('設定で無効にしたとき、何も出力しない', () => {
      const hookCase = createHookCase()
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      const config = path.join(hookCase.temporaryPath, 'hooks-config.json')
      writeFileSync(config, '{"plugin-update-notice": false}')
      const result = runNotice(hookCase, { pluginRoot: root, configPath: config })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })

  describe('ルートの書き方と配線', () => {
    it('CLAUDE_PLUGIN_ROOT の末尾にスラッシュがあっても、案内を出す', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      const result = runNotice(hookCase, { pluginRoot: `${root}/` })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('session-start-common.sh 経由で、通知が注入される', () => {
      // session-start-common.sh は git-sync や vscode-detector なども動かすため、env を隔離する。
      // CLAUDE_PROJECT_DIR は .pecot の無いディレクトリに向け、CLAUDE_ENV_FILE は外す。
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      const projectDirectory = path.join(hookCase.temporaryPath, 'plain-project')
      mkdirSync(projectDirectory, { recursive: true })
      const result = run(hookCase, COMMON_SCRIPT, [], {
        env: { CLAUDE_ENV_FILE: undefined, CLAUDE_PROJECT_DIR: projectDirectory, CLAUDE_PLUGIN_ROOT: root },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('plugin update available: pecot-w')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('ディレクトリ名とプラグイン名が違っても、source 経由で最新版を引く', () => {
      // pecot-w の clone 側は plugins/pecot-workflow にある
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '2.0.0', 'claude', { marketplace: 'pecot', name: 'pecot-w' })
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 2.0.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('marketplace.json に同名の項目が無いとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude', { marketplace: 'pecot', name: 'pecot-w' })
      const marketplace = path.join(hookCase.temporaryPath, 'home', '.claude', 'plugins', 'marketplaces', 'pecot', '.claude-plugin', 'marketplace.json')
      writeFileSync(marketplace, jsonDumps({ plugins: [{ name: 'other', source: './plugins/x' }] }))
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('source がオブジェクト形式のとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude', {
        marketplace: 'pecot',
        name: 'pecot-w',
        source: { source: 'github', repo: 'a/b' },
      })
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })

  describe('Claude Code のルートが標準でない配置', () => {
    it('CLAUDE_CONFIG_DIR を既定以外にしたとき、環境変数を読まずルートから導出して案内を出す', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const configDirectory = path.join(hookCase.temporaryPath, 'custom-claude-config')
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude', { pluginsRoot: path.join(configDirectory, 'plugins') })
      const result = runNotice(hookCase, { pluginRoot: root, extraEnvironment: { CLAUDE_CONFIG_DIR: configDirectory } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('CLAUDE_CONFIG_DIR とルートの末尾にスラッシュがあっても、案内を出す', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const configDirectory = path.join(hookCase.temporaryPath, 'custom-claude-config')
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude', { pluginsRoot: path.join(configDirectory, 'plugins') })
      const result = runNotice(hookCase, { pluginRoot: `${root}/`, extraEnvironment: { CLAUDE_CONFIG_DIR: `${configDirectory}/` } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('CLAUDE_CONFIG_DIR が実際のルートと違っても、既定のルートで案内を出す', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      const result = runNotice(hookCase, { pluginRoot: root, extraEnvironment: { CLAUDE_CONFIG_DIR: path.join(hookCase.temporaryPath, 'other') } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('CLAUDE_CODE_PLUGIN_CACHE_DIR でルートを変えた配置のとき、案内を出す', () => {
      // .claude を含まないパス
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const cacheRoot = path.join(hookCase.temporaryPath, 'elsewhere', 'plugin-root')
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude', { pluginsRoot: cacheRoot })
      const result = runNotice(hookCase, { pluginRoot: root, extraEnvironment: { CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheRoot } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('cowork_plugins の配置のとき、案内を出す', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude', {
        pluginsRoot: path.join(hookCase.temporaryPath, 'home', '.claude', 'cowork_plugins'),
      })
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('installLocation が既定の marketplaces と違う場所を指すとき、そちらを読む', () => {
      // known_marketplaces.json の installLocation を優先する
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude', {
        installLocation: path.join(hookCase.temporaryPath, 'somewhere', 'clone'),
      })
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('installLocation のディレクトリが無いとき、隣の marketplaces を読む', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      const plugins = path.join(hookCase.temporaryPath, 'home', '.claude', 'plugins')
      writeFileSync(path.join(plugins, 'known_marketplaces.json'), jsonDumps({ pecot: { installLocation: '/nonexistent/clone' } }))
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
      expect(result.stdout).toContain('claude plugin update pecot-w@pecot')
    })

    it('known_marketplaces.json が無いとき、開発用のパスと区別して何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude', { knownMarketplaces: false })
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('ルートが cache/<mp>/<name> までで版のディレクトリが無いとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      const result = runNotice(hookCase, { pluginRoot: path.dirname(root) })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('ルートが版のディレクトリの下の階層を指すとき、何も出力しない', () => {
      // cache が 3 階層上にならない
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'claude')
      const sub = path.join(root, 'sub')
      writePluginJson(sub, '{"version":"1.2.0"}\n')
      const result = runNotice(hookCase, { pluginRoot: sub })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('開発用のパスの途中に cache という名前のディレクトリがあっても、何も出力しない', () => {
      // known_marketplaces.json が無ければ skip する
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = path.join(hookCase.temporaryPath, 'dev', 'cache', 'aist-plugin', 'plugins', 'pecot-workflow')
      writePluginJson(root, '{"version":"1.2.0"}\n')
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })

  describe('Copilot 形の clone の探し方', () => {
    it('Copilot のキャッシュが無いとき、CLAUDE_CONFIG_DIR 下の Claude Code 側の clone を読む', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const configDirectory = path.join(hookCase.temporaryPath, 'custom-claude-config')
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'copilot', {
        marketplace: 'pecot',
        name: 'pecot-v',
        pluginsRoot: path.join(configDirectory, 'plugins'),
      })
      const result = runNotice(hookCase, { pluginRoot: root, extraEnvironment: { CLAUDE_CONFIG_DIR: configDirectory } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('copilot plugin update pecot-v@pecot')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
    })

    it('Copilot 単独の環境でも、Copilot のキャッシュから最新版を引く', () => {
      // Claude Code 側の clone は無い
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'copilot', { marketplace: 'pecot', name: 'pecot-v', copilotCache: true })
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('copilot plugin update pecot-v@pecot')
      expect(result.stdout).toContain('installed: 1.2.0')
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.3.0 (installed:')
    })

    it('Copilot のキャッシュと Claude Code 側の clone が両方あるとき、Copilot のキャッシュを優先する', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.4.0', 'copilot', { marketplace: 'pecot', name: 'pecot-v', copilotCache: true })
      const claudeClone = path.join(hookCase.temporaryPath, 'home', '.claude', 'plugins', 'marketplaces', 'pecot')
      writeJson(path.join(claudeClone, '.claude-plugin', 'marketplace.json'), {
        name: 'pecot',
        plugins: [{ name: 'pecot-v', source: './plugins/pecot-visual' }],
      })
      writePluginJson(path.join(claudeClone, 'plugins', 'pecot-visual'), '{"version":"1.3.0"}\n')
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.stdout).toContain('plugin update available: ')
      expect(result.stdout).toContain(' 1.4.0 (installed:')
    })

    it('キャッシュ内の marketplace.json の name が違うとき、使わず何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'copilot', { marketplace: 'pecot', name: 'pecot-v', copilotCache: true })
      const copilotHome = path.dirname(path.dirname(path.dirname(root)))
      const cache = path.join(copilotHome, '.cache', 'copilot', 'marketplaces', 'https---example-com-o-r-git')
      writeFileSync(
        path.join(cache, '.claude-plugin', 'marketplace.json'),
        jsonDumps({ name: 'other', plugins: [{ name: 'pecot-v', source: './plugins/pecot-visual' }] }),
      )
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('どの clone も無いとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '', 'copilot', { marketplace: 'pecot', name: 'pecot-v' })
      const result = runNotice(hookCase, { pluginRoot: root })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })

    it('ルートが深すぎるとき、何も出力しない', () => {
      const hookCase = createHookCase()
      noConfigPath(hookCase)
      const root = makeFixture(hookCase, '1.2.0', '1.3.0', 'copilot', { marketplace: 'pecot', name: 'pecot-v', copilotCache: true })
      const sub = path.join(root, 'sub')
      mkdirSync(path.join(sub, '.claude-plugin'), { recursive: true })
      const result = runNotice(hookCase, { pluginRoot: sub })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
    })
  })
})

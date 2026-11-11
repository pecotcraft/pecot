/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { InvalidValueError } from '../../domain/errors.js'
import { ValidationFailure } from '../../domain/python-format.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { parseJson } from '../../tests/_helpers/json.js'
import { createGitRepository, gitForTest } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../tests/_helpers/temporary.js'
import { WORKTREE_IGNORE_FILENAME } from '../paths.js'
import { OsError } from '../os-error.js'
import {
  pecotGitignoreEnsureScript,
  createSymlinks,
  createSymlinksSafe,
  DEFAULT_WORKTREEIGNORE_CONTENT,
  getDefaultConfig,
  loadConfig,
  loadCopyExcludeSpec,
  parseWorktreeConfig,
  saveConfig,
  WorktreeConfigError,
} from '../worktree-links.js'
import type { WorktreeConfig } from '../worktree-links.js'
import { ignoredDiagnostics, recordDiagnostics } from './recording-diagnostics.js'
import { worktreeConfigOutputs } from '../../tests/_helpers/python-output.js'

// 期待値は、Python の CLI の実出力（tests/python-output/worktree-config.json。record.py が Python で記録する）
const OUTPUTS = worktreeConfigOutputs()

useIsolatedEnvironment()

function linkOf(linkPath: string, targetRepository: string, targetPath: string): WorktreeConfig['links'][number] {
  return { path: linkPath, target_repo: targetRepository, target_path: targetPath, description: undefined }
}

function configOf(links: WorktreeConfig['links']): WorktreeConfig {
  return { version: 3, description: undefined, links, setup_command: undefined, setup_command_timeout: undefined }
}

function thrownMessage(action: () => void): string {
  try {
    action()
  }
  catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  return '例外が投げられなかった'
}

function savedText(config: WorktreeConfig): string {
  const file = path.join(makeTemporaryDirectory(), 'config.json')
  saveConfig(config, file)
  return readFileSync(file, 'utf8')
}

describe('parseWorktreeConfig（pydantic の WorktreeConfig と同じ検証・同じ文）', () => {
  const invalid = OUTPUTS.cases.filter(testCase => testCase.error !== undefined)
  const valid = OUTPUTS.cases.filter(testCase => testCase.saved !== undefined)

  it.each(invalid)('$name は ValidationFailure で、文は pydantic と同じ', (testCase) => {
    expect(thrownMessage(() => parseWorktreeConfig(testCase.input))).toBe(testCase.error)
    expect(() => parseWorktreeConfig(testCase.input)).toThrow(ValidationFailure)
    expect(() => parseWorktreeConfig(testCase.input)).toThrow(InvalidValueError)
  })

  it.each(valid)('$name は受理し、保存結果は Python の model_dump と同じ', (testCase) => {
    expect(savedText(parseWorktreeConfig(testCase.input))).toBe(testCase.saved)
  })

  it('既定値は version 3・links 空・setup_command なし', () => {
    const config = parseWorktreeConfig({})
    expect(config).toEqual({ version: 3, description: undefined, links: [], setup_command: undefined, setup_command_timeout: undefined })
  })

  it('setup_command と setup_command_timeout を受ける', () => {
    const config = parseWorktreeConfig({ setup_command: 'uv sync', setup_command_timeout: 600 })
    expect(config.setup_command).toBe('uv sync')
    expect(config.setup_command_timeout).toBe(600)
  })

  it('links の要素は path・target_repo・target_path・description を持つ', () => {
    const config = parseWorktreeConfig({ links: [{ path: '.claude/settings.local.json', target_repo: 'aist-roadmap', target_path: '.claude/settings.local.json', description: 'd' }] })
    expect(config.links).toEqual([{ path: '.claude/settings.local.json', target_repo: 'aist-roadmap', target_path: '.claude/settings.local.json', description: 'd' }])
  })
})

describe('loadConfig / saveConfig', () => {
  it('保存して読み直すと同じ', () => {
    const config: WorktreeConfig = { ...configOf([linkOf('CLAUDE.local.md', 'aist-roadmap', 'CLAUDE.local.md')]), description: 'test' }
    const file = path.join(makeTemporaryDirectory(), 'config.json')
    saveConfig(config, file)
    expect(loadConfig(file)).toEqual(config)
  })

  it('setup_command を含めて保存・読み込みできる。無いときは JSON に出さない', () => {
    const file = path.join(makeTemporaryDirectory(), 'sub', 'config.json')
    saveConfig({ ...configOf([linkOf('CLAUDE.local.md', 'aist-roadmap', 'CLAUDE.local.md')]), setup_command: 'bash -lc \'uv sync && pnpm install\'' }, file)
    expect(parseJson(readFileSync(file, 'utf8'))).toMatchObject({ setup_command: 'bash -lc \'uv sync && pnpm install\'', version: 3 })
    expect(loadConfig(file).setup_command).toBe('bash -lc \'uv sync && pnpm install\'')

    saveConfig(configOf([]), file)
    expect(parseJson(readFileSync(file, 'utf8'))).not.toHaveProperty('setup_command')
  })

  it('設定ファイルが無ければ WorktreeConfigError', () => {
    const file = path.join(makeTemporaryDirectory(), 'missing.json')
    expect(() => loadConfig(file)).toThrow(WorktreeConfigError)
    expect(() => loadConfig(file)).toThrow(`config file not found: ${file}`)
  })

  it('JSON が不正なら WorktreeConfigError（パースエラー）', () => {
    const file = path.join(makeTemporaryDirectory(), 'bad.json')
    writeFileSync(file, '{ not json')
    expect(() => loadConfig(file)).toThrow(WorktreeConfigError)
    expect(() => loadConfig(file)).toThrow(`JSON parse error: ${file}: `)
  })

  it('旧 v2 は受理しない。検証エラーの文は pydantic のもの', () => {
    const file = path.join(makeTemporaryDirectory(), 'old.json')
    writeFileSync(file, JSON.stringify({ version: 2, links: [{ path: '.env', target_repo: 'r', target_path: '.env' }] }))
    expect(() => loadConfig(file)).toThrow(WorktreeConfigError)
    const expected = [`config file validation failed: ${file}: 1 validation error for WorktreeConfig`, 'version', '  Input should be 3 [type=literal_error, input_value=2, input_type=int]'].join('\n')
    expect(() => loadConfig(file)).toThrow(expected)
  })

  it('ファイルでなくディレクトリなら OsError（Python の IsADirectoryError に当たる）', () => {
    const directory = makeTemporaryDirectory()
    expect(() => loadConfig(directory)).toThrow(OsError)
    expect(thrownMessage(() => loadConfig(directory))).toBe(`[Errno 21] Is a directory: '${directory}'`)
  })

  it('メッセージのパスは Python の Path と同じく正規化する', () => {
    const directory = makeTemporaryDirectory()
    expect(() => loadConfig(`${directory}//./missing.json`)).toThrow(`config file not found: ${directory}/missing.json`)
  })
})

describe('getDefaultConfig', () => {
  it('指定した共有先を 3 リンクが指し、setup_command は無い', () => {
    const config = getDefaultConfig('my-shared')
    expect(config.version).toBe(3)
    expect(config.links.map(link => link.path)).toEqual(['CLAUDE.local.md', '.env', '.claude/settings.local.json'])
    expect(config.links.every(link => link.target_repo === 'my-shared')).toBe(true)
    expect(config.setup_command).toBeUndefined()
  })

  it('自リポ未指定なら hooks-config.json・projects/.active・.pecot/work のリンクを含まない', () => {
    const paths = getDefaultConfig('shared').links.map(link => link.path)
    expect(paths).not.toContain('.pecot/config/hooks-config.json')
    expect(paths).not.toContain('.pecot/config/projects/.active')
    expect(paths).not.toContain('.pecot/work')
  })

  it('自リポを指定すると、3 つのリンク（自リポの main WT を指す）が加わる', () => {
    const links = new Map(getDefaultConfig('shared', 'myrepo').links.map(link => [link.path, link]))
    expect(links.get('.pecot/config/hooks-config.json')).toMatchObject({ target_repo: 'myrepo', target_path: '.pecot/config/hooks-config.json' })
    expect(links.get('.pecot/config/projects/.active')).toMatchObject({ target_repo: 'myrepo', target_path: '.pecot/config/projects/.active' })
    expect(links.get('.pecot/work')).toMatchObject({ target_repo: 'myrepo', target_path: '.pecot/work' })
    expect(links.get('CLAUDE.local.md')?.target_repo).toBe('shared')
  })

  it('保存結果は Python と同じ（setup_command のキーは出ない）', () => {
    expect(savedText(getDefaultConfig('shared'))).toBe(OUTPUTS.defaultConfigSaved)
    expect(savedText(getDefaultConfig('shared', 'myrepo'))).toBe(OUTPUTS.defaultConfigWithSelfSaved)
  })
})

describe('DEFAULT_WORKTREEIGNORE_CONTENT', () => {
  it('Python の定数と同じ中身', () => {
    expect(DEFAULT_WORKTREEIGNORE_CONTENT).toBe(OUTPUTS.defaultIgnoreContent)
  })

  it('よく使うパターンを含む', () => {
    const lines = DEFAULT_WORKTREEIGNORE_CONTENT.split('\n')
    for (const pattern of ['.git/', '__pycache__/', 'node_modules/', '.pecot/', 'tmp/']) {
      expect(lines).toContain(pattern)
    }
  })

  it('Nx のビルド状態は WT 間で共有させない', () => {
    expect(DEFAULT_WORKTREEIGNORE_CONTENT.split('\n')).toContain('.nx/workspace-data/')
  })
})

// <root>/base/aist-roadmap と <root>/base/myrepo を構築し、wt1/myrepo を空で作る
function setupProject(): string {
  const root = path.join(makeTemporaryDirectory(), 'workspaces')
  mkdirSync(path.join(root, 'base', 'myrepo'), { recursive: true })
  writeTree(path.join(root, 'base', 'aist-roadmap'), { 'CLAUDE.local.md': 'shared', '.claude/settings.local.json': '{}' })
  mkdirSync(path.join(root, 'wt1', 'myrepo'), { recursive: true })
  return root
}

const CLAUDE_LOCAL = linkOf('CLAUDE.local.md', 'aist-roadmap', 'CLAUDE.local.md')

describe('createSymlinks', () => {
  it('ルート直下のパスは 2 段の相対リンク', () => {
    const root = setupProject()
    const results = createSymlinks(configOf([CLAUDE_LOCAL]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(results.map(result => result.action)).toEqual(['created'])
    const symlink = path.join(root, 'wt1', 'myrepo', 'CLAUDE.local.md')
    expect(readlinkSync(symlink)).toBe('../../base/aist-roadmap/CLAUDE.local.md')
    expect(readFileSync(symlink, 'utf8')).toBe('shared')
    expect(results[0]).toEqual({ symlinkPath: symlink, targetPath: path.join(root, 'base', 'aist-roadmap', 'CLAUDE.local.md'), action: 'created', message: '' })
  })

  it('ネストしたパスは 3 段の相対リンク。中間ディレクトリも作る', () => {
    const root = setupProject()
    const results = createSymlinks(configOf([linkOf('.claude/settings.local.json', 'aist-roadmap', '.claude/settings.local.json')]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    const symlink = path.join(root, 'wt1', 'myrepo', '.claude', 'settings.local.json')
    expect(readlinkSync(symlink)).toBe('../../../base/aist-roadmap/.claude/settings.local.json')
    expect(readFileSync(symlink, 'utf8')).toBe('{}')
  })

  it('ターゲットが無ければ skipped。理由は受け口にも渡る', () => {
    const root = setupProject()
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('.env', 'aist-roadmap', '.env')]), root, 'wt1', 'myrepo', recorded.diagnostics)
    const target = path.join(root, 'base', 'aist-roadmap', '.env')
    expect(results[0]).toMatchObject({ action: 'skipped', message: `target does not exist: ${target}` })
    expect(recorded.lines).toEqual([`warning: target does not exist: ${target}`])
  })

  it('ターゲットが dangling symlink でも skipped で、識別できる message になる', () => {
    const root = setupProject()
    const dangling = path.join(root, 'base', 'aist-roadmap', 'dangling.md')
    symlinkSync('/nonexistent/target', dangling)
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('dangling.md', 'aist-roadmap', 'dangling.md')]), root, 'wt1', 'myrepo', recorded.diagnostics)
    expect(results[0]).toMatchObject({ action: 'skipped', message: `target is a dangling symlink: ${dangling}` })
    expect(recorded.lines).toEqual([`warning: target is a dangling symlink: ${dangling}`])
  })

  it('既存の symlink は張り替える', () => {
    const root = setupProject()
    const existing = path.join(root, 'wt1', 'myrepo', 'CLAUDE.local.md')
    symlinkSync('/tmp/old-target', existing)
    const results = createSymlinks(configOf([CLAUDE_LOCAL]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    expect(readlinkSync(existing)).toBe('../../base/aist-roadmap/CLAUDE.local.md')
  })

  it('配置先がリアルファイルなら上書きする。ディレクトリなら中身ごと置き換える', () => {
    const root = setupProject()
    const repository = path.join(root, 'wt1', 'myrepo')
    writeTree(repository, { 'CLAUDE.local.md': 'real', 'd/x': '1' })
    mkdirSync(path.join(root, 'base', 'aist-roadmap', 'd'))
    const results = createSymlinks(configOf([CLAUDE_LOCAL, linkOf('d', 'aist-roadmap', 'd')]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(results.map(result => result.action)).toEqual(['created', 'created'])
    expect(lstatSync(path.join(repository, 'CLAUDE.local.md')).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(repository, 'd')).isSymbolicLink()).toBe(true)
  })

  it('親がファイルで作れなければ error。message は Python の OSError と同じ文', () => {
    const root = setupProject()
    const repository = path.join(root, 'wt1', 'myrepo')
    writeTree(repository, { sub: 'i am a file' })
    writeTree(path.join(root, 'base', 'shared'), { f: 'x' })
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('sub/file', 'shared', 'f')]), root, 'wt1', 'myrepo', recorded.diagnostics)
    const message = `[Errno 17] File exists: '${path.join(repository, 'sub')}'`
    expect(results[0]).toMatchObject({ action: 'error', message })
    expect(recorded.lines).toEqual([`error: failed to create the symlink: ${path.join(repository, 'sub', 'file')} -> ../../../base/shared/f: ${message}`])
  })
})

function setupTracked(files: Readonly<Record<string, string>>): { readonly root: string, readonly repository: string } {
  const root = path.join(makeTemporaryDirectory(), 'workspaces')
  writeTree(path.join(root, 'base', 'aist-roadmap'), { 'README.md': 'LINK-TARGET', 'docs/index.md': 'LINK-TARGET-DOC', 'untracked.md': 'shared' })
  const repository = path.join(root, 'wt1', 'myrepo')
  createGitRepository(files, repository)
  return { root, repository }
}

describe('git 管理対象のガード', () => {
  it('tracked ファイルには symlink を作らず error にする', () => {
    const { root, repository } = setupTracked({ 'README.md': 'TRACKED-CANARY-12345' })
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('README.md', 'aist-roadmap', 'README.md')]), root, 'wt1', 'myrepo', recorded.diagnostics)
    expect(results[0]).toMatchObject({ action: 'error', message: 'symlink creation aborted because the path is tracked by git: README.md' })
    expect(lstatSync(path.join(repository, 'README.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(repository, 'README.md'), 'utf8')).toBe('TRACKED-CANARY-12345')
    expect(recorded.lines).toEqual([`error: symlink creation skipped because the path is tracked by git: ${path.join(repository, 'README.md')}`])
  })

  it('tracked ディレクトリにも symlink を作らない', () => {
    const { root, repository } = setupTracked({ 'docs/index.md': 'TRACKED-DIR-CANARY' })
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('docs', 'aist-roadmap', 'docs')]), root, 'wt1', 'myrepo', recorded.diagnostics)
    expect(results[0]?.action).toBe('error')
    expect(lstatSync(path.join(repository, 'docs')).isDirectory()).toBe(true)
    expect(readFileSync(path.join(repository, 'docs', 'index.md'), 'utf8')).toBe('TRACKED-DIR-CANARY')
  })

  it('untracked のリアルファイルには symlink を作る', () => {
    const { root, repository } = setupTracked({ 'keep.md': 'x' })
    writeFileSync(path.join(repository, 'untracked.md'), 'local-only')
    const results = createSymlinks(configOf([linkOf('untracked.md', 'aist-roadmap', 'untracked.md')]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    expect(lstatSync(path.join(repository, 'untracked.md')).isSymbolicLink()).toBe(true)
  })

  it('git リポジトリでなければ追跡の確認をせず、symlink を作る', () => {
    const root = path.join(makeTemporaryDirectory(), 'workspaces')
    writeTree(path.join(root, 'base', 'aist-roadmap'), { 'README.md': 'LINK-TARGET' })
    const repository = path.join(root, 'wt1', 'myrepo')
    writeTree(repository, { 'README.md': 'local-only' })
    const results = createSymlinks(configOf([linkOf('README.md', 'aist-roadmap', 'README.md')]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    expect(lstatSync(path.join(repository, 'README.md')).isSymbolicLink()).toBe(true)
  })

  it('git が無ければ追跡の確認をせず、symlink を作る', () => {
    const { root, repository } = setupTracked({ 'README.md': 'TRACKED' })
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
    const results = createSymlinks(configOf([linkOf('README.md', 'aist-roadmap', 'README.md')]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    expect(lstatSync(path.join(repository, 'README.md')).isSymbolicLink()).toBe(true)
  })
})

function setupRealFile(): { readonly root: string, readonly existing: string } {
  const root = setupProject()
  const existing = path.join(root, 'wt1', 'myrepo', 'CLAUDE.local.md')
  writeFileSync(existing, 'real content')
  return { root, existing }
}

describe('createSymlinksSafe', () => {
  it('confirm が OS のエラー以外を投げたら、握り潰さず伝える', () => {
    const { root } = setupRealFile()
    const options = {
      confirm: () => {
        throw new TypeError('boom')
      },
    }
    expect(() => createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, 'wt1', 'myrepo', ignoredDiagnostics, options)).toThrow('boom')
  })

  it('force ならリアルファイルを上書きする', () => {
    const { root, existing } = setupRealFile()
    const results = createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, 'wt1', 'myrepo', ignoredDiagnostics, { force: true })
    expect(results[0]?.action).toBe('created')
    expect(lstatSync(existing).isSymbolicLink()).toBe(true)
  })

  it('force なし・confirm なしなら skipped で、リアルファイルを残す', () => {
    const { root, existing } = setupRealFile()
    const results = createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(results[0]).toMatchObject({ action: 'skipped', message: `a real file exists: ${existing}` })
    expect(lstatSync(existing).isSymbolicLink()).toBe(false)
  })

  it('confirm が true を返せば上書きし、false なら残す。confirm にはパスが渡る', () => {
    const { root, existing } = setupRealFile()
    const asked: (readonly string[])[] = []
    const denied = createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, 'wt1', 'myrepo', ignoredDiagnostics, {
      confirm: (symlinkPath, targetPath) => {
        asked.push([symlinkPath, targetPath])
        return false
      },
    })
    expect(denied[0]?.action).toBe('skipped')
    const approved = createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, 'wt1', 'myrepo', ignoredDiagnostics, { confirm: () => true })
    expect(approved[0]?.action).toBe('created')
    expect(asked).toEqual([[existing, path.join(root, 'base', 'aist-roadmap', 'CLAUDE.local.md')]])
  })
})

const ENSURE_SCRIPT = path.join('hooks', 'lib', 'core', 'pecot-gitignore-ensure.sh')

// base/myrepo に .pecot/ 配下の link 先を置き、wt1/myrepo を git リポジトリにする
function setupPecotLinks(): { readonly root: string, readonly config: WorktreeConfig, readonly worktree: string } {
  const root = setupProject()
  const base = path.join(root, 'base', 'myrepo')
  writeTree(base, { '.pecot/config/hooks-config.json': '{}' })
  mkdirSync(path.join(base, '.pecot', 'work'))
  const worktree = path.join(root, 'wt1', 'myrepo')
  createGitRepository({ 'README.md': 'x' }, worktree)
  const config = configOf([
    linkOf('.pecot/config/hooks-config.json', 'myrepo', '.pecot/config/hooks-config.json'),
    linkOf('.pecot/work', 'myrepo', '.pecot/work'),
  ])
  return { root, config, worktree }
}

describe('.pecot/.gitignore の生成スクリプトの探索', () => {
  it('CLAUDE_PLUGIN_ROOT があればその配下を返す', () => {
    const pluginDirectory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PLUGIN_ROOT: pluginDirectory })
    expect(pecotGitignoreEnsureScript()).toBe(path.join(pluginDirectory, ENSURE_SCRIPT))
  })

  it('指定されているのにスクリプトが無くても、env 側の候補を返す', () => {
    const pluginDirectory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PLUGIN_ROOT: pluginDirectory })
    expect(pecotGitignoreEnsureScript()).toBe(path.join(pluginDirectory, ENSURE_SCRIPT))
  })

  it('スクリプトが無ければ、env 側の候補パスを警告に出す', () => {
    const pluginDirectory = path.join(makeTemporaryDirectory(), 'plugin')
    setEnvironment({ CLAUDE_PLUGIN_ROOT: pluginDirectory })
    const { root, config } = setupPecotLinks()
    const recorded = recordDiagnostics()
    createSymlinks(config, root, 'wt1', 'myrepo', recorded.diagnostics)
    expect(recorded.lines).toEqual([`warning: generation script for .pecot/.gitignore not found: ${path.join(pluginDirectory, ENSURE_SCRIPT)}`])
  })

  it('env が無ければ、ソースツリーの plugin ルートのスクリプトを返す', () => {
    const resolved = pecotGitignoreEnsureScript()
    expect(resolved.endsWith(ENSURE_SCRIPT)).toBe(true)
    expect(readFileSync(resolved, 'utf8')).toContain('#!')
  })

  it('CLAUDE_PLUGIN_ROOT のスクリプトを、WT を CLAUDE_PROJECT_DIR にして呼ぶ', () => {
    const temporary = makeTemporaryDirectory()
    const marker = path.join(temporary, 'marker')
    const script = path.join(temporary, 'plugin', ENSURE_SCRIPT)
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, `#!/bin/bash\necho "$CLAUDE_PROJECT_DIR" > "${marker}"\n`)
    setEnvironment({ CLAUDE_PLUGIN_ROOT: path.join(temporary, 'plugin') })
    const { root, config, worktree } = setupPecotLinks()
    createSymlinks(config, root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(readFileSync(marker, 'utf8').trim()).toBe(worktree)
  })

  it('スクリプトが失敗しても link 作成は続け、stderr を警告として受け口に渡す', () => {
    const temporary = makeTemporaryDirectory()
    const script = path.join(temporary, 'plugin', ENSURE_SCRIPT)
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, '#!/bin/bash\necho oops >&2\nexit 3\n')
    chmodSync(script, 0o755)
    setEnvironment({ CLAUDE_PLUGIN_ROOT: path.join(temporary, 'plugin') })
    const { root, config } = setupPecotLinks()
    const recorded = recordDiagnostics()
    const results = createSymlinks(config, root, 'wt1', 'myrepo', recorded.diagnostics)
    expect(results.map(result => result.action)).toEqual(['created', 'created'])
    expect(recorded.lines).toEqual(['warning: could not generate .pecot/.gitignore: oops'])
  })

  it('bash が見つからなければ例外', () => {
    const { root, config } = setupPecotLinks()
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nobash-') })
    expect(() => createSymlinks(config, root, 'wt1', 'myrepo', ignoredDiagnostics)).toThrow(OsError)
  })
})

describe('.pecot/ 配下の link を張ると WT に .pecot/.gitignore が実ファイルでき、未追跡が出ない（#1219）', () => {
  it('createSymlinks は .pecot/.gitignore を実ファイルで作る', () => {
    const { root, config, worktree } = setupPecotLinks()
    createSymlinks(config, root, 'wt1', 'myrepo', ignoredDiagnostics)
    const gitignore = path.join(worktree, '.pecot', '.gitignore')
    expect(lstatSync(gitignore).isFile()).toBe(true)
    expect(lstatSync(gitignore).isSymbolicLink()).toBe(false)
    expect(gitForTest(worktree, ['status', '--porcelain'])).toBe('')
  })

  it('createSymlinksSafe も .pecot/.gitignore を実ファイルで作る', () => {
    const { root, config, worktree } = setupPecotLinks()
    createSymlinksSafe(config, root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(lstatSync(path.join(worktree, '.pecot', '.gitignore')).isFile()).toBe(true)
    expect(gitForTest(worktree, ['status', '--porcelain'])).toBe('')
  })

  it('.pecot/ 配下の link が無ければ .pecot を作らない', () => {
    const root = setupProject()
    createSymlinks(configOf([CLAUDE_LOCAL]), root, 'wt1', 'myrepo', ignoredDiagnostics)
    expect(() => lstatSync(path.join(root, 'wt1', 'myrepo', '.pecot'))).toThrow(/ENOENT/u)
  })
})

function writeIgnore(mainWorktree: string, content: string): string {
  const file = path.join(mainWorktree, WORKTREE_IGNORE_FILENAME)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

describe('loadCopyExcludeSpec', () => {
  it('.worktreeignore が無ければ WorktreeConfigError', () => {
    const main = makeTemporaryDirectory()
    expect(() => loadCopyExcludeSpec(main, ignoredDiagnostics)).toThrow(WorktreeConfigError)
    expect(() => loadCopyExcludeSpec(main, ignoredDiagnostics)).toThrow(`copy exclude config not found: ${WORKTREE_IGNORE_FILENAME}\n  run pecot worktree init to generate the template`)
  })

  it('基本の gitignore パターンが当たる', () => {
    const main = makeTemporaryDirectory()
    writeIgnore(main, '.git/\n__pycache__/\n*.pyc\n')
    const spec = loadCopyExcludeSpec(main, ignoredDiagnostics)
    expect(spec.matchFile('.git/config')).toBe(true)
    expect(spec.matchFile('__pycache__/foo.pyc')).toBe(true)
    expect(spec.matchFile('mod.pyc')).toBe(true)
    expect(spec.matchFile('README.md')).toBe(false)
  })

  it('空行と # コメントは読み飛ばす', () => {
    const main = makeTemporaryDirectory()
    writeIgnore(main, '# header comment\n\n.git/\n# another comment\n\n*.pyc\n')
    const spec = loadCopyExcludeSpec(main, ignoredDiagnostics)
    expect(spec.matchFile('.git/HEAD')).toBe(true)
    expect(spec.matchFile('foo.pyc')).toBe(true)
    expect(spec.matchFile('foo.md')).toBe(false)
  })

  it('否定パターンが機能する', () => {
    const main = makeTemporaryDirectory()
    writeIgnore(main, '.nx/\n!.nx/version-plans/\n')
    const spec = loadCopyExcludeSpec(main, ignoredDiagnostics)
    expect(spec.matchFile('.nx/workspace-data/cache.db')).toBe(true)
    expect(spec.matchFile('.nx/version-plans/my-plan.md')).toBe(false)
  })

  it('DEFAULT_WORKTREEIGNORE_CONTENT をそのまま読める。警告も出ない', () => {
    const main = makeTemporaryDirectory()
    writeIgnore(main, DEFAULT_WORKTREEIGNORE_CONTENT)
    const recorded = recordDiagnostics()
    const spec = loadCopyExcludeSpec(main, recorded.diagnostics)
    for (const excluded of ['.git/config', '.venv/bin/python', '__pycache__/foo.pyc', 'node_modules/pkg/index.js', '.pecot/config/x.json', 'tmp/scratch.txt']) {
      expect(spec.matchFile(excluded)).toBe(true)
    }
    expect(spec.matchFile('src/main.py')).toBe(false)
    expect(spec.matchFile('README.md')).toBe(false)
    expect(recorded.lines).toEqual([])
  })

  it('空の .worktreeignore は何も除外せず、警告も出さない', () => {
    const main = makeTemporaryDirectory()
    writeIgnore(main, '')
    const recorded = recordDiagnostics()
    const spec = loadCopyExcludeSpec(main, recorded.diagnostics)
    expect(spec.matchFile('.git/config')).toBe(false)
    expect(spec.matchFile('src/main.py')).toBe(false)
    expect(recorded.lines).toEqual([])
  })

  it('有効行があるのに何にも当たらないパターンしか無いと警告する', () => {
    const main = makeTemporaryDirectory()
    const file = writeIgnore(main, '# comment\n\n/\n   \n')
    const recorded = recordDiagnostics()
    const spec = loadCopyExcludeSpec(main, recorded.diagnostics)
    expect(spec.matchFile('anything')).toBe(false)
    expect(recorded.lines).toEqual([`warning: all patterns in ${file} are invalid (1 effective lines silently ignored): check the gitignore syntax`])
  })

  it('コメントと空行だけ（有効行 0）なら警告しない', () => {
    const main = makeTemporaryDirectory()
    writeIgnore(main, '# c1\n\n# c2\n\n')
    const recorded = recordDiagnostics()
    expect(loadCopyExcludeSpec(main, recorded.diagnostics).matchFile('.git/config')).toBe(false)
    expect(recorded.lines).toEqual([])
  })

  it('Python の splitlines と同じ文字でも行を分ける（\\v・\\f・U+2028）', () => {
    const main = makeTemporaryDirectory()
    writeIgnore(main, 'a\vb\fc\u{2028}d')
    const spec = loadCopyExcludeSpec(main, ignoredDiagnostics)
    expect(['a', 'b', 'c', 'd', 'e'].map(name => spec.matchFile(name))).toEqual([true, true, true, true, false])
  })
})

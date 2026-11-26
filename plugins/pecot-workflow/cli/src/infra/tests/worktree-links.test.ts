/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { InvalidValueError } from '@pecot/workflow-core/domain/errors.js'
import { ValidationFailure } from '@pecot/workflow-core/domain/python-format.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { parseJson } from '../../../../../../libs/workflow-core/tests/_helpers/json.js'
import { createGitRepository, gitForTest } from '../../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { WORKTREE_IGNORE_FILENAME } from '@pecot/workflow-core/infra/paths.js'
import { OsError } from '@pecot/workflow-core/infra/os-error.js'
import {
  pecotGitignoreEnsureScript,
  createSymlinks,
  createSymlinksSafe,
  decideOverwrite,
  DEFAULT_WORKTREEIGNORE_CONTENT,
  getDefaultConfig,
  loadConfig,
  loadCopyExcludeSpec,
  parseWorktreeConfig,
  planLink,
  saveConfig,
  WorktreeConfigError,
} from '../worktree-links.js'
import type { LinkPlan, WorktreeConfig } from '../worktree-links.js'
import { ignoredDiagnostics, recordDiagnostics } from '../../../../../../libs/workflow-core/tests/_helpers/recording-diagnostics.js'
import { worktreeConfigOutputs } from '../../../../../../libs/workflow-core/tests/_helpers/python-output.js'
// 案内の文を描くには、コマンドの形の登録が要る
import '../../commands/registry.js'

// 期待値は、Python の CLI の実出力（tests/python-output/worktree-config.json。作り直さない記録）
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

  it.each(invalid)('$name の場合は、ValidationFailure を送出し、メッセージは pydantic と同じ文にする', async (testCase) => {
    await explains('worktree の設定を検証する `parseWorktreeConfig` のテストです。不正な入力ごとに、`ValidationFailure`（`InvalidValueError`）が発生し、メッセージが Python の pydantic の出力と一致することを確認します。')
    expect(thrownMessage(() => parseWorktreeConfig(testCase.input))).toBe(testCase.error)
    expect(() => parseWorktreeConfig(testCase.input)).toThrow(ValidationFailure)
    expect(() => parseWorktreeConfig(testCase.input)).toThrow(InvalidValueError)
  })

  it.each(valid)('$name の場合は、設定として受け付け、保存した内容は Python の model_dump と同じにする', async (testCase) => {
    await explains('worktree の設定を検証する `parseWorktreeConfig` のテストです。有効な入力ごとに、受け付けた設定を保存した JSON が、Python の `model_dump` の出力と一致することを確認します。')
    expect(savedText(parseWorktreeConfig(testCase.input))).toBe(testCase.saved)
  })

  it('空のオブジェクトを渡した場合は、version 3・空の links・setup_command なしの既定値にする', async () => {
    await explains('worktree の設定を検証する `parseWorktreeConfig` のテストです。空のオブジェクトを渡した場合に、`version` が 3、`links` が空の配列、`setup_command` が未指定の設定を返すことを確認します。')
    const config = parseWorktreeConfig({})
    expect(config).toEqual({ version: 3, description: undefined, links: [], setup_command: undefined, setup_command_timeout: undefined })
  })

  it('setup_command と setup_command_timeout を指定できる', async () => {
    await explains('worktree の設定を検証する `parseWorktreeConfig` のテストです。`setup_command` に `uv sync`、`setup_command_timeout` に 600 を指定した場合に、その値を設定として返すことを確認します。')
    const config = parseWorktreeConfig({ setup_command: 'uv sync', setup_command_timeout: 600 })
    expect(config.setup_command).toBe('uv sync')
    expect(config.setup_command_timeout).toBe(600)
  })

  it('links の要素は、path・target_repo・target_path・description を持つ', async () => {
    await explains('worktree の設定を検証する `parseWorktreeConfig` のテストです。`links` に 4 つの項目を指定した場合に、同じ内容の要素を返すことを確認します。')
    const config = parseWorktreeConfig({ links: [{ path: '.claude/settings.local.json', target_repo: 'aist-roadmap', target_path: '.claude/settings.local.json', description: 'd' }] })
    expect(config.links).toEqual([{ path: '.claude/settings.local.json', target_repo: 'aist-roadmap', target_path: '.claude/settings.local.json', description: 'd' }])
  })
})

describe('loadConfig / saveConfig', () => {
  it('設定を保存して読み込むと、保存前と同じ内容になる', async () => {
    await explains('設定を保存する `saveConfig` と、読み込む `loadConfig` のテストです。リンクと説明を持つ設定を保存して読み込んだ場合に、保存前と同じ設定を返すことを確認します。')
    const config: WorktreeConfig = { ...configOf([linkOf('CLAUDE.local.md', 'aist-roadmap', 'CLAUDE.local.md')]), description: 'test' }
    const file = path.join(makeTemporaryDirectory(), 'config.json')
    saveConfig(config, file)
    expect(loadConfig(file)).toEqual(config)
  })

  it('setup_command を保存して読み込める。指定しない場合は、JSON に出力しない', async () => {
    await explains('設定を保存する `saveConfig` と、読み込む `loadConfig` のテストです。`setup_command` を保存した場合は JSON に含まれて読み込め、指定しない場合は `setup_command` のキーが JSON に含まれないことを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'sub', 'config.json')
    saveConfig({ ...configOf([linkOf('CLAUDE.local.md', 'aist-roadmap', 'CLAUDE.local.md')]), setup_command: 'bash -lc \'uv sync && pnpm install\'' }, file)
    expect(parseJson(readFileSync(file, 'utf8'))).toMatchObject({ setup_command: 'bash -lc \'uv sync && pnpm install\'', version: 3 })
    expect(loadConfig(file).setup_command).toBe('bash -lc \'uv sync && pnpm install\'')

    saveConfig(configOf([]), file)
    expect(parseJson(readFileSync(file, 'utf8'))).not.toHaveProperty('setup_command')
  })

  it('設定ファイルが存在しない場合は、WorktreeConfigError を送出する', async () => {
    await explains('設定を読み込む `loadConfig` のテストです。存在しないファイルを指定した場合に、`WorktreeConfigError` が `config file not found: <パス>` のメッセージで発生することを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'missing.json')
    expect(() => loadConfig(file)).toThrow(WorktreeConfigError)
    expect(() => loadConfig(file)).toThrow(`config file not found: ${file}`)
  })

  it('JSON が不正な場合は、WorktreeConfigError を送出する', async () => {
    await explains('設定を読み込む `loadConfig` のテストです。JSON として不正なファイルを指定した場合は、`WorktreeConfigError` が発生し、メッセージが `JSON parse error: <パス>: ` から始まることを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'bad.json')
    writeFileSync(file, '{ not json')
    expect(() => loadConfig(file)).toThrow(WorktreeConfigError)
    expect(() => loadConfig(file)).toThrow(`JSON parse error: ${file}: `)
  })

  it('旧形式の version 2 は受け付けず、検証エラーのメッセージは pydantic と同じ文にする', async () => {
    await explains('設定を読み込む `loadConfig` のテストです。`version` が 2 の場合に、`WorktreeConfigError` が発生し、`Input should be 3` を含む pydantic 形式のメッセージになることを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'old.json')
    writeFileSync(file, JSON.stringify({ version: 2, links: [{ path: '.env', target_repo: 'r', target_path: '.env' }] }))
    expect(() => loadConfig(file)).toThrow(WorktreeConfigError)
    const expected = [`config file validation failed: ${file}: 1 validation error for WorktreeConfig`, 'version', '  Input should be 3 [type=literal_error, input_value=2, input_type=int]'].join('\n')
    expect(() => loadConfig(file)).toThrow(expected)
  })

  it('指定したパスがディレクトリの場合は、OsError を送出する（Python の IsADirectoryError に相当）', async () => {
    await explains('設定を読み込む `loadConfig` のテストです。ファイルではなくディレクトリを指定した場合に、`OsError` が `[Errno 21] Is a directory` のメッセージで発生することを確認します。')
    const directory = makeTemporaryDirectory()
    expect(() => loadConfig(directory)).toThrow(OsError)
    expect(thrownMessage(() => loadConfig(directory))).toBe(`[Errno 21] Is a directory: '${directory}'`)
  })

  it('メッセージに含めるパスは、Python の Path と同じ形に正規化する', async () => {
    await explains('設定を読み込む `loadConfig` のテストです。`//` と `./` を含むパスを指定した場合に、エラーメッセージのパスが重複した区切りを除いた形になることを確認します。')
    const directory = makeTemporaryDirectory()
    expect(() => loadConfig(`${directory}//./missing.json`)).toThrow(`config file not found: ${directory}/missing.json`)
  })
})

describe('getDefaultConfig', () => {
  it('指定した共有先を 3 つのリンクが指し、setup_command は未指定になる', async () => {
    await explains('既定の設定を作成する `getDefaultConfig` のテストです。共有先に `my-shared` を指定した場合に、`CLAUDE.local.md` など 3 つのリンクがすべて `my-shared` を指すことを確認します。')
    const config = getDefaultConfig('my-shared')
    expect(config.version).toBe(3)
    expect(config.links.map(link => link.path)).toEqual(['CLAUDE.local.md', '.env', '.claude/settings.local.json'])
    expect(config.links.every(link => link.target_repo === 'my-shared')).toBe(true)
    expect(config.setup_command).toBeUndefined()
  })

  it('自リポジトリを指定しない場合は、hooks-config.json・projects/.active・.pecot/work のリンクを含めない', async () => {
    await explains('既定の設定を作成する `getDefaultConfig` のテストです。自リポジトリを指定しない場合に、`.pecot` の下の 3 つのリンクが `links` に含まれないことを確認します。')
    const paths = getDefaultConfig('shared').links.map(link => link.path)
    expect(paths).not.toContain('.pecot/config/hooks-config.json')
    expect(paths).not.toContain('.pecot/config/projects/.active')
    expect(paths).not.toContain('.pecot/work')
  })

  it('自リポジトリを指定した場合は、自リポジトリの main の worktree を指す 3 つのリンクが加わる', async () => {
    await explains('既定の設定を作成する `getDefaultConfig` のテストです。自リポジトリに `myrepo` を指定した場合に、`.pecot` の下の 3 つのリンクが `myrepo` を指し、`CLAUDE.local.md` は共有先を指したままであることを確認します。')
    const links = new Map(getDefaultConfig('shared', 'myrepo').links.map(link => [link.path, link]))
    expect(links.get('.pecot/config/hooks-config.json')).toMatchObject({ target_repo: 'myrepo', target_path: '.pecot/config/hooks-config.json' })
    expect(links.get('.pecot/config/projects/.active')).toMatchObject({ target_repo: 'myrepo', target_path: '.pecot/config/projects/.active' })
    expect(links.get('.pecot/work')).toMatchObject({ target_repo: 'myrepo', target_path: '.pecot/work' })
    expect(links.get('CLAUDE.local.md')?.target_repo).toBe('shared')
  })

  it('保存した内容は Python と同じになる（setup_command のキーは含まれない）', async () => {
    await explains('既定の設定を保存する `saveConfig` のテストです。自リポジトリを指定した場合と指定しない場合のどちらでも、保存した JSON が Python の出力と一致することを確認します。')
    expect(savedText(getDefaultConfig('shared'))).toBe(OUTPUTS.defaultConfigSaved)
    expect(savedText(getDefaultConfig('shared', 'myrepo'))).toBe(OUTPUTS.defaultConfigWithSelfSaved)
  })
})

describe('DEFAULT_WORKTREEIGNORE_CONTENT', () => {
  it('既定の .worktreeignore の内容は、Python の定数と同じにする', async () => {
    await explains('既定の `.worktreeignore` の内容を表す `DEFAULT_WORKTREEIGNORE_CONTENT` のテストです。Python の CLI が出力する定数の内容と一致することを確認します。')
    expect(DEFAULT_WORKTREEIGNORE_CONTENT).toBe(OUTPUTS.defaultIgnoreContent)
  })

  it('よく使うパターンを含める', async () => {
    await explains('既定の `.worktreeignore` の内容を表す `DEFAULT_WORKTREEIGNORE_CONTENT` のテストです。`.git/`・`__pycache__/`・`node_modules/`・`.pecot/`・`tmp/` の行が含まれることを確認します。')
    const lines = DEFAULT_WORKTREEIGNORE_CONTENT.split('\n')
    for (const pattern of ['.git/', '__pycache__/', 'node_modules/', '.pecot/', 'tmp/']) {
      expect(lines).toContain(pattern)
    }
  })

  it('Nx のビルド状態は、worktree 間で共有しない', async () => {
    await explains('既定の `.worktreeignore` の内容を表す `DEFAULT_WORKTREEIGNORE_CONTENT` のテストです。`.nx/workspace-data/` の行が含まれることを確認します。')
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
  it('ルート直下のパスは、2 段上を指す相対リンクにする', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。`CLAUDE.local.md` のリンクが `../../base/aist-roadmap/CLAUDE.local.md` を指し、リンク先の内容を読み込めることを確認します。')
    const root = setupProject()
    const results = createSymlinks(configOf([CLAUDE_LOCAL]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(results.map(result => result.action)).toEqual(['created'])
    const symlink = path.join(root, 'wt1', 'myrepo', 'CLAUDE.local.md')
    expect(readlinkSync(symlink)).toBe('../../base/aist-roadmap/CLAUDE.local.md')
    expect(readFileSync(symlink, 'utf8')).toBe('shared')
    expect(results[0]).toEqual({ symlinkPath: symlink, targetPath: path.join(root, 'base', 'aist-roadmap', 'CLAUDE.local.md'), action: 'created', message: '' })
  })

  it('ネストしたパスは、3 段上を指す相対リンクにし、途中のディレクトリも作成する', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。`.claude/settings.local.json` のリンクが `../../../base/aist-roadmap/...` を指し、`.claude` ディレクトリが作成されることを確認します。')
    const root = setupProject()
    const results = createSymlinks(configOf([linkOf('.claude/settings.local.json', 'aist-roadmap', '.claude/settings.local.json')]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    const symlink = path.join(root, 'wt1', 'myrepo', '.claude', 'settings.local.json')
    expect(readlinkSync(symlink)).toBe('../../../base/aist-roadmap/.claude/settings.local.json')
    expect(readFileSync(symlink, 'utf8')).toBe('{}')
  })

  it('リンク先が存在しない場合は、skipped とし、理由を診断メッセージにも出力する', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。リンク先が存在しない場合に、`skipped` と `target does not exist` のメッセージを返し、同じ内容を警告として出力することを確認します。')
    const root = setupProject()
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('.env', 'aist-roadmap', '.env')]), root, path.join(root, 'wt1', 'myrepo'), recorded.diagnostics)
    const target = path.join(root, 'base', 'aist-roadmap', '.env')
    expect(results[0]).toMatchObject({ action: 'skipped', message: `target does not exist: ${target}` })
    expect(recorded.lines).toEqual([`warning: target does not exist: ${target}`])
  })

  it('リンク先がリンク切れのシンボリックリンクの場合も、skipped とし、リンク切れだと分かるメッセージにする', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。リンク先がリンク切れのシンボリックリンクの場合に、`skipped` と `target is a dangling symlink` のメッセージを返し、警告としても出力することを確認します。')
    const root = setupProject()
    const dangling = path.join(root, 'base', 'aist-roadmap', 'dangling.md')
    symlinkSync('/nonexistent/target', dangling)
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('dangling.md', 'aist-roadmap', 'dangling.md')]), root, path.join(root, 'wt1', 'myrepo'), recorded.diagnostics)
    expect(results[0]).toMatchObject({ action: 'skipped', message: `target is a dangling symlink: ${dangling}` })
    expect(recorded.lines).toEqual([`warning: target is a dangling symlink: ${dangling}`])
  })

  it('配置先に既存のシンボリックリンクがある場合は、張り替える', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。別の場所を指す既存のシンボリックリンクがある場合に、`created` を返し、リンクの向きが新しいリンク先に変わることを確認します。')
    const root = setupProject()
    const existing = path.join(root, 'wt1', 'myrepo', 'CLAUDE.local.md')
    symlinkSync('/tmp/old-target', existing)
    const results = createSymlinks(configOf([CLAUDE_LOCAL]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    expect(readlinkSync(existing)).toBe('../../base/aist-roadmap/CLAUDE.local.md')
  })

  it('配置先が通常のファイルの場合は上書きし、ディレクトリの場合は中身ごと置き換える', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。配置先に通常のファイルとディレクトリが存在する場合に、どちらも `created` を返し、シンボリックリンクに置き換わることを確認します。')
    const root = setupProject()
    const repository = path.join(root, 'wt1', 'myrepo')
    writeTree(repository, { 'CLAUDE.local.md': 'real', 'd/x': '1' })
    mkdirSync(path.join(root, 'base', 'aist-roadmap', 'd'))
    const results = createSymlinks(configOf([CLAUDE_LOCAL, linkOf('d', 'aist-roadmap', 'd')]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(results.map(result => result.action)).toEqual(['created', 'created'])
    expect(lstatSync(path.join(repository, 'CLAUDE.local.md')).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(repository, 'd')).isSymbolicLink()).toBe(true)
  })

  it('worktree が <root>/<set>/<repo> の外にある場合でも、その場所にリンクを作成し、リンク先を参照できる', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。標準の配置の外にある worktree を指定した場合に、その場所にリンクを作成し、リンク先の内容を読み込めることを確認します。')
    const root = setupProject()
    const outside = path.join(makeTemporaryDirectory(), 'elsewhere', 'deep', 'checkout')
    mkdirSync(outside, { recursive: true })
    const results = createSymlinks(configOf([CLAUDE_LOCAL]), root, outside, ignoredDiagnostics)
    expect(results.map(result => result.action)).toEqual(['created'])
    const symlink = path.join(outside, 'CLAUDE.local.md')
    expect(results[0]?.symlinkPath).toBe(symlink)
    expect(readFileSync(symlink, 'utf8')).toBe('shared')
    expect(() => lstatSync(path.join(root, 'wt1', 'myrepo', 'CLAUDE.local.md'))).toThrow(/ENOENT/u)
  })

  it('worktree のパスの途中に、深さの異なるシンボリックリンクがある場合でも、リンク先を参照できる', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。パスの途中にシンボリックリンクを含む worktree を指定した場合に、作成したリンクが実際のリンク先に解決されることを確認します。')
    const root = setupProject()
    const base = makeTemporaryDirectory()
    const real = path.join(base, 'a', 'b', 'c', 'real')
    mkdirSync(real, { recursive: true })
    symlinkSync(path.join(base, 'a', 'b', 'c'), path.join(base, 'shortcut'))
    const worktree = path.join(base, 'shortcut', 'real')
    const results = createSymlinks(configOf([linkOf('.claude/settings.local.json', 'aist-roadmap', '.claude/settings.local.json')]), root, worktree, ignoredDiagnostics)
    expect(results.map(result => result.action)).toEqual(['created'])
    const symlink = path.join(worktree, '.claude', 'settings.local.json')
    expect(readFileSync(symlink, 'utf8')).toBe('{}')
    const parent = realpathSync(path.dirname(symlink))
    expect(path.resolve(parent, readlinkSync(symlink))).toBe(path.join(realpathSync(root), 'base', 'aist-roadmap', '.claude', 'settings.local.json'))
  })

  it('親のパスがファイルでリンクを作成できない場合は、error とし、メッセージは Python の OSError と同じ文にする', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。リンクの親にあたるパスが通常のファイルの場合に、`error` と `[Errno 17] File exists` のメッセージを返し、警告も出力することを確認します。')
    const root = setupProject()
    const repository = path.join(root, 'wt1', 'myrepo')
    writeTree(repository, { sub: 'i am a file' })
    writeTree(path.join(root, 'base', 'shared'), { f: 'x' })
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('sub/file', 'shared', 'f')]), root, path.join(root, 'wt1', 'myrepo'), recorded.diagnostics)
    const message = `[Errno 17] File exists: '${path.join(repository, 'sub')}'`
    expect(results[0]).toMatchObject({ action: 'error', message })
    expect(recorded.lines).toEqual([`warning: failed to create the symlink: ${path.join(repository, 'sub', 'file')} -> ../../../base/shared/f: ${message}`])
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
  it('git が追跡しているファイルにはシンボリックリンクを作成せず、error にする', async () => {
    await explains('git の追跡対象を保護する `createSymlinks` のテストです。追跡されている `README.md` にリンクを作成しようとした場合に、`error` を返し、ファイルの内容が変わらず、警告を出力することを確認します。')
    const { root, repository } = setupTracked({ 'README.md': 'TRACKED-CANARY-12345' })
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('README.md', 'aist-roadmap', 'README.md')]), root, path.join(root, 'wt1', 'myrepo'), recorded.diagnostics)
    expect(results[0]).toMatchObject({ action: 'error', message: 'symlink creation aborted because the path is tracked by git: README.md' })
    expect(lstatSync(path.join(repository, 'README.md')).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(repository, 'README.md'), 'utf8')).toBe('TRACKED-CANARY-12345')
    expect(recorded.lines).toEqual([`warning: symlink creation skipped because the path is tracked by git: ${path.join(repository, 'README.md')}`])
  })

  it('git が追跡しているディレクトリにも、シンボリックリンクを作成しない', async () => {
    await explains('git の追跡対象を保護する `createSymlinks` のテストです。追跡されているディレクトリ `docs` にリンクを作成しようとした場合に、`error` を返し、ディレクトリと中身が変わらないことを確認します。')
    const { root, repository } = setupTracked({ 'docs/index.md': 'TRACKED-DIR-CANARY' })
    const recorded = recordDiagnostics()
    const results = createSymlinks(configOf([linkOf('docs', 'aist-roadmap', 'docs')]), root, path.join(root, 'wt1', 'myrepo'), recorded.diagnostics)
    expect(results[0]?.action).toBe('error')
    expect(lstatSync(path.join(repository, 'docs')).isDirectory()).toBe(true)
    expect(readFileSync(path.join(repository, 'docs', 'index.md'), 'utf8')).toBe('TRACKED-DIR-CANARY')
  })

  it('git が追跡していない通常のファイルには、シンボリックリンクを作成する', async () => {
    await explains('git の追跡対象を保護する `createSymlinks` のテストです。追跡されていない通常のファイルがある場合に、`created` を返し、シンボリックリンクに置き換わることを確認します。')
    const { root, repository } = setupTracked({ 'keep.md': 'x' })
    writeFileSync(path.join(repository, 'untracked.md'), 'local-only')
    const results = createSymlinks(configOf([linkOf('untracked.md', 'aist-roadmap', 'untracked.md')]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    expect(lstatSync(path.join(repository, 'untracked.md')).isSymbolicLink()).toBe(true)
  })

  it('git リポジトリではない場合は、追跡の確認をせずにシンボリックリンクを作成する', async () => {
    await explains('git の追跡対象を保護する `createSymlinks` のテストです。配置先が git リポジトリではない場合に、追跡を確認せず、`created` を返してリンクを作成することを確認します。')
    const root = path.join(makeTemporaryDirectory(), 'workspaces')
    writeTree(path.join(root, 'base', 'aist-roadmap'), { 'README.md': 'LINK-TARGET' })
    const repository = path.join(root, 'wt1', 'myrepo')
    writeTree(repository, { 'README.md': 'local-only' })
    const results = createSymlinks(configOf([linkOf('README.md', 'aist-roadmap', 'README.md')]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(results[0]?.action).toBe('created')
    expect(lstatSync(path.join(repository, 'README.md')).isSymbolicLink()).toBe(true)
  })

  it('git が存在しない場合は、追跡の確認をせずにシンボリックリンクを作成する', async () => {
    await explains('git の追跡対象を保護する `createSymlinks` のテストです。PATH 上に `git` が存在しない場合は、追跡を確認せず、`created` を返してリンクを作成することを確認します。')
    const { root, repository } = setupTracked({ 'README.md': 'TRACKED' })
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
    const results = createSymlinks(configOf([linkOf('README.md', 'aist-roadmap', 'README.md')]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
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
  it('confirm が OS のエラー以外の例外を送出した場合は、無視せずにそのまま送出する', async () => {
    await explains('確認つきでシンボリックリンクを作成する `createSymlinksSafe` のテストです。`confirm` が `TypeError` を送出した場合に、その例外（メッセージ `boom`）が呼び出し元まで発生することを確認します。')
    const { root } = setupRealFile()
    const options = {
      confirm: () => {
        throw new TypeError('boom')
      },
    }
    expect(() => createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics, options)).toThrow('boom')
  })

  it('force を指定した場合は、通常のファイルを上書きする', async () => {
    await explains('確認つきでシンボリックリンクを作成する `createSymlinksSafe` のテストです。`force: true` を指定した場合に、既存の通常のファイルをシンボリックリンクに置き換え、`created` を返すことを確認します。')
    const { root, existing } = setupRealFile()
    const results = createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics, { force: true })
    expect(results[0]?.action).toBe('created')
    expect(lstatSync(existing).isSymbolicLink()).toBe(true)
  })

  it('force と confirm のどちらも指定しない場合は、skipped とし、通常のファイルを残す', async () => {
    await explains('確認つきでシンボリックリンクを作成する `createSymlinksSafe` のテストです。`force` と `confirm` のどちらも指定しない場合に、`skipped` と `a real file exists` のメッセージを返し、ファイルがそのまま残ることを確認します。')
    const { root, existing } = setupRealFile()
    const results = createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(results[0]).toMatchObject({ action: 'skipped', message: `a real file exists: ${existing}` })
    expect(lstatSync(existing).isSymbolicLink()).toBe(false)
  })

  it('confirm が true を返した場合は上書きし、false を返した場合は残す。confirm にはパスを渡す', async () => {
    await explains('確認つきでシンボリックリンクを作成する `createSymlinksSafe` のテストです。`confirm` が `false` なら `skipped`、`true` なら `created` を返し、`confirm` には配置先とリンク先のパスが渡ることを確認します。')
    const { root, existing } = setupRealFile()
    const asked: (readonly string[])[] = []
    const denied = createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics, {
      confirm: (symlinkPath, targetPath) => {
        asked.push([symlinkPath, targetPath])
        return false
      },
    })
    expect(denied[0]?.action).toBe('skipped')
    const approved = createSymlinksSafe(configOf([CLAUDE_LOCAL]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics, { confirm: () => true })
    expect(approved[0]?.action).toBe('created')
    expect(asked).toEqual([[existing, path.join(root, 'base', 'aist-roadmap', 'CLAUDE.local.md')]])
  })
})

// 共有先にファイルがある既存の symlink を、path: 'shared/' の link で張り直す
function setupTrailingSlash(): { readonly root: string, readonly worktree: string, readonly sharedFile: string, readonly link: WorktreeConfig['links'][number] } {
  const root = setupProject()
  const sharedFile = path.join(root, 'base', 'aist-roadmap', 'shared', 'keep.txt')
  writeTree(path.join(root, 'base', 'aist-roadmap'), { 'shared/keep.txt': 'precious' })
  const worktree = path.join(root, 'wt1', 'myrepo')
  symlinkSync(path.join(root, 'base', 'aist-roadmap', 'shared'), path.join(worktree, 'shared'))
  return { root, worktree, sharedFile, link: linkOf('shared/', 'aist-roadmap', 'shared') }
}

describe('末尾が / の link.path（pathlib は末尾の / を落とす）', () => {
  it('末尾が / の path で既存のシンボリックリンクを指す場合は、planLink は update を返す', async () => {
    await explains('リンクの作成方法を判定する `planLink` のテストです。`path` が `shared/` のように `/` で終わり、配置先に既存のシンボリックリンクがある場合に、`update` を返すことを確認します。')
    const { root, worktree, link } = setupTrailingSlash()
    expect(planLink(link, root, worktree)).toBe('update')
  })

  it('force を指定しても、共有先の内容は削除せず、シンボリックリンクだけを張り替える', async () => {
    await explains('末尾が `/` の `path` を持つリンクを作成する `createSymlinksSafe` のテストです。`force: true` を指定した場合に、共有先のファイルが残り、シンボリックリンクだけが張り替わることを確認します。')
    const { root, worktree, sharedFile, link } = setupTrailingSlash()
    const results = createSymlinksSafe(configOf([link]), root, worktree, ignoredDiagnostics, { force: true })
    expect(results.map(result => result.action)).toEqual(['created'])
    expect(readFileSync(sharedFile, 'utf8')).toBe('precious')
    expect(lstatSync(path.join(worktree, 'shared')).isSymbolicLink()).toBe(true)
    expect(readFileSync(path.join(worktree, 'shared', 'keep.txt'), 'utf8')).toBe('precious')
  })

  it('confirm が true を返した場合でも、共有先の内容は削除しない', async () => {
    await explains('末尾が `/` の `path` を持つリンクを作成する `createSymlinksSafe` のテストです。`confirm` が `true` を返した場合でも、共有先のファイルが削除されないことを確認します。')
    const { root, worktree, sharedFile, link } = setupTrailingSlash()
    createSymlinksSafe(configOf([link]), root, worktree, ignoredDiagnostics, { confirm: () => true })
    expect(readFileSync(sharedFile, 'utf8')).toBe('precious')
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
  it('環境変数 CLAUDE_PLUGIN_ROOT を指定した場合は、その下のスクリプトのパスを返す', async () => {
    await explains('`.pecot/.gitignore` を生成するスクリプトを探す `pecotGitignoreEnsureScript` のテストです。環境変数 `CLAUDE_PLUGIN_ROOT` を指定した場合に、その下の `hooks/lib/core/pecot-gitignore-ensure.sh` のパスを返すことを確認します。')
    const pluginDirectory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PLUGIN_ROOT: pluginDirectory })
    expect(pecotGitignoreEnsureScript()).toBe(path.join(pluginDirectory, ENSURE_SCRIPT))
  })

  it('環境変数で指定した場所にスクリプトが存在しない場合でも、その場所の候補パスを返す', async () => {
    await explains('`.pecot/.gitignore` を生成するスクリプトを探す `pecotGitignoreEnsureScript` のテストです。`CLAUDE_PLUGIN_ROOT` の下にスクリプトが存在しない場合でも、その下のパスを返すことを確認します。')
    const pluginDirectory = makeTemporaryDirectory()
    setEnvironment({ CLAUDE_PLUGIN_ROOT: pluginDirectory })
    expect(pecotGitignoreEnsureScript()).toBe(path.join(pluginDirectory, ENSURE_SCRIPT))
  })

  it('スクリプトが存在しない場合は、環境変数で指定した場所の候補パスを警告に含める', async () => {
    await explains('`.pecot` の下のリンクを作成する `createSymlinks` のテストです。生成スクリプトが存在しない場合に、`generation script for .pecot/.gitignore not found` の警告に、探した候補のパスが含まれることを確認します。')
    const pluginDirectory = path.join(makeTemporaryDirectory(), 'plugin')
    setEnvironment({ CLAUDE_PLUGIN_ROOT: pluginDirectory })
    const { root, config } = setupPecotLinks()
    const recorded = recordDiagnostics()
    createSymlinks(config, root, path.join(root, 'wt1', 'myrepo'), recorded.diagnostics)
    expect(recorded.lines).toEqual([`warning: generation script for .pecot/.gitignore not found: ${path.join(pluginDirectory, ENSURE_SCRIPT)}`])
  })

  it('環境変数が指定されていない場合は、ソースツリーの plugin ルートにあるスクリプトのパスを返す', async () => {
    await explains('`.pecot/.gitignore` を生成するスクリプトを探す `pecotGitignoreEnsureScript` のテストです。環境変数を指定しない場合に、パスが `pecot-gitignore-ensure.sh` で終わり、そのファイルが実在して `#!` を含むことを確認します。')
    const resolved = pecotGitignoreEnsureScript()
    expect(resolved.endsWith(ENSURE_SCRIPT)).toBe(true)
    expect(readFileSync(resolved, 'utf8')).toContain('#!')
  })

  it('CLAUDE_PLUGIN_ROOT のスクリプトを、worktree を CLAUDE_PROJECT_DIR にして実行する', async () => {
    await explains('`.pecot` の下のリンクを作成する `createSymlinks` のテストです。生成スクリプトを実行した場合に、環境変数 `CLAUDE_PROJECT_DIR` が対象の worktree のパスになっていることを確認します。')
    const temporary = makeTemporaryDirectory()
    const marker = path.join(temporary, 'marker')
    const script = path.join(temporary, 'plugin', ENSURE_SCRIPT)
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, `#!/bin/bash\necho "$CLAUDE_PROJECT_DIR" > "${marker}"\n`)
    setEnvironment({ CLAUDE_PLUGIN_ROOT: path.join(temporary, 'plugin') })
    const { root, config, worktree } = setupPecotLinks()
    createSymlinks(config, root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(readFileSync(marker, 'utf8').trim()).toBe(worktree)
  })

  it('スクリプトが失敗しても、リンクの作成は続け、標準エラー出力を警告として出力する', async () => {
    await explains('`.pecot` の下のリンクを作成する `createSymlinks` のテストです。生成スクリプトが失敗しても、2 つのリンクが `created` になり、`could not generate .pecot/.gitignore: oops` を警告として出力することを確認します。')
    const temporary = makeTemporaryDirectory()
    const script = path.join(temporary, 'plugin', ENSURE_SCRIPT)
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, '#!/bin/bash\necho oops >&2\nexit 3\n')
    chmodSync(script, 0o755)
    setEnvironment({ CLAUDE_PLUGIN_ROOT: path.join(temporary, 'plugin') })
    const { root, config } = setupPecotLinks()
    const recorded = recordDiagnostics()
    const results = createSymlinks(config, root, path.join(root, 'wt1', 'myrepo'), recorded.diagnostics)
    expect(results.map(result => result.action)).toEqual(['created', 'created'])
    expect(recorded.lines).toEqual(['warning: could not generate .pecot/.gitignore: oops'])
  })

  it('bash が存在しない場合は、OsError を送出する', async () => {
    await explains('`.pecot` の下のリンクを作成する `createSymlinks` のテストです。PATH 上に `bash` が存在しない場合は、`OsError` が発生することを確認します。')
    const { root, config } = setupPecotLinks()
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nobash-') })
    expect(() => createSymlinks(config, root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)).toThrow(OsError)
  })
})

describe('.pecot/ 配下の link を張ると WT に .pecot/.gitignore が実ファイルでき、未追跡が出ない（#1219）', () => {
  it('createSymlinks は、.pecot/.gitignore を通常のファイルとして作成する', async () => {
    await explains('`.pecot` の下のリンクを作成する `createSymlinks` のテストです。`.pecot/.gitignore` がシンボリックリンクではなく通常のファイルとして作成され、`git status` に未追跡のファイルが表示されないことを確認します。')
    const { root, config, worktree } = setupPecotLinks()
    createSymlinks(config, root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    const gitignore = path.join(worktree, '.pecot', '.gitignore')
    expect(lstatSync(gitignore).isFile()).toBe(true)
    expect(lstatSync(gitignore).isSymbolicLink()).toBe(false)
    expect(gitForTest(worktree, ['status', '--porcelain'])).toBe('')
  })

  it('createSymlinksSafe も、.pecot/.gitignore を通常のファイルとして作成する', async () => {
    await explains('`.pecot` の下のリンクを作成する `createSymlinksSafe` のテストです。`.pecot/.gitignore` が通常のファイルとして作成され、`git status` に未追跡のファイルが表示されないことを確認します。')
    const { root, config, worktree } = setupPecotLinks()
    createSymlinksSafe(config, root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
    expect(lstatSync(path.join(worktree, '.pecot', '.gitignore')).isFile()).toBe(true)
    expect(gitForTest(worktree, ['status', '--porcelain'])).toBe('')
  })

  it('.pecot の下のリンクが存在しない場合は、.pecot ディレクトリを作成しない', async () => {
    await explains('シンボリックリンクを作成する `createSymlinks` のテストです。`.pecot` の下にリンクを作成しない設定の場合に、worktree に `.pecot` ディレクトリが作成されないことを確認します。')
    const root = setupProject()
    createSymlinks(configOf([CLAUDE_LOCAL]), root, path.join(root, 'wt1', 'myrepo'), ignoredDiagnostics)
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
  it('.worktreeignore が存在しない場合は、WorktreeConfigError を送出する', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。`.worktreeignore` が存在しない場合は、`WorktreeConfigError` が発生し、`pecot worktree init` の案内を含むことを確認します。')
    const main = makeTemporaryDirectory()
    expect(() => loadCopyExcludeSpec(main, ignoredDiagnostics)).toThrow(WorktreeConfigError)
    expect(() => loadCopyExcludeSpec(main, ignoredDiagnostics)).toThrow(`copy exclude config not found: ${WORKTREE_IGNORE_FILENAME}\n  run pecot worktree init to generate the template`)
  })

  it('基本的な gitignore のパターンに一致するファイルを、除外の対象にする', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。`.git/`・`__pycache__/`・`*.pyc` のパターンを指定した場合に、それらに一致するファイルは除外の対象になり、`README.md` は対象にならないことを確認します。')
    const main = makeTemporaryDirectory()
    writeIgnore(main, '.git/\n__pycache__/\n*.pyc\n')
    const spec = loadCopyExcludeSpec(main, ignoredDiagnostics)
    expect(spec.matchFile('.git/config')).toBe(true)
    expect(spec.matchFile('__pycache__/foo.pyc')).toBe(true)
    expect(spec.matchFile('mod.pyc')).toBe(true)
    expect(spec.matchFile('README.md')).toBe(false)
  })

  it('空行と # で始まるコメント行は、パターンとして扱わない', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。空行とコメント行を含む `.worktreeignore` でも、有効な `.git/` と `*.pyc` のパターンだけが除外の対象になることを確認します。')
    const main = makeTemporaryDirectory()
    writeIgnore(main, '# header comment\n\n.git/\n# another comment\n\n*.pyc\n')
    const spec = loadCopyExcludeSpec(main, ignoredDiagnostics)
    expect(spec.matchFile('.git/HEAD')).toBe(true)
    expect(spec.matchFile('foo.pyc')).toBe(true)
    expect(spec.matchFile('foo.md')).toBe(false)
  })

  it('否定パターンで除外から外したパスは対象にせず、それ以外は除外の対象にする', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。`.nx/` を除外して `!.nx/version-plans/` で戻した場合に、`.nx/version-plans/` の下のファイルだけを除外しないことを確認します。')
    const main = makeTemporaryDirectory()
    writeIgnore(main, '.nx/\n!.nx/version-plans/\n')
    const spec = loadCopyExcludeSpec(main, ignoredDiagnostics)
    expect(spec.matchFile('.nx/workspace-data/cache.db')).toBe(true)
    expect(spec.matchFile('.nx/version-plans/my-plan.md')).toBe(false)
  })

  it('DEFAULT_WORKTREEIGNORE_CONTENT をそのまま読み込め、警告は出力されない', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。既定の内容を読み込んだ場合に、`.git/config` や `node_modules/pkg/index.js` などが除外の対象になり、警告が出力されないことを確認します。')
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

  it('空の .worktreeignore は、何も除外せず、警告も出力しない', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。内容が空の `.worktreeignore` を読み込んだ場合に、どのファイルも除外の対象にならず、警告が出力されないことを確認します。')
    const main = makeTemporaryDirectory()
    writeIgnore(main, '')
    const recorded = recordDiagnostics()
    const spec = loadCopyExcludeSpec(main, recorded.diagnostics)
    expect(spec.matchFile('.git/config')).toBe(false)
    expect(spec.matchFile('src/main.py')).toBe(false)
    expect(recorded.lines).toEqual([])
  })

  it('有効な行があるのに、どのファイルにも一致しないパターンしかない場合は、警告を出力する', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。`/` だけの行のように一致しうるパターンがない場合に、`all patterns in <パス> are invalid` の警告を出力することを確認します。')
    const main = makeTemporaryDirectory()
    const file = writeIgnore(main, '# comment\n\n/\n   \n')
    const recorded = recordDiagnostics()
    const spec = loadCopyExcludeSpec(main, recorded.diagnostics)
    expect(spec.matchFile('anything')).toBe(false)
    expect(recorded.lines).toEqual([`warning: all patterns in ${file} are invalid (1 effective lines silently ignored): check the gitignore syntax`])
  })

  it('コメントと空行だけの場合（有効な行が 0 件の場合）は、警告を出力しない', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。コメント行と空行だけの `.worktreeignore` を読み込んだ場合に、どのファイルも除外の対象にならず、警告が出力されないことを確認します。')
    const main = makeTemporaryDirectory()
    writeIgnore(main, '# c1\n\n# c2\n\n')
    const recorded = recordDiagnostics()
    expect(loadCopyExcludeSpec(main, recorded.diagnostics).matchFile('.git/config')).toBe(false)
    expect(recorded.lines).toEqual([])
  })

  it('Python の splitlines と同じ文字（垂直タブ・改ページ・U+2028）でも、行を分割する', async () => {
    await explains('コピーの除外設定を読み込む `loadCopyExcludeSpec` のテストです。垂直タブ・改ページ・`U+2028` で区切った `a` から `d` の 4 つのパターンが、それぞれ別の行として扱われることを確認します。')
    const main = makeTemporaryDirectory()
    writeIgnore(main, 'a\vb\fc\u{2028}d')
    const spec = loadCopyExcludeSpec(main, ignoredDiagnostics)
    expect(['a', 'b', 'c', 'd', 'e'].map(name => spec.matchFile(name))).toEqual([true, true, true, true, false])
  })
})

describe('decideOverwrite', () => {
  it.for([
    { name: '--force', force: true, allWorktrees: false, expected: { force: true, ask: false } },
    { name: '--force と --all', force: true, allWorktrees: true, expected: { force: true, ask: false } },
    { name: '単独の worktree', force: false, allWorktrees: false, expected: { force: false, ask: true } },
    { name: '--all', force: false, allWorktrees: true, expected: { force: false, ask: false } },
  ])('$name の場合は、上書きの確認方法（force と ask）を返す', async (row) => {
    await explains('上書きの確認方法を決める `decideOverwrite` のテストです。`--force` や `--all` の指定の組み合わせごとに、`force` と `ask` の期待どおりの値を返すことを確認します。')
    expect(decideOverwrite({ force: row.force, allWorktrees: row.allWorktrees })).toEqual(row.expected)
  })
})

function plan(root: string, link: WorktreeConfig['links'][number], decision: Parameters<typeof planLink>[3] = {}): LinkPlan {
  return planLink(link, root, path.join(root, 'wt1', 'myrepo'), decision)
}

describe('planLink', () => {
  it('リンク先が存在しない場合は、skip-missing を返す', async () => {
    await explains('リンクの作成方法を判定する `planLink` のテストです。リンク先が存在しない場合に、`skip-missing` を返すことを確認します。')
    expect(plan(setupProject(), linkOf('x', 'aist-roadmap', 'nothing'))).toBe('skip-missing')
  })

  it('リンク先がリンク切れのシンボリックリンクの場合は、skip-dangling を返す', async () => {
    await explains('リンクの作成方法を判定する `planLink` のテストです。リンク先が、指す先が存在しないシンボリックリンクの場合に、`skip-dangling` を返すことを確認します。')
    const root = setupProject()
    symlinkSync('/nonexistent-target', path.join(root, 'base', 'aist-roadmap', 'dangling.md'))
    expect(plan(root, linkOf('x', 'aist-roadmap', 'dangling.md'))).toBe('skip-dangling')
  })

  it('配置先に何も存在しない場合は、create を返す', async () => {
    await explains('リンクの作成方法を判定する `planLink` のテストです。配置先にファイルとリンクのどちらも存在しない場合は、`create` を返すことを確認します。')
    expect(plan(setupProject(), CLAUDE_LOCAL)).toBe('create')
  })

  it('配置先にシンボリックリンクが存在する場合は、update を返す', async () => {
    await explains('リンクの作成方法を判定する `planLink` のテストです。配置先に既存のシンボリックリンクが存在する場合に、`update` を返すことを確認します。')
    const root = setupProject()
    symlinkSync('/anywhere', path.join(root, 'wt1', 'myrepo', 'CLAUDE.local.md'))
    expect(plan(root, CLAUDE_LOCAL)).toBe('update')
  })

  it('配置先に通常のファイルが存在する場合は、決め方に応じて update・ask・skip-real-file を返す', async () => {
    await explains('リンクの作成方法を判定する `planLink` のテストです。配置先に通常のファイルが存在する場合に、`force` なら `update`、`ask` なら `ask`、指定なしなら `skip-real-file` を返すことを確認します。')
    const { root } = setupRealFile()
    expect([plan(root, CLAUDE_LOCAL, { force: true }), plan(root, CLAUDE_LOCAL, { ask: true }), plan(root, CLAUDE_LOCAL)]).toEqual(['update', 'ask', 'skip-real-file'])
  })

  it('配置先のファイルを git が追跡している場合は、force を指定しても skip-tracked を返す', async () => {
    await explains('リンクの作成方法を判定する `planLink` のテストです。配置先の通常のファイルを git が追跡している場合に、`force` を指定しても `skip-tracked` を返すことを確認します。')
    const root = setupProject()
    const worktree = path.join(root, 'wt1', 'myrepo')
    createGitRepository({ 'CLAUDE.local.md': 'tracked' }, worktree)
    expect(plan(root, CLAUDE_LOCAL, { force: true })).toBe('skip-tracked')
  })
})

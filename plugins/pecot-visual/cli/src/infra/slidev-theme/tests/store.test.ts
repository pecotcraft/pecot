// infra/slidev-theme/store.ts の test（T020）。
//
// 実 git と実 pnpm で、テーマの置き場への取得を通して見る。
// 取得元はローカルの bare リポジトリ（`git+file://`）。
// テーマの依存は fixture の theme-only-dep を絶対パスの `file:` で指す。fixture 自体は変えない。
// 認証の失敗はローカルで再現できないため、store-layout の unit test が stderr の分類を固定する。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp の一時ディレクトリ配下と追跡ファイルだけ */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SpawnResult } from '../../../domain/_shared/spawn-result.js'
import type { ThemeSpec } from '../../../domain/slidev-theme/theme-spec.js'
import { ThemeFetchError, themeStoreDirectory } from '../../../domain/slidev-theme/store-layout.js'
import { LOCK_CONFLICT_EXIT_CODE } from '../../_shared/flock.js'
import { spawnPromise } from '../../_shared/process.js'
import { seedDependencyRoot } from '../../../../tests/_helpers/dependency-probes.js'
import { useTemporaryDirectory } from '../../../../tests/_helpers/temporary-directory.js'
import { fetchTheme, type ThemeStoreRunner } from '../store.js'

// src/infra/slidev-theme/tests → cli/
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const DEPENDENCY_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'themes', 'theme-only-dep')
const THEME_NAME = 'pecotv-test-theme-store'
const PATCHED_MARK = '// patched by test'

const temporaryRoot = useTemporaryDirectory('pecotv-theme-store-', { hook: 'all', resolveRealPath: true })

afterAll(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) Reflect.deleteProperty(environment, name)
  return environment
}

function git(cwd: string, ...arguments_: readonly string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...arguments_],
    { cwd, env: gitEnvironment(), stdio: 'pipe' },
  )
}

/**
テーマのソースを作り、タグ付きの bare リポジトリにして `git+file://` の spec を返す。
dependency は package.json の依存先（`file:` の値）。patches/ は theme-only-dep の 1 行を置換する。
*/
function createThemeRepository(name: string, dependency: string, themeName = THEME_NAME, dependencyName = 'pecotv-test-theme-dep'): ThemeSpec & { kind: 'git' } {
  const source = temporaryRoot(`${name}-src`)
  mkdirSync(path.join(source, 'patches'), { recursive: true })
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: themeName,
    version: '1.0.0',
    private: true,
    dependencies: { [dependencyName]: dependency },
  }), 'utf8')
  writeFileSync(path.join(source, 'patches', 'pecotv-test-theme-dep+0.0.0.patch'), [
    'diff --git a/node_modules/pecotv-test-theme-dep/index.js b/node_modules/pecotv-test-theme-dep/index.js',
    'index 1111111..2222222 100644',
    '--- a/node_modules/pecotv-test-theme-dep/index.js',
    '+++ b/node_modules/pecotv-test-theme-dep/index.js',
    '@@ -1 +1 @@',
    '-import { computed, ref } from \'vue\'',
    `+import { computed, ref } from 'vue' ${PATCHED_MARK}`,
    '',
  ].join('\n'), 'utf8')
  git(source, 'init', '-q')
  git(source, 'add', '-A')
  git(source, 'commit', '-q', '-m', 'theme')
  git(source, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0')
  const bare = temporaryRoot(`${name}.git`)
  git(temporaryRoot(), 'clone', '-q', '--bare', source, bare)
  return { kind: 'git', url: `file://${bare}`, tag: 'v1.0.0' }
}

function countingRunner(): { readonly runner: ThemeStoreRunner, readonly calls: string[] } {
  const calls: string[] = []
  const runner: ThemeStoreRunner = async (command, commandArguments, options) => {
    calls.push([command, ...commandArguments].join(' '))
    return spawnPromise(command, commandArguments, options)
  }
  return { runner, calls }
}

// pnpm install の呼び出しが受け取った NODE_EXTRA_CA_CERTS を received へ記録する runner。
function environmentRecordingRunner(received: (string | undefined)[]): ThemeStoreRunner { // eslint-disable-line @typescript-eslint/prefer-readonly-parameter-types -- 記録先の配列へ push する
  return async (command, commandArguments, runnerOptions) => {
    if (!isGitCommand(command, commandArguments) && !isPatchCommand(commandArguments) && commandArguments.includes('install')) {
      received.push(runnerOptions.env?.['NODE_EXTRA_CA_CERTS'])
    }
    return spawnPromise(command, commandArguments, runnerOptions)
  }
}

function storeRootFor(name: string): string {
  return temporaryRoot(`${name}-store`)
}

function optionsFor(name: string, extra: Readonly<{ runner?: ThemeStoreRunner, warn?: (message: string) => void }> = {}): Parameters<typeof fetchTheme>[1] {
  return {
    storeRoot: storeRootFor(name),
    baseDirectory: temporaryRoot(),
    dependencyRoot: temporaryRoot('deps'),
    ...extra,
  }
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- 警告を積む配列
function collect(target: string[]): (message: string) => void {
  return (message) => {
    target.push(message)
  }
}

function hashDirectoryOf(packageDirectory: string): string {
  return path.dirname(path.dirname(packageDirectory))
}

function entries(directory: string): readonly string[] {
  return existsSync(directory) ? readdirSync(directory) : []
}

function hashDirectoryFor(storeRoot: string, spec: Readonly<{ url: string, tag: string }>): string {
  return path.dirname(themeStoreDirectory(storeRoot, spec))
}

function isGitCommand(command: string, commandArguments: readonly string[]): boolean {
  return command === 'git' || commandArguments.includes('git')
}

function isPatchCommand(commandArguments: readonly string[]): boolean {
  return commandArguments.includes('--patch-dir')
}

// eslint-disable-next-line unicorn/no-null -- SpawnResult は終了シグナル無しを signal: null で表す
const STOPPED: Omit<SpawnResult, 'exitCode' | 'timedOut'> = { signal: null, stdout: '', stderr: '' }
const LOCK_CONFLICT: SpawnResult = { ...STOPPED, exitCode: LOCK_CONFLICT_EXIT_CODE, timedOut: false }
// eslint-disable-next-line unicorn/no-null -- SpawnResult は時間切れと起動失敗を exitCode: null で表す
const TIMED_OUT: SpawnResult = { ...STOPPED, exitCode: null, timedOut: true }
// eslint-disable-next-line unicorn/no-null -- 同上
const NOT_STARTED: SpawnResult = { ...STOPPED, exitCode: null, timedOut: false }

/**
isTarget に当たる呼び出しだけ result に差し替え、他は実プロセスで動かす runner。
*/
function replacingRunner(
  isTarget: (command: string, commandArguments: readonly string[]) => boolean,
  result: Readonly<SpawnResult>,
): ThemeStoreRunner {
  return async (command, commandArguments, options) =>
    isTarget(command, commandArguments) ? result : spawnPromise(command, commandArguments, options)
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error: unknown) {
    return error
  }
  return undefined
}

// 取得元の bare リポジトリはファイルで 1 回だけ作る（temporaryRoot は beforeAll で作られるため、その中で作る）。
const created: (ThemeSpec & { kind: 'git' })[] = []

beforeAll(() => {
  seedDependencyRoot(temporaryRoot('deps'))
  created.push(createThemeRepository('ok', `file:${DEPENDENCY_FIXTURE}`))
})

function okSpec(): ThemeSpec & { kind: 'git' } {
  const [first] = created
  if (first === undefined) throw new Error('beforeAll で取得元を作ってから呼ぶこと')
  return first
}

describe('fetchTheme（git）', () => {
  it('タグを取得し、依存を入れ、patch を当てて、stamp を書く', async () => {
    const options = optionsFor('fetch')
    const result = await fetchTheme(okSpec(), options)

    const storeDirectory = themeStoreDirectory(options.storeRoot, okSpec())
    expect(result).toEqual({ name: THEME_NAME, directory: path.join(storeDirectory, 'package'), reused: false })

    const installed = readFileSync(path.join(result.directory, 'node_modules', 'pecotv-test-theme-dep', 'index.js'), 'utf8')
    expect(installed.split('\n', 1)[0]).toBe(`import { computed, ref } from 'vue' ${PATCHED_MARK}`)
    expect(readFileSync(path.join(DEPENDENCY_FIXTURE, 'index.js'), 'utf8')).not.toContain(PATCHED_MARK)
    expect(existsSync(path.join(result.directory, 'node_modules', 'vue'))).toBe(false)
    expect(existsSync(path.join(result.directory, '.git'))).toBe(false)

    const stamp: unknown = JSON.parse(readFileSync(path.join(storeDirectory, 'stamp.json'), 'utf8'))
    expect(stamp).toMatchObject({ spec: { url: okSpec().url, tag: 'v1.0.0' } })
    expect(JSON.stringify(stamp)).toMatch(/"inputsHash":"[0-9a-f]{64}"/u)
    expect(entries(path.dirname(storeDirectory)).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('patch の当たった木は、元のディレクトリや pnpm の store と hard link を共有しない', async () => {
    const result = await fetchTheme(okSpec(), optionsFor('links'))
    expect(statSync(path.join(result.directory, 'node_modules', 'pecotv-test-theme-dep', 'index.js')).nlink).toBe(1)
  })

  it('2 回目は stamp で再利用し、子プロセスを 1 つも起こさない', async () => {
    const options = optionsFor('reuse')
    await fetchTheme(okSpec(), options)

    const counting = countingRunner()
    const second = await fetchTheme(okSpec(), { ...options, runner: counting.runner })
    expect(second.reused).toBe(true)
    expect(second.name).toBe(THEME_NAME)
    expect(counting.calls).toEqual([])
  })

  it('node_modules を消された置き場は取得済みとせず、取り直す', async () => {
    const options = optionsFor('broken')
    const first = await fetchTheme(okSpec(), options)
    rmSync(path.join(first.directory, 'node_modules'), { recursive: true, force: true })

    const counting = countingRunner()
    const second = await fetchTheme(okSpec(), { ...options, runner: counting.runner })
    expect(second.reused).toBe(false)
    expect(counting.calls.length).toBeGreaterThan(0)
    expect(existsSync(path.join(second.directory, 'node_modules', '.modules.yaml'))).toBe(true)
  })

  it('patch を書き換えられた置き場は取得済みとせず、取り直す', async () => {
    const options = optionsFor('tampered')
    const first = await fetchTheme(okSpec(), options)
    writeFileSync(path.join(first.directory, 'patches', 'pecotv-test-theme-dep+0.0.0.patch'), 'changed\n', 'utf8')

    const second = await fetchTheme(okSpec(), options)
    expect(second.reused).toBe(false)
    expect(readFileSync(path.join(second.directory, 'node_modules', 'pecotv-test-theme-dep', 'index.js'), 'utf8')).toContain(PATCHED_MARK)
  })

  it('同じ置き場への同時の取得は、どちらも成功して同じ置き場を返す', async () => {
    const options = optionsFor('concurrent')
    const [left, right] = await Promise.all([fetchTheme(okSpec(), options), fetchTheme(okSpec(), options)])
    expect(left.directory).toBe(right.directory)
    expect(existsSync(path.join(left.directory, 'node_modules', '.modules.yaml'))).toBe(true)
    expect(entries(hashDirectoryOf(left.directory)).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('利用者の NODE_EXTRA_CA_CERTS をそのまま pnpm に渡し、未設定なら足さない', async () => {
    // pecot は証明書を同梱しない。プロキシの CA は利用者が NODE_EXTRA_CA_CERTS で渡す。
    const received: (string | undefined)[] = []
    const runner = environmentRecordingRunner(received)

    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/etc/ssl/corp.pem')
    await fetchTheme(okSpec(), optionsFor('ca-preset', { runner }))
    vi.stubEnv('NODE_EXTRA_CA_CERTS', undefined)
    await fetchTheme(okSpec(), optionsFor('ca-unset', { runner }))

    expect(received).toEqual(['/etc/ssl/corp.pem', undefined])
  })

  it('別の取得が pnpm の前に置き終えていたら、pnpm と patch を起こさず再利用する', async () => {
    const options = optionsFor('placed-first-pnpm')
    const calls: string[] = []
    let isRacing = true
    const runner: ThemeStoreRunner = async (command, commandArguments, runnerOptions) => {
      calls.push([command, ...commandArguments].join(' '))
      if (isRacing) {
        isRacing = false
        await fetchTheme(okSpec(), options)
      }
      return spawnPromise(command, commandArguments, runnerOptions)
    }

    const result = await fetchTheme(okSpec(), { ...options, runner })
    expect(result).toMatchObject({ name: THEME_NAME, reused: true })
    expect(calls.filter(call => call.includes(' install '))).toEqual([])
    expect(entries(hashDirectoryOf(result.directory)).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('別の取得が patch の前に置き終えていたら、patch を当てずに再利用する', async () => {
    const options = optionsFor('placed-first-patch')
    const calls: string[] = []
    let isRacing = true
    const runner: ThemeStoreRunner = async (command, commandArguments, runnerOptions) => {
      calls.push([command, ...commandArguments].join(' '))
      if (isRacing && !isGitCommand(command, commandArguments)) {
        isRacing = false
        await fetchTheme(okSpec(), options)
      }
      return spawnPromise(command, commandArguments, runnerOptions)
    }

    const result = await fetchTheme(okSpec(), { ...options, runner })
    expect(result.reused).toBe(true)
    expect(calls.filter(call => call.includes('--patch-dir'))).toEqual([])
  })

  it('クラッシュで残った古い一時ディレクトリを掃除し、新しいものは残す', async () => {
    const options = optionsFor('stale')
    const hashDirectory = path.dirname(themeStoreDirectory(options.storeRoot, okSpec()))
    const stale = path.join(hashDirectory, '.v1.0.0.tmp-stale1')
    const fresh = path.join(hashDirectory, '.v1.0.0.tmp-fresh1')
    mkdirSync(stale, { recursive: true })
    mkdirSync(fresh, { recursive: true })
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)

    await fetchTheme(okSpec(), options)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('本体と同名の依存があれば、peerDependencies への移動を促す警告を出す', async () => {
    const dependencyRoot = temporaryRoot('deps-overlap')
    seedDependencyRoot(dependencyRoot, ['pecotv-test-theme-dep'])
    const warnings: string[] = []
    await fetchTheme(okSpec(), { ...optionsFor('overlap'), dependencyRoot, warn: collect(warnings) })

    expect(warnings).toHaveLength(1)
    expect(warnings.join('\n')).toContain('pecotv-test-theme-dep')
    expect(warnings.join('\n')).toContain('peerDependencies')
    // 接頭辞は受け取り側（create・sync）が付ける。ここで付けると二重に出る。
    expect(warnings[0]).not.toMatch(/^\[warn\]/u)
  })

  it('テーマが宣言していない推移依存は、本体と同名でも警告しない', async () => {
    const wrapper = temporaryRoot('wrapper-dep')
    mkdirSync(wrapper, { recursive: true })
    writeFileSync(path.join(wrapper, 'package.json'), JSON.stringify({
      name: 'pecotv-test-theme-wrapper',
      version: '1.0.0',
      dependencies: { 'pecotv-test-theme-dep': `file:${DEPENDENCY_FIXTURE}` },
    }), 'utf8')
    const spec = createThemeRepository('transitive', `file:${wrapper}`, THEME_NAME, 'pecotv-test-theme-wrapper')
    const dependencyRoot = temporaryRoot('deps-transitive')
    seedDependencyRoot(dependencyRoot, ['pecotv-test-theme-dep'])
    const warnings: string[] = []
    const result = await fetchTheme(spec, { ...optionsFor('transitive'), dependencyRoot, warn: collect(warnings) })

    // 推移依存が平坦化されて package/node_modules 直下にあっても、宣言していなければ警告しない。
    expect(existsSync(path.join(result.directory, 'node_modules', 'pecotv-test-theme-dep'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('同名の依存が無ければ警告しない', async () => {
    const warnings: string[] = []
    await fetchTheme(okSpec(), { ...optionsFor('no-overlap'), warn: collect(warnings) })
    expect(warnings).toEqual([])
  })
})

describe('fetchTheme（失敗）', () => {
  it('タグが無ければ tag で失敗し、置き場に何も残さない', async () => {
    const options = optionsFor('no-tag')
    const error = await failureOf(fetchTheme({ ...okSpec(), tag: 'v9.9.9' }, options))

    expect(error).toBeInstanceOf(ThemeFetchError)
    expect(error).toMatchObject({ reason: 'tag' })
    expect(error instanceof Error && error.message).toContain('v9.9.9')
    const hashDirectory = hashDirectoryFor(options.storeRoot, { ...okSpec(), tag: 'v9.9.9' })
    expect(existsSync(hashDirectory)).toBe(false)
  })

  it('別のタグが取得済みの階層では、失敗しても取得済みを残す', async () => {
    const options = optionsFor('failure-beside-ready')
    const ready = await fetchTheme(okSpec(), options)
    await failureOf(fetchTheme({ ...okSpec(), tag: 'v9.9.9' }, options))

    expect(existsSync(path.join(ready.directory, 'package.json'))).toBe(true)
    expect(entries(hashDirectoryOf(ready.directory)).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('接続できなければ connection で失敗する', async () => {
    // プロキシ経由だと stderr がプロキシの応答になり、分類が変わる。
    for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) vi.stubEnv(name, '')
    vi.stubEnv('NO_PROXY', '127.0.0.1')
    const error = await failureOf(fetchTheme({ kind: 'git', url: 'https://127.0.0.1:1/x/y.git', tag: 'v1.0.0' }, optionsFor('no-connection')))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'connection' })
  })

  it('依存の install に失敗すれば install で失敗する。タグのディレクトリと stamp は残さない', async () => {
    const broken = createThemeRepository('broken-dependency', `file:${temporaryRoot('does-not-exist')}`)
    const options = optionsFor('install-failure')
    const error = await failureOf(fetchTheme(broken, options))

    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install' })
    expect(existsSync(hashDirectoryFor(options.storeRoot, broken))).toBe(false)
  })

  it('name がパッケージ名として使えなければ、pnpm の前に unknown で止める', async () => {
    const invalid = createThemeRepository('invalid-name', `file:${DEPENDENCY_FIXTURE}`, '../escape')
    const counting = countingRunner()
    const error = await failureOf(fetchTheme(invalid, optionsFor('invalid-name', { runner: counting.runner })))

    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'unknown' })
    expect(error instanceof Error && error.message).toContain('../escape')
    expect(counting.calls.filter(call => call.includes(' install '))).toEqual([])
  })
})

// 各段の子プロセスが、ロック待ちの超過・時間切れ・起動失敗で終わったときの、対処付きの失敗。
const STAGES: readonly (readonly [string, (command: string, commandArguments: readonly string[]) => boolean, 'connection' | 'install'])[] = [
  ['git', isGitCommand, 'connection'],
  ['pnpm', (command, commandArguments) => !isGitCommand(command, commandArguments) && !isPatchCommand(commandArguments), 'install'],
  ['patch-package', (_command, commandArguments) => isPatchCommand(commandArguments), 'install'],
]

describe.each(STAGES)('fetchTheme（%s の段の子プロセス失敗）', (stage, isTarget, timedOutReason) => {
  it('ロック待ちの超過は、別プロセスの取得中として案内する', async () => {
    const options = optionsFor(`lock-${stage}`, { runner: replacingRunner(isTarget, LOCK_CONFLICT) })
    const error = await failureOf(fetchTheme(okSpec(), options))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install' })
    expect(error instanceof Error && error.message).toContain('another process is fetching the same theme')
  })

  it('時間切れは、時間切れとして案内する', async () => {
    const options = optionsFor(`timeout-${stage}`, { runner: replacingRunner(isTarget, TIMED_OUT) })
    const error = await failureOf(fetchTheme(okSpec(), options))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: timedOutReason })
    expect(error instanceof Error && error.message).toContain('timed out')
  })

  it('起動できなければ、導入の確認を案内する', async () => {
    const options = optionsFor(`start-${stage}`, { runner: replacingRunner(isTarget, NOT_STARTED) })
    const error = await failureOf(fetchTheme(okSpec(), options))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install' })
    expect(error instanceof Error && error.message).toContain('check that it is installed')
  })
})

function writeFileTheme(name: string, dependencies: Readonly<Record<string, string>>): string {
  const directory = temporaryRoot('base', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '0.0.0', dependencies }), 'utf8')
  return directory
}

describe('fetchTheme（git の例外）', () => {
  it('package.json が無いリポジトリは install で失敗する', async () => {
    const source = temporaryRoot('no-manifest-src')
    mkdirSync(source, { recursive: true })
    writeFileSync(path.join(source, 'README.md'), 'x', 'utf8')
    git(source, 'init', '-q')
    git(source, 'add', '-A')
    git(source, 'commit', '-q', '-m', 'x')
    git(source, 'tag', 'v1.0.0')
    const bare = temporaryRoot('no-manifest.git')
    git(temporaryRoot(), 'clone', '-q', '--bare', source, bare)

    const error = await failureOf(fetchTheme({ kind: 'git', url: `file://${bare}`, tag: 'v1.0.0' }, optionsFor('no-manifest')))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install' })
    expect(error instanceof Error && error.message).toContain('has no package.json')
  })

  it('取得中に先客の置き場が無効なら、消して置き直す', async () => {
    const options = optionsFor('rename-conflict')
    const target = themeStoreDirectory(options.storeRoot, okSpec())
    const racing: ThemeStoreRunner = async (command, commandArguments, runnerOptions) => {
      if (commandArguments.includes('fetch')) {
        // 取得の途中で、stamp の無い置き場が先に置かれた状態を作る。
        mkdirSync(target, { recursive: true })
        writeFileSync(path.join(target, 'leftover'), 'x', 'utf8')
      }
      return spawnPromise(command, commandArguments, runnerOptions)
    }

    const result = await fetchTheme(okSpec(), { ...options, runner: racing })
    expect(result).toMatchObject({ name: THEME_NAME, reused: false })
    expect(existsSync(path.join(target, 'leftover'))).toBe(false)
    expect(existsSync(path.join(target, 'package', 'node_modules', '.modules.yaml'))).toBe(true)
    expect(entries(path.dirname(target)).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('rename の時点で別の取得が有効な置き場を置いていたら、それを再利用する', async () => {
    const options = optionsFor('rename-adopt')
    const racing: ThemeStoreRunner = async (command, commandArguments, runnerOptions) => {
      const result = await spawnPromise(command, commandArguments, runnerOptions)
      // patch の後（最後の子プロセスの後）に、別の取得が置き終える。
      if (isPatchCommand(commandArguments)) await fetchTheme(okSpec(), options)
      return result
    }
    const result = await fetchTheme(okSpec(), { ...options, runner: racing })
    expect(result.reused).toBe(true)
  })

  it('本体の node_modules を読めなくても、警告を出さずに取得できる', async () => {
    const warnings: string[] = []
    const noNodeModules = temporaryRoot('deps-without-node-modules')
    mkdirSync(noNodeModules, { recursive: true })
    await fetchTheme(okSpec(), { ...optionsFor('base-missing'), dependencyRoot: noNodeModules, warn: collect(warnings) })
    expect(warnings).toEqual([])
  })

  it('本体の scope ディレクトリを読めなくても、取得できる', async () => {
    const dependencyRoot = temporaryRoot('deps-broken-scope')
    mkdirSync(path.join(dependencyRoot, 'node_modules'), { recursive: true })
    writeFileSync(path.join(dependencyRoot, 'node_modules', '@broken'), 'file', 'utf8')
    const warnings: string[] = []
    await fetchTheme(okSpec(), { ...optionsFor('scope-broken'), dependencyRoot, warn: collect(warnings) })
    expect(warnings).toEqual([])
  })
})

describe('fetchTheme（file）', () => {
  it('baseDirectory からの相対で実体を指す。install と stamp は行わない', async () => {
    writeFileTheme('file-theme', {})
    const counting = countingRunner()
    const options = optionsFor('file', { runner: counting.runner })
    const result = await fetchTheme({ kind: 'file', path: './file-theme' }, { ...options, baseDirectory: temporaryRoot('base') })

    expect(result).toEqual({ name: 'file-theme', directory: temporaryRoot('base', 'file-theme'), reused: false })
    expect(counting.calls).toEqual([])
    expect(entries(options.storeRoot)).toEqual([])
  })

  it('依存を持つのに node_modules が無ければ、install の案内で止める', async () => {
    writeFileTheme('needs-install', { 'pecotv-test-theme-dep': '1.0.0' })
    const error = await failureOf(fetchTheme({ kind: 'file', path: './needs-install' }, { ...optionsFor('file-missing'), baseDirectory: temporaryRoot('base') }))

    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install' })
    expect(error instanceof Error && error.message).toContain('fix: run install there')
  })

  it('依存を持ち node_modules があれば通す', async () => {
    const directory = writeFileTheme('installed', { 'pecotv-test-theme-dep': '1.0.0' })
    mkdirSync(path.join(directory, 'node_modules'))
    const result = await fetchTheme({ kind: 'file', path: path.join(directory) }, { ...optionsFor('file-installed'), baseDirectory: temporaryRoot('base') })
    expect(result.directory).toBe(directory)
  })

  it('package.json が JSON でなければ、name が無いとして失敗する', async () => {
    mkdirSync(temporaryRoot('base', 'broken-json'), { recursive: true })
    writeFileSync(temporaryRoot('base', 'broken-json', 'package.json'), '{ not json', 'utf8')
    const error = await failureOf(fetchTheme({ kind: 'file', path: './broken-json' }, { ...optionsFor('file-json'), baseDirectory: temporaryRoot('base') }))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'unknown' })
    expect(error instanceof Error && error.message).toContain('package.json has no name')
  })

  it('name が無い package.json は失敗する', async () => {
    mkdirSync(temporaryRoot('base', 'nameless'), { recursive: true })
    writeFileSync(temporaryRoot('base', 'nameless', 'package.json'), '{}', 'utf8')
    const error = await failureOf(fetchTheme({ kind: 'file', path: './nameless' }, { ...optionsFor('file-nameless'), baseDirectory: temporaryRoot('base') }))
    expect(error).toMatchObject({ reason: 'unknown' })
  })

  it('package.json が無ければ失敗する', async () => {
    mkdirSync(temporaryRoot('base', 'empty'), { recursive: true })
    const error = await failureOf(fetchTheme({ kind: 'file', path: './empty' }, { ...optionsFor('file-empty'), baseDirectory: temporaryRoot('base') }))
    expect(error).toMatchObject({ name: 'ThemeFetchError' })
  })
})

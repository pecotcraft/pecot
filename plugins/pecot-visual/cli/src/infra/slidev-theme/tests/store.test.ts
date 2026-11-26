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
import { explains } from '../../../../tests/_helpers/explains.js'

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
  // interface-env: none
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
  it('テーマをタグで取得した場合は、依存を導入して patch を適用し、stamp.json を書き込む', async () => {
    await explains('`fetchTheme` が `git+file://` の取得元からテーマを取得するテストです。依存の導入と `patch` の適用が済み、`stamp.json` に取得元とハッシュを書き込み、一時ディレクトリを残さないことを確認します。')
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

  it('patch を適用したテーマの置き場は、元のディレクトリや pnpm の store と hard link を共有しない', async () => {
    await explains('`patch` を適用したファイルのテストです。リンク数が 1 であり、元のディレクトリや pnpm の store と実体を共有していないことを確認します。')
    const result = await fetchTheme(okSpec(), optionsFor('links'))
    expect(statSync(path.join(result.directory, 'node_modules', 'pecotv-test-theme-dep', 'index.js')).nlink).toBe(1)
  })

  it('2 回目の取得は stamp.json を使って再利用し、子プロセスを起動しない', async () => {
    await explains('同じテーマを 2 回取得するテストです。2 回目は `reused` が `true` になり、`git` や `pnpm` などの子プロセスを一度も起動しないことを確認します。')
    const options = optionsFor('reuse')
    await fetchTheme(okSpec(), options)

    const counting = countingRunner()
    const second = await fetchTheme(okSpec(), { ...options, runner: counting.runner })
    expect(second.reused).toBe(true)
    expect(second.name).toBe(THEME_NAME)
    expect(counting.calls).toEqual([])
  })

  it('node_modules が削除された置き場は、取得済みとせずに取得し直す', async () => {
    await explains('取得済みの置き場の `node_modules` を削除した場合のテストです。再利用せずに取得し直し、`reused` は `false` になって、依存が再び導入されることを確認します。')
    const options = optionsFor('broken')
    const first = await fetchTheme(okSpec(), options)
    rmSync(path.join(first.directory, 'node_modules'), { recursive: true, force: true })

    const counting = countingRunner()
    const second = await fetchTheme(okSpec(), { ...options, runner: counting.runner })
    expect(second.reused).toBe(false)
    expect(counting.calls.length).toBeGreaterThan(0)
    expect(existsSync(path.join(second.directory, 'node_modules', '.modules.yaml'))).toBe(true)
  })

  it('patch が書き換えられた置き場は、取得済みとせずに取得し直す', async () => {
    await explains('取得済みの置き場の `patch` ファイルを書き換えた場合のテストです。再利用せずに取得し直し、`patch` が適用された状態に戻ることを確認します。')
    const options = optionsFor('tampered')
    const first = await fetchTheme(okSpec(), options)
    writeFileSync(path.join(first.directory, 'patches', 'pecotv-test-theme-dep+0.0.0.patch'), 'changed\n', 'utf8')

    const second = await fetchTheme(okSpec(), options)
    expect(second.reused).toBe(false)
    expect(readFileSync(path.join(second.directory, 'node_modules', 'pecotv-test-theme-dep', 'index.js'), 'utf8')).toContain(PATCHED_MARK)
  })

  it('同じ置き場への取得が同時に行われた場合は、どちらも成功し、同じ置き場を返す', async () => {
    await explains('同じテーマを同時に 2 回取得するテストです。どちらも成功して同じ置き場を返し、一時ディレクトリが残らないことを確認します。')
    const options = optionsFor('concurrent')
    const [left, right] = await Promise.all([fetchTheme(okSpec(), options), fetchTheme(okSpec(), options)])
    expect(left.directory).toBe(right.directory)
    expect(existsSync(path.join(left.directory, 'node_modules', '.modules.yaml'))).toBe(true)
    expect(entries(hashDirectoryOf(left.directory)).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('利用者の NODE_EXTRA_CA_CERTS をそのまま pnpm に渡し、未設定の場合は追加しない', async () => {
    await explains('環境変数 `NODE_EXTRA_CA_CERTS` を設定した場合と、設定しない場合のテストです。`pnpm install` へ設定した値がそのまま渡され、未設定の場合は渡されないことを確認します。')
    // pecot は証明書を同梱しない。プロキシの CA は利用者が NODE_EXTRA_CA_CERTS で渡す。
    const received: (string | undefined)[] = []
    const runner = environmentRecordingRunner(received)

    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/etc/ssl/corp.pem')
    await fetchTheme(okSpec(), optionsFor('ca-preset', { runner }))
    vi.stubEnv('NODE_EXTRA_CA_CERTS', undefined)
    await fetchTheme(okSpec(), optionsFor('ca-unset', { runner }))

    expect(received).toEqual(['/etc/ssl/corp.pem', undefined])
  })

  it('別の取得が pnpm の実行前に置き終えていた場合は、pnpm と patch を実行せず再利用する', async () => {
    await explains('`pnpm install` の実行の直前に、別の取得が同じ置き場を作成し終えた場合のテストです。`install` は実行せず、作成済みの置き場を再利用して、一時ディレクトリが残らないことを確認します。')
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

  it('別の取得が patch の適用前に置き終えていた場合は、patch を適用せず再利用する', async () => {
    await explains('`patch` の適用の直前に、別の取得が同じ置き場を作成し終えた場合のテストです。`patch` を適用せず、作成済みの置き場を再利用することを確認します。')
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

  it('異常終了で残った古い一時ディレクトリは削除し、新しいものは残す', async () => {
    await explains('置き場に古い一時ディレクトリと新しい一時ディレクトリが存在する場合のテストです。取得後は、24 時間前に更新した古いものだけを削除し、新しいものは残すことを確認します。')
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

  it('プラグイン本体と同名の依存が存在する場合は、peerDependencies への移動を促す警告を表示する', async () => {
    await explains('テーマの `dependencies` に、プラグイン本体の依存ルートと同名のパッケージが存在する場合のテストです。`peerDependencies` への移動を促す警告が 1 件だけ表示され、`[warn]` の接頭辞は付かないことを確認します。')
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

  it('テーマが宣言していない間接的な依存は、プラグイン本体と同名でも警告を表示しない', async () => {
    await explains('テーマで宣言していない間接的な依存を、プラグイン本体の依存ルートと同名にした場合のテストです。`node_modules` 直下に平坦化されて存在しても、警告を表示しないことを確認します。')
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

  it('同名の依存が存在しない場合は、警告を表示しない', async () => {
    await explains('テーマの依存と同名のパッケージが、プラグイン本体の依存ルートに存在しない場合のテストです。警告を表示しないことを確認します。')
    const warnings: string[] = []
    await fetchTheme(okSpec(), { ...optionsFor('no-overlap'), warn: collect(warnings) })
    expect(warnings).toEqual([])
  })
})

describe('fetchTheme（失敗）', () => {
  it('存在しないタグを指定した場合は、tag で失敗し、置き場に何も残さない', async () => {
    await explains('存在しないタグ `v9.9.9` を指定した場合のテストです。理由 `tag` の `ThemeFetchError` が発生し、置き場のディレクトリは作成されないことを確認します。')
    const options = optionsFor('no-tag')
    const error = await failureOf(fetchTheme({ ...okSpec(), tag: 'v9.9.9' }, options))

    expect(error).toBeInstanceOf(ThemeFetchError)
    expect(error).toMatchObject({ reason: 'tag' })
    expect(error instanceof Error && error.message).toContain('v9.9.9')
    const hashDirectory = hashDirectoryFor(options.storeRoot, { ...okSpec(), tag: 'v9.9.9' })
    expect(existsSync(hashDirectory)).toBe(false)
  })

  it('別のタグが取得済みの階層で取得に失敗した場合も、取得済みの置き場を残す', async () => {
    await explains('別のタグが取得済みの階層で、存在しないタグの取得に失敗した場合のテストです。取得済みの置き場は削除されず、一時ディレクトリも残らないことを確認します。')
    const options = optionsFor('failure-beside-ready')
    const ready = await fetchTheme(okSpec(), options)
    await failureOf(fetchTheme({ ...okSpec(), tag: 'v9.9.9' }, options))

    expect(existsSync(path.join(ready.directory, 'package.json'))).toBe(true)
    expect(entries(hashDirectoryOf(ready.directory)).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('接続できない場合は、connection で失敗する', async () => {
    await explains('接続できない取得元 `https://127.0.0.1:1/x/y.git` で、プロキシ設定を空にして取得する場合のテストです。理由 `connection` の `ThemeFetchError` が発生することを確認します。')
    // プロキシ経由だと stderr がプロキシの応答になり、分類が変わる。
    for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) vi.stubEnv(name, '')
    vi.stubEnv('NO_PROXY', '127.0.0.1')
    const error = await failureOf(fetchTheme({ kind: 'git', url: 'https://127.0.0.1:1/x/y.git', tag: 'v1.0.0' }, optionsFor('no-connection')))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'connection' })
  })

  it('依存の導入に失敗した場合は、install で失敗し、タグのディレクトリを残さない', async () => {
    await explains('テーマの依存が存在しないパスを指している場合のテストです。理由 `install` の `ThemeFetchError` が発生し、タグのディレクトリを残さないことを確認します。')
    const broken = createThemeRepository('broken-dependency', `file:${temporaryRoot('does-not-exist')}`)
    const options = optionsFor('install-failure')
    const error = await failureOf(fetchTheme(broken, options))

    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install' })
    expect(existsSync(hashDirectoryFor(options.storeRoot, broken))).toBe(false)
  })

  it('name がパッケージ名として使えない場合は、pnpm の実行前に unknown で止める', async () => {
    await explains('テーマの `name` が `../escape` のようにパッケージ名として不正な場合のテストです。`pnpm install` を実行せず、理由 `unknown` の `ThemeFetchError` が発生することを確認します。')
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
  it('ロックの待機が上限を超えた場合は、別のプロセスが取得中であることを案内する', async () => {
    await explains(`\`${stage}\` の段の子プロセスがロック待ちの超過で終了した場合のテストです。理由 \`install\` の例外が発生し、メッセージに \`another process is fetching the same theme\` を含むことを確認します。`)
    const options = optionsFor(`lock-${stage}`, { runner: replacingRunner(isTarget, LOCK_CONFLICT) })
    const error = await failureOf(fetchTheme(okSpec(), options))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install' })
    expect(error instanceof Error && error.message).toContain('another process is fetching the same theme')
  })

  it('子プロセスが時間切れになった場合は、時間切れであることを案内する', async () => {
    await explains(`\`${stage}\` の段の子プロセスが、時間切れで終了した場合のテストです。理由 \`${timedOutReason}\` の \`ThemeFetchError\` が発生し、メッセージに \`timed out\` を含むことを確認します。`)
    const options = optionsFor(`timeout-${stage}`, { runner: replacingRunner(isTarget, TIMED_OUT) })
    const error = await failureOf(fetchTheme(okSpec(), options))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: timedOutReason })
    expect(error instanceof Error && error.message).toContain('timed out')
  })

  it('子プロセスを起動できない場合は、導入の確認を案内する', async () => {
    await explains(`\`${stage}\` の段の子プロセスを、起動できなかった場合のテストです。理由 \`install\` の \`ThemeFetchError\` が発生し、メッセージに \`check that it is installed\` を含むことを確認します。`)
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
  it('package.json が存在しないリポジトリを取得した場合は、install で失敗する', async () => {
    await explains('`package.json` が存在しないリポジトリを取得する場合のテストです。理由 `install` の `ThemeFetchError` が発生し、メッセージに `has no package.json` を含むことを確認します。')
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

  it('取得中に無効な置き場が先に作成されていた場合は、削除して置き直す', async () => {
    await explains('取得の途中で、`stamp.json` が存在しない置き場が先に作成された場合のテストです。その置き場を削除して作り直し、`reused` が `false` になることを確認します。')
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

  it('置き場の移動の時点で別の取得が有効な置き場を作成していた場合は、それを再利用する', async () => {
    await explains('`patch` の適用後に、別の取得が有効な置き場を作成し終えた場合のテストです。作成済みの置き場を再利用し、`reused` が `true` になることを確認します。')
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

  it('プラグイン本体の依存ルートに node_modules が存在しない場合も、警告を表示せずに取得できる', async () => {
    await explains('プラグイン本体の依存ルートに `node_modules` が存在しない場合のテストです。例外が発生せず、警告も表示されないことを確認します。')
    const warnings: string[] = []
    const noNodeModules = temporaryRoot('deps-without-node-modules')
    mkdirSync(noNodeModules, { recursive: true })
    await fetchTheme(okSpec(), { ...optionsFor('base-missing'), dependencyRoot: noNodeModules, warn: collect(warnings) })
    expect(warnings).toEqual([])
  })

  it('プラグイン本体の依存ルートの scope が通常のファイルの場合も、取得できる', async () => {
    await explains('プラグイン本体の依存ルートで、`@broken` の scope がディレクトリではなくファイルになっている場合のテストです。例外が発生せず、警告も表示されないことを確認します。')
    const dependencyRoot = temporaryRoot('deps-broken-scope')
    mkdirSync(path.join(dependencyRoot, 'node_modules'), { recursive: true })
    writeFileSync(path.join(dependencyRoot, 'node_modules', '@broken'), 'file', 'utf8')
    const warnings: string[] = []
    await fetchTheme(okSpec(), { ...optionsFor('scope-broken'), dependencyRoot, warn: collect(warnings) })
    expect(warnings).toEqual([])
  })
})

describe('fetchTheme（file）', () => {
  it('file 指定の場合は、baseDirectory を基準に実体を指し、install と stamp.json の書き込みを行わない', async () => {
    await explains('`kind: \'file\'` でテーマの相対パスを指定する場合のテストです。`baseDirectory` を基準にした実体の場所を返し、子プロセスの起動と置き場の作成は行わないことを確認します。')
    writeFileTheme('file-theme', {})
    const counting = countingRunner()
    const options = optionsFor('file', { runner: counting.runner })
    const result = await fetchTheme({ kind: 'file', path: './file-theme' }, { ...options, baseDirectory: temporaryRoot('base') })

    expect(result).toEqual({ name: 'file-theme', directory: temporaryRoot('base', 'file-theme'), reused: false })
    expect(counting.calls).toEqual([])
    expect(entries(options.storeRoot)).toEqual([])
  })

  it('依存を宣言しているのに node_modules が存在しない場合は、install の案内で失敗する', async () => {
    await explains('`dependencies` を宣言しているのに、`node_modules` が存在しないテーマのテストです。理由 `install` の `ThemeFetchError` が発生し、メッセージに `fix: run install there` を含むことを確認します。')
    writeFileTheme('needs-install', { 'pecotv-test-theme-dep': '1.0.0' })
    const error = await failureOf(fetchTheme({ kind: 'file', path: './needs-install' }, { ...optionsFor('file-missing'), baseDirectory: temporaryRoot('base') }))

    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install' })
    expect(error instanceof Error && error.message).toContain('fix: run install there')
  })

  it('依存を宣言していて node_modules も存在する場合は、そのまま使用できる', async () => {
    await explains('`dependencies` を宣言していて、`node_modules` も存在するテーマのテストです。例外が発生せず、指定したディレクトリを返すことを確認します。')
    const directory = writeFileTheme('installed', { 'pecotv-test-theme-dep': '1.0.0' })
    mkdirSync(path.join(directory, 'node_modules'))
    const result = await fetchTheme({ kind: 'file', path: path.join(directory) }, { ...optionsFor('file-installed'), baseDirectory: temporaryRoot('base') })
    expect(result.directory).toBe(directory)
  })

  it('package.json が JSON として解析できない場合は、name が存在しないものとして失敗する', async () => {
    await explains('`package.json` が JSON として解析できない場合のテストです。理由 `unknown` の `ThemeFetchError` が発生し、メッセージに `package.json has no name` を含むことを確認します。')
    mkdirSync(temporaryRoot('base', 'broken-json'), { recursive: true })
    writeFileSync(temporaryRoot('base', 'broken-json', 'package.json'), '{ not json', 'utf8')
    const error = await failureOf(fetchTheme({ kind: 'file', path: './broken-json' }, { ...optionsFor('file-json'), baseDirectory: temporaryRoot('base') }))
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'unknown' })
    expect(error instanceof Error && error.message).toContain('package.json has no name')
  })

  it('name が存在しない package.json の場合は、失敗する', async () => {
    await explains('`name` を含まない `package.json` のテストです。理由 `unknown` の `ThemeFetchError` が発生することを確認します。')
    mkdirSync(temporaryRoot('base', 'nameless'), { recursive: true })
    writeFileSync(temporaryRoot('base', 'nameless', 'package.json'), '{}', 'utf8')
    const error = await failureOf(fetchTheme({ kind: 'file', path: './nameless' }, { ...optionsFor('file-nameless'), baseDirectory: temporaryRoot('base') }))
    expect(error).toMatchObject({ reason: 'unknown' })
  })

  it('package.json が存在しない場合は、失敗する', async () => {
    await explains('テーマのディレクトリに `package.json` が存在しない場合のテストです。`ThemeFetchError` が発生することを確認します。')
    mkdirSync(temporaryRoot('base', 'empty'), { recursive: true })
    const error = await failureOf(fetchTheme({ kind: 'file', path: './empty' }, { ...optionsFor('file-empty'), baseDirectory: temporaryRoot('base') }))
    expect(error).toMatchObject({ name: 'ThemeFetchError' })
  })
})

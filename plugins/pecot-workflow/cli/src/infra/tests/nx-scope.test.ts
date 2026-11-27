/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { CancelledError } from '@pecot/workflow-core/domain/errors.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { installFakeExecutable, prependToPath, readFakeCalls } from '../../../../../../libs/workflow-core/tests/_helpers/fake-executables.js'
import { createGitRepository, gitForTest } from '../../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { pluginRoot } from '../../version.js'
import { OsError } from '@pecot/workflow-core/infra/os-error.js'
import type { NxProject } from '../nx-scope.js'
import { changedFiles, expectedScope, nxProjects, parseTitleScope, resolveNx } from '../nx-scope.js'

useIsolatedEnvironment()

// [root, tags]
const GRAPH: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  'pecot-workflow': ['plugins/pecot-workflow', ['type:plugin', 'scope:p-w']],
  'pecot-visual': ['plugins/pecot-visual', ['scope:p-v']],
  'nx-release': ['.nx/nx-release', ['scope:repo']],
  'text-rules': ['libs/text-rules', ['scope:libs']],
  'slide-kit': ['libs/slide-kit', ['scope:libs']],
  'no-tag': ['tools/no-tag', ['type:tool']],
}

const PROJECTS: ReadonlyMap<string, NxProject> = new Map([
  ['pecot-workflow', { root: 'plugins/pecot-workflow', scope: 'p-w' }],
  ['pecot-visual', { root: 'plugins/pecot-visual', scope: 'p-v' }],
  ['nx-release', { root: '.nx/nx-release', scope: 'repo' }],
  ['text-rules', { root: 'libs/text-rules', scope: 'libs' }],
  ['slide-kit', { root: 'libs/slide-kit', scope: 'libs' }],
  ['no-tag', { root: 'tools/no-tag', scope: 'no-tag' }],
])

function graphOf(projects: Readonly<Record<string, readonly [string, readonly string[]]>>): string {
  return JSON.stringify({ graph: { nodes: Object.fromEntries(Object.entries(projects).map(([name, [root, tags]]) => [name, { name, data: { root, tags } }])) } })
}

/**
`--file=` に graph を書き、info ファイルに「作業ディレクトリ NX_DAEMON」を書く sh の本体
*/
function writeGraphBody(graphText: string, infoFile: string, options: { readonly exitCode?: number, readonly stderr?: string } = {}): string {
  const { exitCode = 0, stderr = '' } = options
  return [
    'for a in "$@"; do case "$a" in --file=*) f="${a#--file=}";; esac; done',
    `cat > "$f" <<'GRAPH_END'\n${graphText}\nGRAPH_END`,
    `printf '%s %s' "$PWD" "$NX_DAEMON" > '${infoFile}'`,
    `printf '%s' '${stderr}' >&2`,
    `exit ${String(exitCode)}`,
    '',
  ].join('\n')
}

function installLocalNx(toplevel: string, body: string): string {
  const bin = path.join(toplevel, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  return installFakeExecutable(bin, 'nx', body)
}

function installGraphNx(toplevel: string, graphText: string, options: { readonly exitCode?: number, readonly stderr?: string } = {}): string {
  const info = path.join(makeTemporaryDirectory(), 'info')
  return installLocalNx(toplevel, writeGraphBody(graphText, info, options))
}

describe('resolveNx', () => {
  it('リポジトリ内の node_modules/.bin/nx と PATH 上の nx が両方存在する場合は、リポジトリ内の nx を使う', async () => {
    await explains('実行する nx を探す `resolveNx` のテストです。`<toplevel>/node_modules/.bin/nx` と PATH 上の `nx` の両方が存在する場合に、前者のパスを返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const local = installLocalNx(toplevel, 'exit 0\n')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'nx', 'exit 0\n')
    prependToPath(bin)
    expect(resolveNx(toplevel)).toBe(local)
  })

  it('リポジトリ内に nx が存在しない場合は、PATH 上の nx を使う', async () => {
    await explains('実行する nx を探す `resolveNx` のテストです。リポジトリ内に `nx` が存在せず PATH 上にだけ存在する場合に、PATH 上の `nx` のパスを返すことを確認します。')
    const bin = makeTemporaryDirectory()
    const found = installFakeExecutable(bin, 'nx', 'exit 0\n')
    prependToPath(bin)
    expect(resolveNx(makeTemporaryDirectory())).toBe(found)
  })

  it('実行権限のない nx とディレクトリは、nx として使わない', async () => {
    await explains('実行する nx を探す `resolveNx` のテストです。実行権限のない `nx` と、`nx` という名前のディレクトリしか存在しない場合に、`undefined` を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const local = installLocalNx(toplevel, 'exit 0\n')
    chmodSync(local, 0o644)
    const bin = makeTemporaryDirectory()
    mkdirSync(path.join(bin, 'nx'))
    setEnvironment({ PATH: bin })
    expect(resolveNx(toplevel)).toBeUndefined()
  })

  it('nx がどこにも存在しない場合は、undefined を返す', async () => {
    await explains('実行する nx を探す `resolveNx` のテストです。リポジトリ内と PATH 上のどちらにも `nx` が存在しない場合に、`undefined` を返すことを確認します。')
    setEnvironment({ PATH: makeTemporaryDirectory() })
    expect(resolveNx(makeTemporaryDirectory())).toBeUndefined()
  })

  it('PATH が設定されていない場合でも、例外が発生せず undefined を返す', async () => {
    await explains('実行する nx を探す `resolveNx` のテストです。環境変数 `PATH` が設定されていない場合でも、例外が発生せずに `undefined` を返すことを確認します。')
    setEnvironment({ PATH: undefined })
    expect(resolveNx(makeTemporaryDirectory())).toBeUndefined()
  })
})

describe('nxProjects', () => {
  it('graph ファイルから root と scope の tag を読み込み、nx は toplevel を作業ディレクトリにしてデーモンなしで実行する', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。graph ファイルからプロジェクトごとの `root` と `scope` を返し、`NX_DAEMON=false` で `nx` を実行することを確認します。')
    const toplevel = makeTemporaryDirectory()
    const info = path.join(makeTemporaryDirectory(), 'info')
    const nx = installLocalNx(toplevel, writeGraphBody(graphOf(GRAPH), info))
    expect(await nxProjects(toplevel)).toEqual(PROJECTS)
    expect(readFileSync(info, 'utf8')).toBe(`${toplevel} false`)
    const [call] = readFakeCalls(path.dirname(nx), 'nx')
    expect(call?.[0]).toBe('graph')
    expect(call?.[1]?.startsWith(`--file=${path.join(toplevel, '.pecot', 'tmp')}${path.sep}nx-scope.`)).toBe(true)
  })

  it('graph ファイルは .pecot/tmp の下に作成し、処理が終わったら削除する', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。処理が終わった後に、`.pecot/tmp` の下に graph ファイルが残っていないことを確認します。')
    const toplevel = makeTemporaryDirectory()
    installGraphNx(toplevel, graphOf(GRAPH))
    await nxProjects(toplevel)
    expect(readdirSync(path.join(toplevel, '.pecot', 'tmp'))).toEqual([])
  })

  it('root が . のプロジェクトは . のままにし、末尾の / は取り除き、空になる場合は . にする', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`root` が `.` の場合はそのまま、`packages/lib/` は末尾の `/` を取り除き、`/` は `.` にして返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const graph = graphOf({ root: ['.', []], lib: ['packages/lib/', []], slash: ['/', []] })
    installGraphNx(toplevel, graph)
    expect(await nxProjects(toplevel)).toEqual(new Map([
      ['root', { root: '.', scope: 'root' }],
      ['lib', { root: 'packages/lib', scope: 'lib' }],
      ['slash', { root: '.', scope: 'slash' }],
    ]))
  })

  it.each([
    ['tags が無い', undefined],
    ['tags が空', []],
    ['値が空の scope: だけ', ['scope:']],
    ['tags が配列でない', 'scope:x'],
    ['scope: で始まらない tag だけ', ['type:lib', 'xscope:x']],
  ])('scope の tag が使えない場合（%s）は、プロジェクト名を scope にする', async (_title, tags) => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`tags` が存在しない場合や、`scope:` で始まる有効な tag がない場合に、プロジェクト名を `scope` として返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const data = tags === undefined ? { root: 'a' } : { root: 'a', tags }
    installGraphNx(toplevel, JSON.stringify({ graph: { nodes: { 'a-b': { name: 'a-b', data } } } }))
    expect(await nxProjects(toplevel)).toEqual(new Map([['a-b', { root: 'a', scope: 'a-b' }]]))
  })

  it('scope の tag が複数ある場合は先頭のものを使い、文字列でない tag は無視する', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`tags` に数値と複数の `scope:` の tag が含まれる場合に、先頭の `scope:first` の値 `first` を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const data = { root: 'a', tags: [1, 'scope:first', 'scope:second'] }
    installGraphNx(toplevel, JSON.stringify({ graph: { nodes: { a: { data } } } }))
    const projects = await nxProjects(toplevel)
    expect(projects?.get('a')?.scope).toBe('first')
  })

  it('nx が存在しない場合は、undefined を返す', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`nx` が存在しない場合に、`undefined` を返すことを確認します。')
    setEnvironment({ PATH: makeTemporaryDirectory() })
    expect(await nxProjects(makeTemporaryDirectory())).toBeUndefined()
  })

  it('PATH 上に nx がある場合は、その nx で graph を取得できる', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。PATH 上の `nx`（テスト用の実行ファイル）が書いた graph から、プロジェクトの一覧を取得できることを確認します。')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'nx', writeGraphBody(graphOf(GRAPH), path.join(bin, 'info')))
    prependToPath(bin)
    expect(await nxProjects(makeTemporaryDirectory())).toEqual(PROJECTS)
  })

  it('nx の終了コードが 0 以外の場合は、undefined を返す', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`nx` が終了コード 1 で終了した場合に、`undefined` を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    installGraphNx(toplevel, graphOf(GRAPH), { exitCode: 1 })
    expect(await nxProjects(toplevel)).toBeUndefined()
  })

  it('標準エラー出力に Showing partial graph が含まれる場合は、undefined を返す', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`nx` が標準エラー出力に `Showing partial graph` を出力した場合に、`undefined` を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    installGraphNx(toplevel, graphOf(GRAPH), { stderr: 'Showing partial graph (errors)' })
    expect(await nxProjects(toplevel)).toBeUndefined()
  })

  it('時間制限を超えた場合は undefined を返し、graph ファイルは削除する', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`timeoutSeconds` を超えた場合に、`undefined` を返し、`.pecot/tmp` に graph ファイルが残らないことを確認します。')
    const toplevel = makeTemporaryDirectory()
    installLocalNx(toplevel, 'sleep 5\n')
    expect(await nxProjects(toplevel, { timeoutSeconds: 0.3 })).toBeUndefined()
    expect(readdirSync(path.join(toplevel, '.pecot', 'tmp'))).toEqual([])
  })

  it('処理を取り消した場合は、nx を停止して CancelledError を送出し、graph ファイルを削除する', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`AbortController` で取り消した場合は、`CancelledError` が発生し、`.pecot/tmp` に graph ファイルが残らないことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const pidFile = path.join(makeTemporaryDirectory(), 'nx.pid')
    installLocalNx(toplevel, `echo $$ > '${pidFile}'\nexec sleep 30\n`)
    const controller = new AbortController()
    const reading = nxProjects(toplevel, { signal: controller.signal })
    await expect.poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', { timeout: 10_000, interval: 20 }).toBe(true)
    controller.abort('stop')
    await expect(reading).rejects.toThrow(new CancelledError('stop'))
    expect(readdirSync(path.join(toplevel, '.pecot', 'tmp'))).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('graph ファイルの削除に失敗した場合でも、取得できた結果を返す', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。graph を書いた後で作業ディレクトリが書き込み不可になり、削除に失敗した場合でも、プロジェクトの一覧を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const info = path.join(makeTemporaryDirectory(), 'info')
    // graph を書いた後、作業ディレクトリを書き込み不可にして、中身を消せなくする
    const body = writeGraphBody(graphOf(GRAPH), info).replace(/exit 0\n$/u, 'chmod 555 "$(dirname "$f")"\nexit 0\n')
    installLocalNx(toplevel, body)
    const temporary = path.join(toplevel, '.pecot', 'tmp')
    try {
      expect(await nxProjects(toplevel)).toEqual(PROJECTS)
    }
    finally {
      for (const name of readdirSync(temporary)) chmodSync(path.join(temporary, name), 0o755)
    }
  })

  it('nx を起動できない場合は、undefined を返す', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。実行形式として不正な `nx` を起動できない場合に、`undefined` を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const nx = installLocalNx(toplevel, 'exit 0\n')
    writeFileSync(nx, '\0\0 not executable format')
    chmodSync(nx, 0o755)
    expect(await nxProjects(toplevel)).toBeUndefined()
  })

  it('nx が graph ファイルを書き込まなかった場合は、undefined を返す', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`nx` が正常終了しても graph ファイルを書き込まなかった場合に、`undefined` を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    installLocalNx(toplevel, 'exit 0\n')
    expect(await nxProjects(toplevel)).toBeUndefined()
  })

  it('.pecot/tmp を作成できない場合は、undefined を返す', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`.pecot` がファイルとして存在し、`.pecot/tmp` を作成できない場合に、`undefined` を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    installLocalNx(toplevel, 'exit 0\n')
    writeFileSync(path.join(toplevel, '.pecot'), 'a file')
    expect(await nxProjects(toplevel)).toBeUndefined()
  })

  it.each([
    ['JSON でない', 'not json'],
    ['空の object', '{}'],
    ['data が無い node', '{"graph": {"nodes": {"a": {"name": "a"}}}}'],
    ['配列', '[]'],
    ['null', 'null'],
    ['nodes が配列', '{"graph": {"nodes": []}}'],
    ['nodes が空', '{"graph": {"nodes": {}}}'],
    ['data が文字列', '{"graph": {"nodes": {"a": {"data": "x"}}}}'],
    ['node が配列', '{"graph": {"nodes": {"a": []}}}'],
  ])('graph を解釈できない場合（%s）は、undefined を返す', async (_title, text) => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。JSON として不正な内容や、`graph.nodes` の形が期待と異なる内容の場合に、`undefined` を返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    installGraphNx(toplevel, text)
    expect(await nxProjects(toplevel)).toBeUndefined()
  })

  it('root が文字列でない場合は、Python の str() と同じ文字列に変換する', async () => {
    await explains('nx のプロジェクト一覧を取得する `nxProjects` のテストです。`root` が数値 `5`・真偽値 `true`・`null` の場合に、`5`・`True`・`None` の文字列に変換して返すことを確認します。')
    const toplevel = makeTemporaryDirectory()
    const graph = '{"graph": {"nodes": {"n": {"data": {"root": 5}}, "b": {"data": {"root": true}}, "z": {"data": {"root": null}}}}}'
    installGraphNx(toplevel, graph)
    expect(await nxProjects(toplevel)).toEqual(new Map([
      ['n', { root: '5', scope: 'n' }],
      ['b', { root: 'True', scope: 'b' }],
      ['z', { root: 'None', scope: 'z' }],
    ]))
  })
})

function repositoryWithBranch(): string {
  const repository = createGitRepository({ 'README.md': 'x', 'old/name.txt': 'moved' })
  gitForTest(repository, ['checkout', '-q', '-b', 'feat/x/1'])
  writeFileSync(path.join(repository, 'README.md'), 'changed')
  mkdirSync(path.join(repository, '日本語'))
  writeFileSync(path.join(repository, '日本語', 'c.md'), 'new')
  mkdirSync(path.join(repository, 'a'))
  writeFileSync(path.join(repository, 'a', 'b.py'), 'new')
  gitForTest(repository, ['mv', 'old/name.txt', 'new-name.txt'])
  gitForTest(repository, ['add', '-A'])
  gitForTest(repository, ['commit', '-q', '-m', 'work'])
  // base 側にだけ入る変更は、三点 diff には出ない
  gitForTest(repository, ['checkout', '-q', 'main'])
  writeFileSync(path.join(repository, 'only-on-main.txt'), 'x')
  gitForTest(repository, ['add', '-A'])
  gitForTest(repository, ['commit', '-q', '-m', 'main work'])
  return repository
}

describe('changedFiles（実 git）', () => {
  it('NUL 区切りで分割し、非 ASCII のパスは引用符なしで返し、rename は移動元も含め、base 側だけの変更は含めない', async () => {
    await explains('実際の git リポジトリで変更ファイルを取得する `changedFiles` のテストです。日本語のパスを含むブランチの変更について、移動元を含めた変更ファイルの一覧を返し、`main` にだけ入った変更は含まれないことを確認します。')
    const repository = repositoryWithBranch()
    expect(changedFiles(repository, 'main', 'feat/x/1')).toEqual(['README.md', 'a/b.py', 'new-name.txt', 'old/name.txt', '日本語/c.md'])
  })

  it('起点にコミットの SHA を指定すると、親 PR が squash マージされた後も、その位置から head までの変更だけを返す', async () => {
    await explains('実際の git リポジトリで変更ファイルを取得する `changedFiles` のテストです。起点に `main` を指定した場合は親 PR の `lower.txt` も含まれ、親 PR の SHA を指定した場合は `upper.txt` だけを返すことを確認します。')
    const repository = createGitRepository({ 'README.md': 'x' })
    gitForTest(repository, ['checkout', '-q', '-b', 'feat/a/11'])
    writeFileSync(path.join(repository, 'lower.txt'), 'lower')
    gitForTest(repository, ['add', '-A'])
    gitForTest(repository, ['commit', '-q', '-m', 'lower'])
    const recorded = gitForTest(repository, ['rev-parse', 'HEAD']).trim()
    gitForTest(repository, ['checkout', '-q', '-b', 'feat/b/12'])
    writeFileSync(path.join(repository, 'upper.txt'), 'upper')
    gitForTest(repository, ['add', '-A'])
    gitForTest(repository, ['commit', '-q', '-m', 'upper'])
    gitForTest(repository, ['checkout', '-q', 'main'])
    gitForTest(repository, ['merge', '-q', '--squash', 'feat/a/11'])
    gitForTest(repository, ['commit', '-q', '-m', 'squash lower'])
    gitForTest(repository, ['branch', '-q', '-D', 'feat/a/11'])

    expect(changedFiles(repository, 'main', 'feat/b/12')).toEqual(['lower.txt', 'upper.txt'])
    expect(changedFiles(repository, recorded, 'feat/b/12')).toEqual(['upper.txt'])
  })

  it('差分が存在しない場合は、空の一覧を返す', async () => {
    await explains('実際の git リポジトリで変更ファイルを取得する `changedFiles` のテストです。`main` と `HEAD` に差分が存在しない場合に、空の配列を返すことを確認します。')
    const repository = createGitRepository()
    expect(changedFiles(repository, 'main', 'HEAD')).toEqual([])
  })

  it('base または head を解決できない場合は、undefined を返す', async () => {
    await explains('実際の git リポジトリで変更ファイルを取得する `changedFiles` のテストです。存在しない `origin/main` や `no-such-ref` を指定した場合に、`undefined` を返すことを確認します。')
    const repository = createGitRepository()
    expect(changedFiles(repository, 'origin/main', 'HEAD')).toBeUndefined()
    expect(changedFiles(repository, 'main', 'no-such-ref')).toBeUndefined()
  })

  it('git リポジトリではない場合は、undefined を返す', async () => {
    await explains('実際の git で変更ファイルを取得する `changedFiles` のテストです。git リポジトリではないディレクトリを指定した場合に、`undefined` を返すことを確認します。')
    expect(changedFiles(makeTemporaryDirectory(), 'main', 'HEAD')).toBeUndefined()
  })

  it('git を実行できない場合（実行権限がない場合）は、無視せずに OsError を送出する', async () => {
    await explains('実際の git で変更ファイルを取得する `changedFiles` のテストです。PATH 上の `git` に実行権限がなく実行できない場合に、`undefined` を返さず `OsError` が発生することを確認します。')
    const repository = createGitRepository()
    const bin = makeTemporaryDirectory()
    const git = installFakeExecutable(bin, 'git', 'exit 0\n')
    chmodSync(git, 0o644)
    prependToPath(bin)
    // 実行権限の無い git は PATH 探索で飛ばされ、後ろの実 git が使われる。権限なしの絶対パスを直接渡せないため、PATH をその 1 つだけにする
    setEnvironment({ PATH: bin })
    expect(() => changedFiles(repository, 'main', 'HEAD')).toThrow(OsError)
  })

  it('git が存在しない場合は、undefined を返す', async () => {
    await explains('実際の git で変更ファイルを取得する `changedFiles` のテストです。PATH 上に `git` が存在しない場合は、`undefined` を返すことを確認します。')
    const repository = createGitRepository()
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
    expect(changedFiles(repository, 'main', 'HEAD')).toBeUndefined()
  })
})

function projectsOf(roots: Readonly<Record<string, string>>): ReadonlyMap<string, NxProject> {
  return new Map(Object.entries(roots).map(([name, root]) => [name, { root, scope: name }]))
}

describe('expectedScope', () => {
  it('差分が 1 つのプロジェクトだけに属する場合は、その scope だけを返す', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。変更ファイルがすべて `pecot-workflow` に属する場合は、`p-w` のみを返すことを確認します。')
    expect(expectedScope(['plugins/pecot-workflow/cli/a.py', 'plugins/pecot-workflow/README.md'], PROJECTS)).toEqual(['p-w'])
  })

  it('複数のプロジェクトに属する場合は、scope の昇順で返す', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`pecot-workflow` と `pecot-visual` に属するファイルがある場合に、`p-v` と `p-w` を昇順で返すことを確認します。')
    expect(expectedScope(['plugins/pecot-workflow/a.py', 'plugins/pecot-visual/b.ts'], PROJECTS)).toEqual(['p-v', 'p-w'])
  })

  it('ファイルが属するプロジェクトは、project root が最も長く一致するものにする', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`plugins/x` と `plugins/x/sub` の 2 つのプロジェクトがある場合に、ファイルは最も長く一致する root のプロジェクトに属することを確認します。')
    const projects = projectsOf({ outer: 'plugins/x', inner: 'plugins/x/sub' })
    expect(expectedScope(['plugins/x/sub/f.py'], projects)).toEqual(['inner'])
    expect(expectedScope(['plugins/x/other.py'], projects)).toEqual(['outer'])
  })

  it('ディレクトリ名が前方一致するだけの場合は、そのプロジェクトに属さないものとして扱う', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`plugins/pecot-workflow-extra/` は名前の先頭が root と一致するだけなので、プロジェクトに属さず、`repo` として扱われることを確認します。')
    expect(expectedScope(['plugins/pecot-workflow-extra/a.py'], PROJECTS)).toEqual(['repo'])
  })

  it('どのプロジェクトにも属さないファイルがある場合は、末尾に repo を加える', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`CLAUDE.md` のようにどのプロジェクトにも属さないファイルがある場合に、`p-w` の後ろに `repo` を加えることを確認します。')
    expect(expectedScope(['plugins/pecot-workflow/a.py', 'CLAUDE.md'], PROJECTS)).toEqual(['p-w', 'repo'])
    expect(expectedScope(['.githooks/pre-commit/x.sh'], PROJECTS)).toEqual(['repo'])
  })

  it('root が . のプロジェクトには、すべてのファイルが属する', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`root` が `.` のプロジェクトがある場合に、ほかのプロジェクトに属さないファイルがそのプロジェクトに属することを確認します。')
    const projects = projectsOf({ root: '.', lib: 'packages/lib' })
    expect(expectedScope(['README.md', 'packages/lib/a.ts'], projects)).toEqual(['lib', 'root'])
  })

  it('.nx/version-plans/ 配下のファイルは対象にせず、それだけの場合は空の一覧を返す', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`.nx/version-plans/` の下のファイルは scope に含めず、そのファイルだけの場合は空の配列を返すことを確認します。')
    expect(expectedScope(['plugins/pecot-workflow/a.py', '.nx/version-plans/1-x.md'], PROJECTS)).toEqual(['p-w'])
    expect(expectedScope(['.nx/version-plans/1-x.md'], PROJECTS)).toEqual([])
  })

  it('.nx/nx-release のファイルは version-plans として扱わず、プロジェクトの scope を返す', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`.nx/nx-release/` の下のファイルは `version-plans` の対象にならず、そのプロジェクトの scope `repo` を返すことを確認します。')
    expect(expectedScope(['.nx/nx-release/src/x.js'], PROJECTS)).toEqual(['repo'])
  })

  it('差分が空の場合は、空の一覧を返す', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。変更ファイルの一覧が空の場合に、空の配列を返すことを確認します。')
    expect(expectedScope([], PROJECTS)).toEqual([])
  })

  it('同じ scope の tag を持つ複数のプロジェクトは、1 つの scope にまとめる', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`text-rules` と `slide-kit` のように同じ scope `libs` を持つプロジェクトの変更を、`libs` の 1 つにまとめることを確認します。')
    const files = ['libs/text-rules/a.ts', 'libs/slide-kit/b.ts', 'plugins/pecot-workflow/c.py']
    expect(expectedScope(files, PROJECTS)).toEqual(['libs', 'p-w'])
  })

  it('scope が repo のプロジェクトは、昇順に並べず、末尾へ置く', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。scope が `repo` のプロジェクトの変更と、`CLAUDE.md` の変更がある場合に、`repo` を重複させず末尾に置くことを確認します。')
    const files = ['.nx/nx-release/src/x.js', 'plugins/pecot-workflow/c.py', 'CLAUDE.md']
    expect(expectedScope(files, PROJECTS)).toEqual(['p-w', 'repo'])
  })

  it('scope の tag が存在しないプロジェクトは、プロジェクト名を scope にする', async () => {
    await explains('変更ファイルから commit の scope を求める `expectedScope` のテストです。`scope:` の tag を持たないプロジェクトのファイルを変更した場合に、プロジェクト名 `no-tag` を返すことを確認します。')
    expect(expectedScope(['tools/no-tag/a.sh'], PROJECTS)).toEqual(['no-tag'])
  })
})

describe('parseTitleScope', () => {
  it.each([
    ['feat(pecot-workflow): #1 x', ['pecot-workflow']],
    ['feat(a,b): #1 x', ['a', 'b']],
    ['feat(a, b): #1 x', ['a', ' b']],
    ['fix(a)!: #1 x', ['a']],
    ['feat(pecot-workflow,repo): x', ['pecot-workflow', 'repo']],
    ['feat: #1 x', undefined],
    ['feat(): #1 x', undefined],
    ['(a): x', undefined],
    ['plain title', undefined],
    ['', undefined],
  ])('タイトル %j の場合は、scope の配列か undefined を返す', async (title, expected) => {
    await explains('コミットのタイトルから scope を取り出す `parseTitleScope` のテストです。`feat(a,b): #1 x` のように括弧の中に scope がある場合は配列を返し、括弧が存在しない場合や空の場合は `undefined` を返すことを確認します。')
    expect(parseTitleScope(title)).toEqual(expected)
  })
})

describe('実 nx の契約（graph の出力形式）', () => {
  // plugin ルートの 2 つ上がリポジトリルート
  const repositoryRoot = path.resolve(pluginRoot(), '..', '..')

  it.skipIf(!existsSync(path.join(repositoryRoot, 'node_modules', '.bin', 'nx')))('リポジトリ本体の nx の graph から、plugin の root を取得できる', async () => {
    await explains('実際の nx が出力する graph の形式のテストです。`nx graph` から `pecot-workflow` と `pecot-visual` の `root` を取得でき、`p-w` の scope が求められることを確認します。')
    const projects = await nxProjects(repositoryRoot)
    expect(projects?.get('pecot-workflow')?.root).toBe('plugins/pecot-workflow')
    expect(projects?.get('pecot-visual')?.root).toBe('plugins/pecot-visual')
    expect(projects === undefined ? undefined : expectedScope(['plugins/pecot-workflow/cli/x.py'], projects)).toEqual(['p-w'])
  }, 120_000)
})

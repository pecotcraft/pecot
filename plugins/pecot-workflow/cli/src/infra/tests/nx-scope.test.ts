/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { installFakeExecutable, prependToPath, readFakeCalls } from '../../tests/_helpers/fake-executables.js'
import { createGitRepository, gitForTest } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { pluginRoot } from '../../version.js'
import { OsError } from '../os-error.js'
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
  it('<toplevel>/node_modules/.bin/nx を PATH 上の nx より優先する', () => {
    const toplevel = makeTemporaryDirectory()
    const local = installLocalNx(toplevel, 'exit 0\n')
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'nx', 'exit 0\n')
    prependToPath(bin)
    expect(resolveNx(toplevel)).toBe(local)
  })

  it('ローカルに無ければ PATH 上の nx', () => {
    const bin = makeTemporaryDirectory()
    const found = installFakeExecutable(bin, 'nx', 'exit 0\n')
    prependToPath(bin)
    expect(resolveNx(makeTemporaryDirectory())).toBe(found)
  })

  it('実行権限の無い nx は使わない。ディレクトリも使わない', () => {
    const toplevel = makeTemporaryDirectory()
    const local = installLocalNx(toplevel, 'exit 0\n')
    chmodSync(local, 0o644)
    const bin = makeTemporaryDirectory()
    mkdirSync(path.join(bin, 'nx'))
    setEnvironment({ PATH: bin })
    expect(resolveNx(toplevel)).toBeUndefined()
  })

  it('どこにも無ければ undefined', () => {
    setEnvironment({ PATH: makeTemporaryDirectory() })
    expect(resolveNx(makeTemporaryDirectory())).toBeUndefined()
  })

  it('PATH が未設定でも落ちない', () => {
    setEnvironment({ PATH: undefined })
    expect(resolveNx(makeTemporaryDirectory())).toBeUndefined()
  })
})

describe('nxProjects', () => {
  it('graph ファイルから root と scope の tag を読む。nx は toplevel を作業ディレクトリにして、デーモン無しで呼ぶ', () => {
    const toplevel = makeTemporaryDirectory()
    const info = path.join(makeTemporaryDirectory(), 'info')
    const nx = installLocalNx(toplevel, writeGraphBody(graphOf(GRAPH), info))
    expect(nxProjects(toplevel)).toEqual(PROJECTS)
    expect(readFileSync(info, 'utf8')).toBe(`${toplevel} false`)
    const [call] = readFakeCalls(path.dirname(nx), 'nx')
    expect(call?.[0]).toBe('graph')
    expect(call?.[1]?.startsWith(`--file=${path.join(toplevel, '.pecot', 'tmp')}${path.sep}nx-scope.`)).toBe(true)
  })

  it('graph ファイルは .pecot/tmp の下に作り、終わったら消す', () => {
    const toplevel = makeTemporaryDirectory()
    installGraphNx(toplevel, graphOf(GRAPH))
    nxProjects(toplevel)
    expect(readdirSync(path.join(toplevel, '.pecot', 'tmp'))).toEqual([])
  })

  it('root が . のプロジェクトは . のまま。末尾の / は落とし、空になれば .', () => {
    const toplevel = makeTemporaryDirectory()
    const graph = graphOf({ root: ['.', []], lib: ['packages/lib/', []], slash: ['/', []] })
    installGraphNx(toplevel, graph)
    expect(nxProjects(toplevel)).toEqual(new Map([
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
  ])('scope の tag が使えなければ、プロジェクト名を scope にする（%s）', (_title, tags) => {
    const toplevel = makeTemporaryDirectory()
    const data = tags === undefined ? { root: 'a' } : { root: 'a', tags }
    installGraphNx(toplevel, JSON.stringify({ graph: { nodes: { 'a-b': { name: 'a-b', data } } } }))
    expect(nxProjects(toplevel)).toEqual(new Map([['a-b', { root: 'a', scope: 'a-b' }]]))
  })

  it('scope の tag が複数あれば、先頭のものを使う。文字列でない tag は飛ばす', () => {
    const toplevel = makeTemporaryDirectory()
    const data = { root: 'a', tags: [1, 'scope:first', 'scope:second'] }
    installGraphNx(toplevel, JSON.stringify({ graph: { nodes: { a: { data } } } }))
    expect(nxProjects(toplevel)?.get('a')?.scope).toBe('first')
  })

  it('nx が無ければ undefined', () => {
    setEnvironment({ PATH: makeTemporaryDirectory() })
    expect(nxProjects(makeTemporaryDirectory())).toBeUndefined()
  })

  it('PATH 上の偽の nx も使える', () => {
    const bin = makeTemporaryDirectory()
    installFakeExecutable(bin, 'nx', writeGraphBody(graphOf(GRAPH), path.join(bin, 'info')))
    prependToPath(bin)
    expect(nxProjects(makeTemporaryDirectory())).toEqual(PROJECTS)
  })

  it('終了コードが 0 でなければ undefined', () => {
    const toplevel = makeTemporaryDirectory()
    installGraphNx(toplevel, graphOf(GRAPH), { exitCode: 1 })
    expect(nxProjects(toplevel)).toBeUndefined()
  })

  it('部分 graph（stderr に Showing partial graph）なら undefined', () => {
    const toplevel = makeTemporaryDirectory()
    installGraphNx(toplevel, graphOf(GRAPH), { stderr: 'Showing partial graph (errors)' })
    expect(nxProjects(toplevel)).toBeUndefined()
  })

  it('timeout を超えたら undefined。graph ファイルは消す', () => {
    const toplevel = makeTemporaryDirectory()
    installLocalNx(toplevel, 'sleep 5\n')
    expect(nxProjects(toplevel, { timeoutSeconds: 0.3 })).toBeUndefined()
    expect(readdirSync(path.join(toplevel, '.pecot', 'tmp'))).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('後始末の rm が失敗しても、読めた結果を返す', () => {
    const toplevel = makeTemporaryDirectory()
    const info = path.join(makeTemporaryDirectory(), 'info')
    // graph を書いた後、作業ディレクトリを書き込み不可にして、中身を消せなくする
    const body = writeGraphBody(graphOf(GRAPH), info).replace(/exit 0\n$/u, 'chmod 555 "$(dirname "$f")"\nexit 0\n')
    installLocalNx(toplevel, body)
    const temporary = path.join(toplevel, '.pecot', 'tmp')
    try {
      expect(nxProjects(toplevel)).toEqual(PROJECTS)
    }
    finally {
      for (const name of readdirSync(temporary)) chmodSync(path.join(temporary, name), 0o755)
    }
  })

  it('nx が起動できなければ undefined', () => {
    const toplevel = makeTemporaryDirectory()
    const nx = installLocalNx(toplevel, 'exit 0\n')
    writeFileSync(nx, '\0\0 not executable format')
    chmodSync(nx, 0o755)
    expect(nxProjects(toplevel)).toBeUndefined()
  })

  it('graph ファイルが書かれなければ undefined', () => {
    const toplevel = makeTemporaryDirectory()
    installLocalNx(toplevel, 'exit 0\n')
    expect(nxProjects(toplevel)).toBeUndefined()
  })

  it('.pecot/tmp を作れなければ undefined', () => {
    const toplevel = makeTemporaryDirectory()
    installLocalNx(toplevel, 'exit 0\n')
    writeFileSync(path.join(toplevel, '.pecot'), 'a file')
    expect(nxProjects(toplevel)).toBeUndefined()
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
  ])('graph が解釈できなければ undefined（%s）', (_title, text) => {
    const toplevel = makeTemporaryDirectory()
    installGraphNx(toplevel, text)
    expect(nxProjects(toplevel)).toBeUndefined()
  })

  it('root が文字列でなくても Python の str() と同じ文字列にする', () => {
    const toplevel = makeTemporaryDirectory()
    const graph = '{"graph": {"nodes": {"n": {"data": {"root": 5}}, "b": {"data": {"root": true}}, "z": {"data": {"root": null}}}}}'
    installGraphNx(toplevel, graph)
    expect(nxProjects(toplevel)).toEqual(new Map([
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
  it('NUL 区切りで分け、非 ASCII のパスも引用符なしで返す。rename は移動元も出す。三点 diff で base 側だけの変更は含まない', () => {
    const repository = repositoryWithBranch()
    expect(changedFiles(repository, 'main', 'feat/x/1')).toEqual(['README.md', 'a/b.py', 'new-name.txt', 'old/name.txt', '日本語/c.md'])
  })

  it('起点にコミットの SHA を渡すと、下の段が squash でマージされた後も、その位置から head までの変更だけを返す', () => {
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

  it('差分が無ければ空の一覧', () => {
    const repository = createGitRepository()
    expect(changedFiles(repository, 'main', 'HEAD')).toEqual([])
  })

  it('base か head が解決できなければ undefined', () => {
    const repository = createGitRepository()
    expect(changedFiles(repository, 'origin/main', 'HEAD')).toBeUndefined()
    expect(changedFiles(repository, 'main', 'no-such-ref')).toBeUndefined()
  })

  it('git リポジトリでなければ undefined', () => {
    expect(changedFiles(makeTemporaryDirectory(), 'main', 'HEAD')).toBeUndefined()
  })

  it('git を実行できなければ（権限なし）握り潰さず例外にする', () => {
    const repository = createGitRepository()
    const bin = makeTemporaryDirectory()
    const git = installFakeExecutable(bin, 'git', 'exit 0\n')
    chmodSync(git, 0o644)
    prependToPath(bin)
    // 実行権限の無い git は PATH 探索で飛ばされ、後ろの実 git が使われる。権限なしの絶対パスを直接渡せないため、PATH をその 1 つだけにする
    setEnvironment({ PATH: bin })
    expect(() => changedFiles(repository, 'main', 'HEAD')).toThrow(OsError)
  })

  it('git が無ければ undefined', () => {
    const repository = createGitRepository()
    setEnvironment({ PATH: makeTemporaryDirectory('pecot-nogit-') })
    expect(changedFiles(repository, 'main', 'HEAD')).toBeUndefined()
  })
})

function projectsOf(roots: Readonly<Record<string, string>>): ReadonlyMap<string, NxProject> {
  return new Map(Object.entries(roots).map(([name, root]) => [name, { root, scope: name }]))
}

describe('expectedScope', () => {
  it('差分が 1 つのプロジェクトだけに属するとき、その scope だけを返す', () => {
    expect(expectedScope(['plugins/pecot-workflow/cli/a.py', 'plugins/pecot-workflow/README.md'], PROJECTS)).toEqual(['p-w'])
  })

  it('複数のプロジェクトは scope の昇順', () => {
    expect(expectedScope(['plugins/pecot-workflow/a.py', 'plugins/pecot-visual/b.ts'], PROJECTS)).toEqual(['p-v', 'p-w'])
  })

  it('持ち主は project root との最長一致で決める', () => {
    const projects = projectsOf({ outer: 'plugins/x', inner: 'plugins/x/sub' })
    expect(expectedScope(['plugins/x/sub/f.py'], projects)).toEqual(['inner'])
    expect(expectedScope(['plugins/x/other.py'], projects)).toEqual(['outer'])
  })

  it('ディレクトリ名の前方一致は一致とみなさない', () => {
    expect(expectedScope(['plugins/pecot-workflow-extra/a.py'], PROJECTS)).toEqual(['repo'])
  })

  it('どのプロジェクトにも属さないファイルがあれば、末尾に repo を加える', () => {
    expect(expectedScope(['plugins/pecot-workflow/a.py', 'CLAUDE.md'], PROJECTS)).toEqual(['p-w', 'repo'])
    expect(expectedScope(['.githooks/pre-commit/x.sh'], PROJECTS)).toEqual(['repo'])
  })

  it('root が . のプロジェクトは全てを持つ', () => {
    const projects = projectsOf({ root: '.', lib: 'packages/lib' })
    expect(expectedScope(['README.md', 'packages/lib/a.ts'], projects)).toEqual(['lib', 'root'])
  })

  it('.nx/version-plans/ 配下は数えない。それだけなら空', () => {
    expect(expectedScope(['plugins/pecot-workflow/a.py', '.nx/version-plans/1-x.md'], PROJECTS)).toEqual(['p-w'])
    expect(expectedScope(['.nx/version-plans/1-x.md'], PROJECTS)).toEqual([])
  })

  it('.nx/nx-release のプロジェクトは version-plans ではない', () => {
    expect(expectedScope(['.nx/nx-release/src/x.js'], PROJECTS)).toEqual(['repo'])
  })

  it('差分が空なら空', () => {
    expect(expectedScope([], PROJECTS)).toEqual([])
  })

  it('同じ scope の tag を持つ複数のプロジェクトは 1 つにまとまる', () => {
    const files = ['libs/text-rules/a.ts', 'libs/slide-kit/b.ts', 'plugins/pecot-workflow/c.py']
    expect(expectedScope(files, PROJECTS)).toEqual(['libs', 'p-w'])
  })

  it('scope が repo のプロジェクトを、昇順の並びから外して末尾へ置く', () => {
    const files = ['.nx/nx-release/src/x.js', 'plugins/pecot-workflow/c.py', 'CLAUDE.md']
    expect(expectedScope(files, PROJECTS)).toEqual(['p-w', 'repo'])
  })

  it('scope の tag が無いプロジェクトは、プロジェクト名を使う', () => {
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
  ])('タイトル %j のとき、scope を期待の配列か undefined で返す', (title, expected) => {
    expect(parseTitleScope(title)).toEqual(expected)
  })
})

describe('実 nx の契約（graph の出力形式）', () => {
  // plugin ルートの 2 つ上がリポジトリルート
  const repositoryRoot = path.resolve(pluginRoot(), '..', '..')

  it.skipIf(!existsSync(path.join(repositoryRoot, 'node_modules', '.bin', 'nx')))('リポジトリ実体の nx の graph から plugin の root を読める', () => {
    const projects = nxProjects(repositoryRoot)
    expect(projects?.get('pecot-workflow')?.root).toBe('plugins/pecot-workflow')
    expect(projects?.get('pecot-visual')?.root).toBe('plugins/pecot-visual')
    expect(projects === undefined ? undefined : expectedScope(['plugins/pecot-workflow/cli/x.py'], projects)).toEqual(['p-w'])
  }, 120_000)
})

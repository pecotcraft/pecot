/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// release の 3 個のケースが使う一時の環境。origin は GIT_SSH の偽物で一時の bare につなぎ、GitHub は偽サーバで受ける。
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { expect } from 'vitest'

import { runCli } from '../../src/cli.js'
import type { CliContext } from '../../src/cli.js'
import { RELEASE_COMMANDS } from '../../src/commands/release.js'
import { capture } from '../../src/commands/tests/support.js'
import { setEnvironment } from '../../src/tests/_helpers/environment.js'
import { installFakeExecutable, installFakeGh, prependToPath } from '../../src/tests/_helpers/fake-executables.js'
import { gitForTest } from '../../src/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../src/tests/_helpers/temporary.js'
import { startFakeGithub } from '../fake-github/server.js'
import type { RecordedRequest, ResponseRule, ResponseSpec } from '../fake-github/server.js'

export const HOST = 'ghes.example.com'
export const OWNER = 'acme'
export const NAME = 'demo'
const TOKEN_VARIABLE = 'PECOT_GITHUB_GHES_EXAMPLE_COM_TOKEN'

export const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-01-02

### 追加

- 新機能 A
- 新機能 B

## [0.1.0] - 2026-01-01

### 追加

- 初回リリース
`

/**
CHANGELOG の 0.2.0 の節の本文
*/
export const NOTES_0_2_0 = '### 追加\n\n- 新機能 A\n- 新機能 B'

export interface ProjectOptions {
  /**
  設定ファイルの repositories。省略すると acme/demo の 1 件（develop と release のブランチ付き）
  */
  readonly repositories?: readonly Readonly<Record<string, unknown>>[]
  /**
  false ならアクティブなプロジェクトを置かない
  */
  readonly isActive?: boolean
  /**
  git の remote。省略すると origin だけ。空なら remote を持たない
  */
  readonly remotes?: Readonly<Record<string, string>>
  /**
  false なら git のリポジトリにしない
  */
  readonly isGit?: boolean
  /**
  none は bare のリモートを作らない。empty は空の bare を置く。branches は release と、その先の develop を置く
  */
  readonly remote?: 'branches' | 'empty' | 'none'
  /**
  develop が release より進んでいるコミット数。既定は 1
  */
  readonly developAhead?: number
  readonly localTags?: readonly string[]
  readonly remoteTags?: readonly string[]
  /**
  リポジトリのルートに置くファイル。CHANGELOG.md の既定は CHANGELOG で、undefined なら置かない
  */
  readonly files?: Readonly<Record<string, string | undefined>>
  /**
  false なら GitHub のトークンを置かない
  */
  readonly hasToken?: boolean
}

export interface Project {
  /**
  作業ディレクトリ。git のリポジトリでなければ、ただのディレクトリ
  */
  readonly directory: string
  readonly root: string
  /**
  PATH の先頭に置いた偽物の置き場
  */
  readonly bin: string
}

function configFile(repositories: readonly Readonly<Record<string, unknown>>[]): string {
  return JSON.stringify({
    host: HOST,
    owner: OWNER,
    workflow_suffix: 'acme',
    project: {
      number: 1,
      id: 'PVT_1',
      board_url: `https://${HOST}/users/${OWNER}/projects/1`,
      fields: { workflow: { id: 'PVTSSF_workflow', options: { backlog: 'o1', pending: 'o2', ready: 'o3', active: 'o4', in_review: 'o5', archived: 'o6' } } },
    },
    repositories,
  }, undefined, 2)
}

export const DEFAULT_REPOSITORY = { owner: OWNER, name: NAME, develop_branch: 'develop', release_branch: 'release' }

// git が ssh として呼ぶ形は `fake-ssh <host> <git-upload-pack 'owner/repo.git'>`。host は見ず、bare に向ける
function writeFakeSsh(bin: string, remotes: string): string {
  const file = path.join(bin, 'fake-ssh')
  const quoted = `'${remotes.replaceAll('\'', String.raw`'\''`)}'`
  writeFileSync(file, `#!/bin/sh\ncmd="$(eval "printf '%s\\n' $(printf '%s' "$2" | sed 's/^[^ ]* //')")"\nprog="\${2%% *}"\nexec git "\${prog#git-}" ${quoted}/"$cmd"\n`)
  chmodSync(file, 0o755)
  return file
}

function commit(directory: string, file: string, content: string): void {
  writeFileSync(path.join(directory, file), content)
  gitForTest(directory, ['add', '-A'])
  gitForTest(directory, ['commit', '-q', '-m', `change ${file}`])
}

function publish(directory: string, bare: string, options: Readonly<ProjectOptions>): void {
  gitForTest(directory, ['push', '-q', bare, 'main:release'])
  if ((options.remote ?? 'none') !== 'branches') return
  gitForTest(directory, ['checkout', '-q', '-b', 'develop'])
  for (let index = 0; index < (options.developAhead ?? 1); index += 1) commit(directory, `feature-${String(index)}.txt`, 'x\n')
  gitForTest(directory, ['push', '-q', bare, 'develop'])
  gitForTest(directory, ['checkout', '-q', 'main'])
}

function tag(directory: string, bare: string, options: Readonly<ProjectOptions>): void {
  const localTags = options.localTags ?? []
  const remoteTags = options.remoteTags ?? []
  for (const name of localTags) gitForTest(directory, ['tag', name])
  for (const name of remoteTags) {
    gitForTest(directory, ['tag', name])
    gitForTest(directory, ['push', '-q', bare, `refs/tags/${name}`])
    if (!localTags.includes(name)) gitForTest(directory, ['tag', '-d', name])
  }
}

export function createProject(options: Readonly<ProjectOptions> = {}): Project {
  const root = makeTemporaryDirectory('pecot-release-')
  const directory = path.join(root, 'base', NAME)
  const bin = path.join(root, 'bin')
  const bare = path.join(root, 'remotes', OWNER, `${NAME}.git`)
  mkdirSync(directory, { recursive: true })
  mkdirSync(bin, { recursive: true })
  installFakeGh(bin)
  prependToPath(bin)
  setEnvironment({
    GIT_CEILING_DIRECTORIES: root,
    GIT_SSH: writeFakeSsh(bin, path.join(root, 'remotes')),
    GIT_SSH_VARIANT: 'simple',
    [TOKEN_VARIABLE]: options.hasToken === false ? undefined : 'dummy-token',
  })

  if (options.isGit !== false) {
    gitForTest(directory, ['init', '-q', '-b', 'main'])
    gitForTest(directory, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(path.join(directory, '.gitignore'), '.pecot/\n')
    commit(directory, 'README.md', '# demo\n')
    const remotes = options.remotes ?? { origin: `git@${HOST}:${OWNER}/${NAME}.git` }
    for (const [name, url] of Object.entries(remotes)) gitForTest(directory, ['remote', 'add', name, url])
    if ((options.remote ?? 'none') !== 'none') {
      mkdirSync(bare, { recursive: true })
      gitForTest(bare, ['init', '--bare', '-q', '-b', 'main'])
      if (options.remote === 'branches') publish(directory, bare, options)
      tag(directory, bare, options)
    }
  }

  const files: Readonly<Record<string, string | undefined>> = { 'CHANGELOG.md': CHANGELOG, ...options.files }
  for (const [relative, content] of Object.entries(files)) {
    if (content === undefined) continue
    mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true })
    writeFileSync(path.join(directory, relative), content)
  }
  if (options.isActive !== false) {
    const name = `${HOST}_${OWNER}_board_acme.json`
    const projects = path.join(directory, '.pecot', 'config', 'projects')
    mkdirSync(projects, { recursive: true })
    writeFileSync(path.join(projects, name), configFile(options.repositories ?? [DEFAULT_REPOSITORY]))
    writeFileSync(path.join(projects, '.active'), `${name}\n`)
  }
  return { directory, root, bin }
}

/**
git remote get-url の nth 回目から失敗する git を PATH の先頭に置く。
リポジトリの一致の確認では読めて、その後の対象の決定では読めない状態を作る
*/
export function failRemoteLookupFrom(project: Readonly<Project>, nth: number): void {
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const counter = path.join(project.bin, 'lookups')
  const body = `if [ "$1" = remote ] && [ "$2" = get-url ]; then
  n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'
  if [ "$n" -ge ${String(nth)} ]; then echo 'fatal: no such remote' >&2; exit 2; fi
fi
exec '${real}' "$@"
`
  installFakeExecutable(project.bin, 'git', body)
}

export function rest(method: string, requestPath: string, status: number, body?: unknown, times = 1): ResponseRule {
  let respond: ResponseSpec = { status, body }
  if (body === undefined) respond = { status }
  else if (typeof body === 'string') respond = { status, text: body }
  return { match: { method, path: requestPath }, respond, times }
}

export function pullRequestResponse(fields: { readonly state?: string, readonly mergeable?: string, readonly head?: string, readonly base?: string } = {}): ResponseRule {
  const { state = 'OPEN', mergeable = 'MERGEABLE', head = 'develop', base = 'release' } = fields
  const pullRequest = { number: 31, state, title: 'release', body: '', headRefName: head, baseRefName: base, isDraft: false, mergeable, comments: { totalCount: 0 }, closingIssuesReferences: { nodes: [] }, reviews: { nodes: [] } }
  return { match: { operation: 'GetPullRequestSlim' }, respond: { status: 200, body: { data: { repository: { pullRequest } } } }, times: 1 }
}

/**
release check が数える commit 数の応答（GitHub の compare API の ahead_by）
*/
export function compareRule(ahead: number, repository = `${OWNER}/${NAME}`, base = 'release', head = 'develop'): ResponseRule {
  return rest('GET', `/repos/${repository}/compare/${base}...${head}`, 200, { ahead_by: ahead })
}

export type AlertKind = 'code' | 'dependabot' | 'secret'

export function alertPath(kind: AlertKind, repository = `${OWNER}/${NAME}`): string {
  const segments = new Map<AlertKind, string>([['code', 'code-scanning'], ['dependabot', 'dependabot'], ['secret', 'secret-scanning']])
  return `/repos/${repository}/${segments.get(kind) ?? kind}/alerts`
}

/**
3 種の alert の一覧の応答。overrides に書いた種類だけ差し替え、ほかは 0 件にする
*/
export function alertRules(overrides: Readonly<Partial<Record<AlertKind, readonly ResponseRule[]>>> = {}, repository = `${OWNER}/${NAME}`): readonly ResponseRule[] {
  const kinds: readonly AlertKind[] = ['dependabot', 'code', 'secret']
  return kinds.flatMap(kind => new Map(Object.entries(overrides)).get(kind) ?? [rest('GET', alertPath(kind, repository), 200, [])])
}

export interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly requests: readonly RecordedRequest[]
}

export interface RunOptions {
  /**
  作業ディレクトリ。省略すると project.directory
  */
  readonly cwd?: string
}

/**
release の 3 個を、プロセス内で呼ぶ。偽サーバの応答は rules の順に使う
*/
export async function runRelease(project: Readonly<Project>, argv: readonly string[], rules: readonly ResponseRule[] = [], options: Readonly<RunOptions> = {}): Promise<RunResult> {
  const server = await startFakeGithub(rules)
  setEnvironment({ PECOT_GITHUB_API_URL: server.url })
  const io = capture()
  const cwd = options.cwd ?? project.directory
  const context: CliContext = { commands: RELEASE_COMMANDS, io, cwd, environment: {}, terminalColumns: undefined }
  const original = process.cwd()
  try {
    process.chdir(cwd)
    const code = await runCli(argv, context)
    expect({ problems: server.problems(), unused: server.unused() }).toEqual({ problems: [], unused: [] })
    return { code, stdout: io.out.join(''), stderr: io.err.join(''), requests: server.requests() }
  }
  finally {
    process.chdir(original)
    await server.close()
  }
}

/**
受けた REST の要求を、メソッドとパスの対にする
*/
export function pathsOf(result: Readonly<Pick<RunResult, 'requests'>>): readonly string[] {
  return result.requests.map(request => request.type === 'rest' ? `${request.method} ${request.path}` : request.operation)
}

/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは scenarios/ と golden/ 配下のみ */
// 前後比較のシナリオ（scenarios/<id>.yaml）と golden（golden/<id>.json）の型、読み込み、正規化。
// YAML と JSON は unknown として読み、型ガードで形を確かめる。形が崩れていれば読み込みの時点で落とす。
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { parse } from 'yaml'

import { OPERATION_NAMES } from '../fake-github/operations.js'
import type { ResponseMatch, ResponseRule, ResponseSpec } from '../fake-github/server.js'
import { compareStrings, isRecord, isStringArray } from './baseline.js'

export const scenariosDirectory = path.join(import.meta.dirname, 'scenarios')
export const goldenDirectory = path.join(import.meta.dirname, 'golden')

/**
id の `<path>-<kind>` の kind
*/
export type Kind = 'ok' | 'usage' | 'auth' | '4xx' | '5xx' | 'state'
export const KINDS: readonly Kind[] = ['ok', 'usage', 'auth', '4xx', '5xx', 'state']

/**
ファイルの中身。文字列か、symlink の指す先
*/
export type FileSpec = string | Readonly<{ symlink: string }>

export interface CommitSetup {
  readonly message: string
  readonly files: Readonly<Record<string, FileSpec>>
}

export interface BranchSetup {
  readonly name: string
  /**
  main から分けたブランチの上に積むコミット
  */
  readonly commits: readonly CommitSetup[]
}

export interface TagSetup {
  readonly name: string
  /**
  タグを付けるブランチ名。無ければ最終的な HEAD
  */
  readonly at: string | undefined
  readonly isPushed: boolean
}

export interface WorktreeSetup {
  readonly name: string
  /**
  作るブランチ名。無ければ name
  */
  readonly branch: string | undefined
  /**
  サブワークツリーに置くだけのファイル（コミットしない。worktree を作った後に置く）
  */
  readonly files: Readonly<Record<string, FileSpec>>
}

export interface RepositorySetup {
  readonly owner: string
  readonly name: string
  readonly host: string
  /**
  最後に checkout しているブランチ
  */
  readonly branch: string
  /**
  初期コミットの上に積むコミット
  */
  readonly commits: readonly CommitSetup[]
  /**
  main から分けて origin へ push するブランチ。HEAD は branch のまま
  */
  readonly branches: readonly BranchSetup[]
  readonly tags: readonly TagSetup[]
  /**
  一時 root 直下の <name>/<repo> に作るサブワークツリー。name は wt で始める
  */
  readonly worktrees: readonly WorktreeSetup[]
  /**
  作業ツリーに置くだけのファイル（コミットしない）
  */
  readonly files: Readonly<Record<string, FileSpec>>
}

export interface Scenario {
  readonly id: string
  readonly command: Readonly<{ path: readonly string[], args: readonly string[] }>
  readonly stdin: string
  readonly setup: Readonly<{
    repo: RepositorySetup
    /**
    repo の中で実行するディレクトリ（repo ルートからの相対）。既定は repo ルート
    */
    cwd: string
    /**
    データ置き場（CLAUDE_PLUGIN_DATA）に置くファイル
    */
    data: Readonly<Record<string, FileSpec>>
    env: Readonly<Record<string, string>>
    /**
    gh stub が `gh auth token` で返すトークン。無ければ exit 1
    */
    ghToken: string | undefined
  }>
  readonly github: readonly ResponseRule[]
}

export interface Golden {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly requests: readonly unknown[]
  readonly files: Readonly<Record<string, unknown>>
}

function fail(id: string, message: string): never {
  throw new TypeError(`scenarios/${id}.yaml: ${message}`)
}

function optionalString(id: string, record: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value: unknown = Reflect.get(record, key)
  if (value === undefined) return fallback
  if (typeof value !== 'string') return fail(id, `${key} が文字列ではありません`)
  return value
}

function recordOf(id: string, value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === undefined) return {}
  if (!isRecord(value)) return fail(id, `${label} がオブジェクトではありません`)
  return value
}

function assertKeys(id: string, record: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const unknownKeys = Object.keys(record).filter(key => !allowed.includes(key))
  if (unknownKeys.length > 0) fail(id, `${label} に未知のキーがあります: ${unknownKeys.join(', ')}`)
}

function fileSpecs(id: string, value: unknown, label: string): Readonly<Record<string, FileSpec>> {
  const entries = Object.entries(recordOf(id, value, label)).map(([name, spec]): [string, FileSpec] => {
    if (typeof spec === 'string') return [name, spec]
    if (isRecord(spec) && typeof spec['symlink'] === 'string' && Object.keys(spec).length === 1) {
      return [name, { symlink: spec['symlink'] }]
    }
    return fail(id, `${label}.${name} は文字列か { symlink: <先> } にしてください`)
  })
  return Object.fromEntries(entries)
}

function stringRecord(id: string, value: unknown, label: string): Readonly<Record<string, string>> {
  const entries = Object.entries(recordOf(id, value, label)).map(([key, item]): [string, string] => {
    return typeof item === 'string' ? [key, item] : fail(id, `${label}.${key} が文字列ではありません`)
  })
  return Object.fromEntries(entries)
}

function stringList(id: string, value: unknown, label: string): readonly string[] {
  if (value === undefined) return []
  if (!isStringArray(value)) return fail(id, `${label} が文字列の配列ではありません`)
  return value
}

function commitSetups(id: string, value: unknown, label: string): readonly CommitSetup[] {
  if (value !== undefined && !Array.isArray(value)) fail(id, `${label} が配列ではありません`)
  const commits = (Array.isArray(value) ? value : []).map((item: unknown) => {
    const commit = recordOf(id, item, `${label}[]`)
    assertKeys(id, commit, ['message', 'files'], `${label}[]`)
    return {
      message: optionalString(id, commit, 'message', ''),
      files: fileSpecs(id, commit['files'], `${label}[].files`),
    }
  })
  if (commits.some(commit => commit.message === '')) fail(id, `${label}[].message が必要です`)
  return commits
}

function listOf(id: string, value: unknown, label: string): readonly unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return fail(id, `${label} が配列ではありません`)
  return value
}

function requiredName(id: string, record: Readonly<Record<string, unknown>>, label: string): string {
  const name = optionalString(id, record, 'name', '')
  if (name === '') fail(id, `${label}[].name が必要です`)
  return name
}

function branchSetups(id: string, value: unknown): readonly BranchSetup[] {
  return listOf(id, value, 'setup.repo.branches').map((item: unknown) => {
    if (typeof item === 'string') fail(id, 'setup.repo.branches[] は name と commits を持つオブジェクトにしてください')
    const branch = recordOf(id, item, 'setup.repo.branches[]')
    assertKeys(id, branch, ['name', 'commits'], 'setup.repo.branches[]')
    return {
      name: requiredName(id, branch, 'setup.repo.branches'),
      commits: commitSetups(id, branch['commits'], 'setup.repo.branches[].commits'),
    }
  })
}

function tagSetups(id: string, value: unknown): readonly TagSetup[] {
  return listOf(id, value, 'setup.repo.tags').map((item: unknown) => {
    const tag = recordOf(id, item, 'setup.repo.tags[]')
    assertKeys(id, tag, ['name', 'at', 'push'], 'setup.repo.tags[]')
    const push = tag['push']
    if (push !== undefined && typeof push !== 'boolean') fail(id, 'setup.repo.tags[].push が真偽値ではありません')
    return {
      name: requiredName(id, tag, 'setup.repo.tags'),
      at: tag['at'] === undefined ? undefined : optionalString(id, tag, 'at', ''),
      isPushed: push === true,
    }
  })
}

function worktreeSetups(id: string, value: unknown): readonly WorktreeSetup[] {
  return listOf(id, value, 'setup.repo.worktrees').map((item: unknown) => {
    const worktree = recordOf(id, item, 'setup.repo.worktrees[]')
    assertKeys(id, worktree, ['name', 'branch', 'files'], 'setup.repo.worktrees[]')
    const name = requiredName(id, worktree, 'setup.repo.worktrees')
    if (!name.startsWith('wt')) fail(id, `setup.repo.worktrees[].name は wt で始めてください: ${name}`)
    return {
      name,
      branch: worktree['branch'] === undefined ? undefined : optionalString(id, worktree, 'branch', ''),
      files: fileSpecs(id, worktree['files'], 'setup.repo.worktrees[].files'),
    }
  })
}

function repositorySetup(id: string, value: unknown): RepositorySetup {
  const repository = recordOf(id, value, 'setup.repo')
  assertKeys(id, repository, ['owner', 'name', 'host', 'branch', 'commits', 'branches', 'tags', 'worktrees', 'files'], 'setup.repo')
  const commits = commitSetups(id, repository['commits'], 'setup.repo.commits')
  return {
    owner: optionalString(id, repository, 'owner', 'acme'),
    name: optionalString(id, repository, 'name', 'demo'),
    host: optionalString(id, repository, 'host', 'ghes.example.com'),
    branch: optionalString(id, repository, 'branch', 'main'),
    commits,
    branches: branchSetups(id, repository['branches']),
    tags: tagSetups(id, repository['tags']),
    worktrees: worktreeSetups(id, repository['worktrees']),
    files: fileSpecs(id, repository['files'], 'setup.repo.files'),
  }
}

function responseRule(id: string, value: unknown, index: number): ResponseRule {
  const label = `github[${String(index)}]`
  const rule = recordOf(id, value, label)
  assertKeys(id, rule, ['match', 'respond', 'times'], label)
  const match = recordOf(id, rule['match'], `${label}.match`)
  assertKeys(id, match, ['method', 'path', 'operation', 'query', 'variables', 'body'], `${label}.match`)
  const respond = recordOf(id, rule['respond'], `${label}.respond`)
  assertKeys(id, respond, ['status', 'body', 'text', 'headers'], `${label}.respond`)
  const { status, times } = { status: respond['status'], times: rule['times'] ?? 1 }
  if (typeof status !== 'number' || !Number.isSafeInteger(status)) fail(id, `${label}.respond.status が整数ではありません`)
  if (typeof times !== 'number' || !Number.isSafeInteger(times) || times < 1) fail(id, `${label}.times が 1 以上の整数ではありません`)
  const operation = match['operation']
  if (operation !== undefined && (typeof operation !== 'string' || !OPERATION_NAMES.has(operation))) {
    fail(id, `${label}.match.operation が対応表（tests/fake-github/operations.ts）にありません: ${JSON.stringify(operation)}`)
  }
  const matchSpec: ResponseMatch = {
    method: match['method'] === undefined ? undefined : optionalString(id, match, 'method', ''),
    path: match['path'] === undefined ? undefined : optionalString(id, match, 'path', ''),
    operation: typeof operation === 'string' ? operation : undefined,
    query: match['query'] === undefined ? undefined : stringRecord(id, match['query'], `${label}.match.query`),
    variables: match['variables'],
    body: match['body'],
  }
  if (matchSpec.method === undefined && matchSpec.path === undefined && matchSpec.operation === undefined) {
    fail(id, `${label}.match に method・path・operation のどれかが必要です`)
  }
  const respondSpec: ResponseSpec = {
    status,
    body: respond['body'],
    text: respond['text'] === undefined ? undefined : optionalString(id, respond, 'text', ''),
    headers: respond['headers'] === undefined ? undefined : stringRecord(id, respond['headers'], `${label}.respond.headers`),
  }
  return { match: matchSpec, respond: respondSpec, times }
}

/**
サブコマンドを持たない起動（グローバルオプションだけ）の id の接頭辞
*/
export const GLOBAL_ID_PREFIX = 'global'

/**
id から、path の次に来る kind を取り出す。形が合わなければ undefined。
path が空（グローバルオプションだけ）の id は `global-<kind>...` にする
*/
export function kindOf(scenario: Readonly<Pick<Scenario, 'id' | 'command'>>): Kind | undefined {
  const prefix = `${scenario.command.path.length === 0 ? GLOBAL_ID_PREFIX : scenario.command.path.join('-')}-`
  if (!scenario.id.startsWith(prefix)) return undefined
  const [kind] = scenario.id.slice(prefix.length).split('-', 1)
  return KINDS.find(candidate => candidate === kind)
}

export function parseScenario(id: string, text: string): Scenario {
  const root = recordOf(id, parse(text), 'ルート')
  assertKeys(id, root, ['id', 'command', 'stdin', 'setup', 'github'], 'ルート')
  if (root['id'] !== id) fail(id, `id がファイル名と違います: ${String(root['id'])}`)
  const command = recordOf(id, root['command'], 'command')
  assertKeys(id, command, ['path', 'args'], 'command')
  const commandPath = stringList(id, command['path'], 'command.path')
  const setup = recordOf(id, root['setup'], 'setup')
  assertKeys(id, setup, ['repo', 'cwd', 'data', 'env', 'gh'], 'setup')
  const gh = recordOf(id, setup['gh'], 'setup.gh')
  assertKeys(id, gh, ['token'], 'setup.gh')
  const github = root['github']
  if (github !== undefined && !Array.isArray(github)) fail(id, 'github が配列ではありません')
  const scenario: Scenario = {
    id,
    command: { path: commandPath, args: stringList(id, command['args'], 'command.args') },
    stdin: optionalString(id, root, 'stdin', ''),
    setup: {
      repo: repositorySetup(id, setup['repo']),
      cwd: optionalString(id, setup, 'cwd', '.'),
      data: fileSpecs(id, setup['data'], 'setup.data'),
      env: stringRecord(id, setup['env'], 'setup.env'),
      ghToken: gh['token'] === undefined ? undefined : optionalString(id, gh, 'token', ''),
    },
    github: (Array.isArray(github) ? github : []).map((item: unknown, index) => responseRule(id, item, index)),
  }
  if (kindOf(scenario) === undefined) {
    fail(id, `id は <command.path を - でつないだもの（空なら global）>-<${KINDS.join('|')}>[-<詳細>] にしてください`)
  }
  return scenario
}

/**
scenarios/ の id を昇順で返す
*/
export function scenarioIds(): string[] {
  return readdirSync(scenariosDirectory)
    .filter(name => name.endsWith('.yaml'))
    .map(name => name.slice(0, -'.yaml'.length))
    .toSorted(compareStrings)
}

export function readScenario(id: string): Scenario {
  return parseScenario(id, readFileSync(path.join(scenariosDirectory, `${id}.yaml`), 'utf8'))
}

export function goldenPath(id: string): string {
  return path.join(goldenDirectory, `${id}.json`)
}

export function readGolden(id: string): Golden {
  const parsed: unknown = JSON.parse(readFileSync(goldenPath(id), 'utf8'))
  if (!isRecord(parsed)) throw new TypeError(`golden/${id}.json: ルートがオブジェクトではありません`)
  const { stdout, stderr, exitCode, requests, files } = parsed
  if (typeof stdout !== 'string' || typeof stderr !== 'string' || typeof exitCode !== 'number') {
    throw new TypeError(`golden/${id}.json: stdout・stderr・exitCode の型が違います`)
  }
  if (!Array.isArray(requests) || !isRecord(files)) {
    throw new TypeError(`golden/${id}.json: requests が配列でない、または files がオブジェクトではありません`)
  }
  return { stdout, stderr, exitCode, requests, files }
}

export interface Substitution {
  readonly from: string
  readonly to: string
}

// 実行のたびに変わるのは YYYYMMDD-HHMMSS だけ。ISO 形式の日時は GIT_*_DATE と偽サーバの応答で固定されており、
// 置き換えると実装の日時の誤りを隠すため、置き換えない
const TIMESTAMP_PATTERN = /\b\d{8}-\d{6}\b/gu

export function normalizeText(text: string, substitutions: readonly Substitution[]): string {
  let replaced = text
  for (const { from, to } of substitutions) replaced = replaced.split(from).join(to)
  return replaced.replaceAll(TIMESTAMP_PATTERN, '{{TIMESTAMP}}')
}

/**
文字列・オブジェクトのキー・配列の中身すべてに normalizeText をかける
*/
export function normalizeDeep(value: unknown, substitutions: readonly Substitution[]): unknown {
  if (typeof value === 'string') return normalizeText(value, substitutions)
  if (Array.isArray(value)) return value.map((item: unknown) => normalizeDeep(item, substitutions))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [normalizeText(key, substitutions), normalizeDeep(item, substitutions)]),
    )
  }
  return value
}

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ。node の子プロセス・ストリームの型は readonly にできない */
// シナリオ 1 件を流して、golden と同じ形の結果を作る。record.ts（Python）と parity.test.ts（Node）が共有する。
// 流れ: 一時 root と偽サーバを用意し、CLI を子プロセスで起動し、.pecot/ とデータ置き場を回収し、正規化する。
// 子プロセスは非同期で起動する。spawnSync だと、同じプロセスの偽サーバのループが止まるため。
import { spawn } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import path from 'node:path'

import { loadVersionFromPluginJson } from '../../src/version.js'
import { startFakeGithub } from '../fake-github/server.js'
import { compareStrings } from './baseline.js'
import type { Golden, Scenario, Substitution } from './scenario.js'
import { normalizeDeep, normalizeText } from './scenario.js'
import { baseEnvironment, createSandbox, destroySandbox, pluginRoot } from './setup.js'

/**
起動する CLI。Python は bin/pecot、Node は process.execPath + dist/cli.js
*/
export interface Launcher {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface Outcome {
  readonly golden: Golden
  /**
  子プロセスを起動できなかった理由（ENOENT など）。起動できたら undefined
  */
  readonly spawnError: string | undefined
  /**
  シグナルで終わったときのシグナル名
  */
  readonly signal: string | undefined
  readonly timedOut: boolean
  /**
  偽サーバが見つけた誤り
  */
  readonly problems: readonly string[]
  /**
  使われなかった応答
  */
  readonly unused: readonly string[]
}

export const CHILD_TIMEOUT_MS = 25_000

const pluginVersion = loadVersionFromPluginJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json')) ?? ''

// 時間切れで止めた後、close を待つ上限
const FORCE_RESOLVE_MS = 2000

// データ置き場のうち、比べない置き場所
const DATA_EXCLUDED = new Set(['venv', 'runtime'])

function isNotFound(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'ENOENT'
}

function collect(baseDirectory: string, relative: string, prefix: string, files: Map<string, unknown>): void {
  const absolute = path.join(baseDirectory, relative)
  let stat
  try {
    stat = lstatSync(absolute)
  }
  catch (error) {
    // 無いものは飛ばす。権限などそれ以外の失敗は隠さない
    if (isNotFound(error)) return
    throw error
  }
  const key = `${prefix}${relative}`
  if (stat.isSymbolicLink()) {
    files.set(key, { symlink: readlinkSync(absolute) })
  }
  else if (stat.isDirectory()) {
    for (const name of readdirSync(absolute).toSorted(compareStrings)) {
      collect(baseDirectory, path.join(relative, name), prefix, files)
    }
  }
  else {
    files.set(key, readFileSync(absolute, 'utf8'))
  }
}

// 一時 root 直下のサブワークツリー（wt*/<repo>/）の中身。.git は除く。キーは作業リポからの相対にする
function collectWorktrees(root: string, repositoryDirectory: string, files: Map<string, unknown>): void {
  const repositoryName = path.basename(repositoryDirectory)
  for (const name of readdirSync(root).toSorted(compareStrings)) {
    if (!name.startsWith('wt')) continue
    const worktreeDirectory = path.join(root, name, repositoryName)
    const prefix = `${path.relative(repositoryDirectory, worktreeDirectory)}/`
    let entries: string[]
    try {
      entries = readdirSync(worktreeDirectory).toSorted(compareStrings)
    }
    catch (error) {
      // CLI がワークツリーを消した後は、無いものとして次へ進む
      if (isNotFound(error)) continue
      throw error
    }
    for (const entry of entries) {
      if (entry !== '.git') collect(worktreeDirectory, entry, prefix, files)
    }
  }
}

function collectFiles(root: string, repositoryDirectory: string, dataDirectory: string, substitutions: readonly Substitution[]): Record<string, unknown> {
  const files = new Map<string, unknown>()
  collect(repositoryDirectory, '.pecot', '', files)
  collectWorktrees(root, repositoryDirectory, files)
  for (const name of readdirSync(dataDirectory).toSorted(compareStrings)) {
    if (!DATA_EXCLUDED.has(name)) collect(dataDirectory, name, 'data/', files)
  }
  const sorted = [...files].toSorted(([a], [b]) => compareStrings(a, b))
  const normalized = normalizeDeep(Object.fromEntries(sorted), substitutions)
  return typeof normalized === 'object' && normalized !== null ? { ...normalized } : {}
}

interface ChildResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | undefined
  readonly signal: NodeJS.Signals | undefined
  readonly spawnError: string | undefined
  readonly timedOut: boolean
}

function runChild(
  launcher: Launcher,
  scenario: Scenario,
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    // 新しいプロセスグループで起動する。時間切れのとき、孫プロセスごと止めるため
    const child = spawn(launcher.command, [...launcher.args, ...scenario.command.path, ...scenario.command.args], {
      cwd,
      env: { ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let isTimedOut = false
    let isResolved = false
    let spawnError: string | undefined
    let forceTimer: NodeJS.Timeout | undefined
    const finish = (code: number | null | undefined, signal: NodeJS.Signals | null | undefined): void => {
      if (isResolved) return
      isResolved = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      resolve({ stdout, stderr, code: code ?? undefined, signal: signal ?? undefined, spawnError, timedOut: isTimedOut })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    // 子が stdin を読まずに終わると EPIPE になる。結果には関係しない
    child.stdin.on('error', () => {
      // 結果には関係しない
    })
    child.stdin.end(scenario.stdin)
    const timer = setTimeout(() => {
      isTimedOut = true
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        }
        catch {
          child.kill('SIGKILL')
        }
      }
      // 孫が出力のパイプを握ったままだと close が来ない。一定時間で強制的に解決する
      forceTimer = setTimeout(() => {
        finish(undefined, 'SIGKILL')
      }, FORCE_RESOLVE_MS)
    }, CHILD_TIMEOUT_MS)
    // 起動に失敗すると close は来ないことがある
    child.on('error', (error) => {
      spawnError = error.message
      finish(undefined, undefined)
    })
    child.on('close', finish)
  })
}

export async function runScenario(scenario: Scenario, launcher: Launcher): Promise<Outcome> {
  const sandbox = createSandbox(scenario)
  let server: Awaited<ReturnType<typeof startFakeGithub>> | undefined
  try {
    server = await startFakeGithub(scenario.github)
    const environment = {
      ...baseEnvironment(sandbox),
      PECOT_GITHUB_API_URL: server.url,
      ...scenario.setup.env,
      ...launcher.env,
    }
    const child = await runChild(launcher, scenario, path.resolve(sandbox.repositoryDirectory, scenario.setup.cwd), environment)
    const substitutions: readonly Substitution[] = [
      { from: sandbox.root, to: '{{TMP}}' },
      { from: pluginRoot, to: '{{PLUGIN_ROOT}}' },
      { from: server.url, to: '{{GITHUB_API}}' },
      // リリースで版が上がっても golden を作り直さずに済むよう、--version の出力だけ固定の文字にする
      { from: `pecot version ${pluginVersion}`, to: 'pecot version {{VERSION}}' },
    ]
    return {
      golden: {
        stdout: normalizeText(child.stdout, substitutions),
        stderr: normalizeText(child.stderr, substitutions),
        // code が null になるのはシグナルで終わったとき。-1 は golden に残さない値の代わりで、signal 側で検出する
        exitCode: child.code ?? -1,
        requests: server.requests().map(request => normalizeDeep(request, substitutions)),
        files: collectFiles(sandbox.root, sandbox.repositoryDirectory, sandbox.dataDirectory, substitutions),
      },
      spawnError: child.spawnError,
      signal: child.signal,
      timedOut: child.timedOut,
      problems: server.problems(),
      unused: server.unused(),
    }
  }
  finally {
    try {
      await server?.close()
    }
    finally {
      destroySandbox(sandbox)
    }
  }
}

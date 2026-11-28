/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の JSON-RPC の型は mutable */
// 子プロセスを待つ MCP のツールが ping に答え、取り消しで子を止めること（PW-COMMON-24・25）を、同じプロセスのクライアントから確かめる。
// git のリモートは GIT_SSH、gh と nx は眠る偽物で待たせる。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'

import { createMcpServer } from '../../src/mcp/server.js'
import { TOOLS } from '../../src/commands/registry.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { explains } from '../_helpers/explains.js'
import { verifies } from '../_helpers/verifies.js'
import { stateFile } from '../_helpers/workspace-inspect.js'
import { openWorkspace } from '../_helpers/workspace.js'
import type { Workspace } from '../_helpers/workspace.js'
import { AttachingClient } from '../_helpers/attaching-client.js'

useIsolatedEnvironment()

const LOWER = 'feat/demo/11'
const UPPER = 'feat/demo/12'
const PING_LIMIT_MILLISECONDS = 1000
const GONE_LIMIT_MILLISECONDS = 2000

interface Sleeper {
  readonly script: string
  readonly pidFile: string
}

// 起動されると自分の pid を書き、長く眠る。exec で pid を変えずに眠る
function writeSleeper(directory: string, name: string): Sleeper {
  mkdirSync(directory, { recursive: true })
  const script = path.join(directory, name)
  const pidFile = `${script}.pid`
  writeFileSync(script, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`)
  chmodSync(script, 0o755)
  return { script, pidFile }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function pidOf(sleeper: Readonly<Sleeper>): Promise<number> {
  await expect.poll(() => existsSync(sleeper.pidFile) && readFileSync(sleeper.pidFile, 'utf8').trim() !== '', { timeout: 10_000, interval: 50 }).toBe(true)
  return Number(readFileSync(sleeper.pidFile, 'utf8').trim())
}

// 子ブランチを checkout し、親ブランチの今の remote の先頭で base の記録を書く
async function openStacked(): Promise<Workspace> {
  const workspace = await openWorkspace({ branches: [{ name: LOWER, commits: [{ message: 'lower', files: { 'lower.txt': '1\n' } }] }] })
  workspace.git(['checkout', '-q', '-b', UPPER, `origin/${LOWER}`])
  const record = path.join(workspace.directory, stateFile('.pecot-base'))
  mkdirSync(path.dirname(record), { recursive: true })
  writeFileSync(record, `${LOWER} ${workspace.git(['rev-parse', `origin/${LOWER}`]).trim()} acme/demo#11\n`)
  return workspace
}

// git のリモートの接続（GIT_SSH）を眠る偽物に替える
function hangRemote(workspace: Readonly<Workspace>): Sleeper {
  const sleeper = writeSleeper(path.join(workspace.root, 'hang'), 'ssh')
  setEnvironment({ GIT_SSH: sleeper.script })
  return sleeper
}

interface Hang {
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly sleeper: Sleeper
  readonly directory: string
  /**
  コマンドの続きが動けば変わる状態。取り消しの前と後で比べる
  */
  readonly state?: () => string
}

interface Observed {
  readonly isPingInTime: boolean
  readonly isChildAliveAtPing: boolean
  readonly isCallRejected: boolean
  readonly isUnanswered: boolean
  readonly isChildGone: boolean
  readonly isStateUnchanged: boolean
  readonly isNextCallInTime: boolean
}

const RESPONSIVE: Observed = { isPingInTime: true, isChildAliveAtPing: true, isCallRejected: true, isUnanswered: true, isChildGone: true, isStateUnchanged: true, isNextCallInTime: true }

type Message = Parameters<InMemoryTransport['send']>[0]

interface RecordedConnection {
  readonly client: Client
  /**
  クライアントが送った tools/call の要求の id
  */
  readonly calls: readonly (number | string)[]
  /**
  サーバが応答（result か error）を送った要求の id
  */
  readonly answered: readonly (number | string)[]
  readonly close: () => Promise<void>
}

function responseId(message: Message): number | string | undefined {
  return 'id' in message && ('result' in message || 'error' in message) ? message.id : undefined
}

function toolCallId(message: Message): number | string | undefined {
  return 'id' in message && 'method' in message && message.method === 'tools/call' ? message.id : undefined
}

// 両端の送信を記録してつなぐ。取り消した要求にサーバが応答を送らないことを、サーバの送信で確かめる
async function connectRecording(): Promise<RecordedConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const calls: (number | string)[] = []
  const answered: (number | string)[] = []
  const sendFromServer = serverTransport.send.bind(serverTransport)
  serverTransport.send = async (message, options) => {
    const id = responseId(message)
    if (id !== undefined) answered.push(id)
    await sendFromServer(message, options)
  }
  const sendFromClient = clientTransport.send.bind(clientTransport)
  clientTransport.send = async (message, options) => {
    const id = toolCallId(message)
    if (id !== undefined) calls.push(id)
    await sendFromClient(message, options)
  }
  const server = createMcpServer(TOOLS)
  const client = new AttachingClient({ name: 'test-client', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    calls,
    answered,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

async function isRejected(pending: Promise<unknown>): Promise<boolean> {
  try {
    await pending
    return false
  }
  catch {
    return true
  }
}

// 子を起こす前に答えたなら、その結果を失敗の文に出す。拒まれたら（取り消し）決着しない
async function failOnEarlyAnswer(pending: Promise<Readonly<{ structuredContent?: unknown }>>): Promise<never> {
  let result: Readonly<{ structuredContent?: unknown }>
  try {
    result = await pending
  }
  catch {
    return await new Promise<never>(() => {
      // 取り消しの拒否は isRejected が受ける
    })
  }
  throw new Error(`子を起こす前に答えた: ${JSON.stringify(result.structuredContent)}`)
}

async function isGoneWithin(pid: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  return !isAlive(pid)
}

// ツールを呼び、子を待つ間に ping を送って取り消す。見るのは、子の終わり・応答の有無・状態の変化・次の呼び出しの速さ
async function pingAndCancel(hang: Readonly<Hang>): Promise<Observed> {
  const previous = process.cwd()
  process.chdir(hang.directory)
  const connected = await connectRecording()
  try {
    const stateBefore = hang.state?.()
    const controller = new AbortController()
    const raw = connected.client.callTool({ name: hang.name, arguments: { ...hang.arguments } }, { signal: controller.signal })
    const rejected = isRejected(raw)
    const pid = await Promise.race([pidOf(hang.sleeper), failOnEarlyAnswer(raw)])
    const [cancelledId] = connected.calls

    const pingStarted = Date.now()
    await connected.client.ping()
    const isPingInTime = Date.now() - pingStarted < PING_LIMIT_MILLISECONDS
    const isChildAliveAtPing = isAlive(pid)

    controller.abort('cancelled by the test')
    const isCallRejected = await rejected
    const isChildGone = await isGoneWithin(pid, GONE_LIMIT_MILLISECONDS)

    const nextStarted = Date.now()
    await connected.client.callTool({ name: 'session_show', arguments: {} })
    const isNextCallInTime = Date.now() - nextStarted < PING_LIMIT_MILLISECONDS * 5
    // 次の呼び出しの応答が届いた時点で、取り消した要求の応答が送られていない
    const isUnanswered = cancelledId !== undefined && !connected.answered.includes(cancelledId)
    const isStateUnchanged = hang.state?.() === stateBefore
    return { isPingInTime, isChildAliveAtPing, isCallRejected, isUnanswered, isChildGone, isStateUnchanged, isNextCallInTime }
  }
  finally {
    await connected.close()
    process.chdir(previous)
  }
}

it('pr_restack が fetch を待つ間、ping に答え、取り消すとリモートの接続を止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  await explains('`pr_restack` が `git fetch` の完了を待っている間の、MCP サーバの応答のテストです。リモートへの接続が応答しない場合に、`ping` へ時間内に答え、呼び出しを取り消すと接続のプロセスが終了し、状態が変化しないことを確認します。')
  const workspace = await openStacked()
  const sleeper = hangRemote(workspace)
  expect(await pingAndCancel({ name: 'pr_restack', arguments: {}, sleeper, directory: workspace.directory, state: () => readFileSync(path.join(workspace.directory, stateFile('.pecot-base')), 'utf8') + workspace.git(['rev-parse', 'HEAD']) })).toEqual(RESPONSIVE)
})

it('pr_check が ls-remote を待つ間、ping に答え、取り消すとリモートの接続を止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  await explains('`pr_check` が、remote とずれたスタックのブランチの直し方を決めるために `git ls-remote` を待っている間の、MCP サーバの応答のテストです。リモートへの接続が応答しない場合に、`ping` へ時間内に答え、呼び出しを取り消すと接続のプロセスが終了し、取り消した要求に応答を返さないことを確認します。')
  const workspace = await openStacked()
  workspace.git(['commit', '-q', '--allow-empty', '-m', 'pushed'])
  workspace.git(['push', '-q', '-u', 'origin', UPPER])
  workspace.git(['commit', '-q', '--amend', '--allow-empty', '-m', 'rewritten'])
  const sleeper = hangRemote(workspace)
  const lower = { number: 11, state: 'open', html_url: 'https://ghes.example.com/acme/demo/pull/11', head: { ref: LOWER }, base: { ref: 'main' } }
  const arguments_ = { method: 'create', owner: 'acme', repo: 'demo', title: 'feat: #12 変更', head: UPPER, base: LOWER, body: 'Closes #12\n', reads: { pull_requests: [lower] } }
  expect(await pingAndCancel({ name: 'pr_check', arguments: arguments_, sleeper, directory: workspace.directory })).toEqual(RESPONSIVE)
})

it('session_finish が git pull を待つ間、ping に答え、取り消すとリモートの接続を止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  await explains('`session_finish` が `git pull` の完了を待っている間の、MCP サーバの応答のテストです。リモートへの接続が応答しない場合に、`ping` へ時間内に答え、呼び出しを取り消すとプロセスが終了し、ブランチの状態が変化しないことを確認します。')
  const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER, commits: [{ message: 'change', files: { 'feature.txt': 'x\n' } }] }] })
  const sleeper = hangRemote(workspace)
  const pullRequest = { number: 21, state: 'closed', draft: false, merged: true, body: 'Closes #12\n', html_url: 'https://ghes.example.com/acme/demo/pull/21', head: { ref: UPPER }, base: { ref: 'main' } }
  const reads = { pull_request: pullRequest, blocking: [{ issue: 'acme/demo/12', result: { issues: [] } }], children: [] }
  expect(await pingAndCancel({ name: 'session_finish', arguments: { pr_ref: 'acme/demo/21', reads }, sleeper, directory: workspace.directory, state: () => workspace.git(['for-each-ref', '--format=%(refname)', `refs/heads/${UPPER}`]) })).toEqual(RESPONSIVE)
})

it('pr_check の題の scope の確認が nx graph を待つ間、ping に答え、取り消すと nx を止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  await explains('`pr_check` が題の scope を確認するために `nx graph` を待っている間の、MCP サーバの応答のテストです。`nx` が応答しない場合は、`ping` へ時間内に答え、呼び出しを取り消すと `nx` のプロセスが終了し、次の呼び出しにすぐ答えることを確認します。')
  const workspace = await openWorkspace({ config: { releaseType: 'nx' }, files: { 'nx.json': '{}\n' }, branch: UPPER, branches: [{ name: UPPER, commits: [{ message: 'change', files: { 'feature.txt': 'x\n' } }] }] })
  const sleeper = writeSleeper(path.join(workspace.directory, 'node_modules', '.bin'), 'nx')
  const arguments_ = { method: 'create', owner: 'acme', repo: 'demo', title: 'feat(demo): #12 変更', head: UPPER, base: 'main', body: 'body\n\nCloses #12\n' }
  expect(await pingAndCancel({ name: 'pr_check', arguments: arguments_, sleeper, directory: workspace.directory })).toEqual(RESPONSIVE)
})

it('worktree_add が setup_command を待つ間、ping に答え、取り消すとシェルの下のコマンドも止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  await explains('`worktree_add` が `setup_command` の完了を待っている間の、MCP サーバの応答のテストです。セットアップのコマンドが応答しない場合に、`ping` へ時間内に答え、呼び出しを取り消すとシェルの下で動くコマンドも終了することを確認します。')
  const workspace = await openWorkspace({ files: { '.pecot/config/worktree-config.json': '{"version": 3, "links": []}\n', '.pecot/config/.worktreeignore': '.git/\n.pecot/\n' } })
  setEnvironment({ DEVCONTAINER: '1', REMOTE_CONTAINERS: undefined, CODESPACES: undefined })
  const sleeper = writeSleeper(path.join(workspace.root, 'hang'), 'setup')
  expect(await pingAndCancel({ name: 'worktree_add', arguments: { directory: workspace.directory, setup: sleeper.script }, sleeper, directory: workspace.directory })).toEqual(RESPONSIVE)
})

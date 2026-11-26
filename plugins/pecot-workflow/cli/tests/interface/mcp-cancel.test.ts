/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時 root 配下のみ */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の JSON-RPC の型は mutable */
// 子プロセスを待つ MCP のツールが ping に答え、取り消しで子を止めること（PW-COMMON-24・25）を、同じプロセスのクライアントから確かめる。
// git のリモートは GIT_SSH、gh と nx は眠る偽物で待たせる。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'

import { createMcpServer } from '../../src/mcp/server.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { verifies } from '../_helpers/verifies.js'
import { stateFile } from '../_helpers/workspace-inspect.js'
import { finishPullRequestData, graphql, openWorkspace, rest } from '../_helpers/workspace.js'
import type { Workspace } from '../_helpers/workspace.js'

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
  const server = createMcpServer(COMMANDS)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
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
  const workspace = await openStacked()
  const sleeper = hangRemote(workspace)
  expect(await pingAndCancel({ name: 'pr_restack', arguments: {}, sleeper, directory: workspace.directory, state: () => readFileSync(path.join(workspace.directory, stateFile('.pecot-base')), 'utf8') + workspace.git(['rev-parse', 'HEAD']) })).toEqual(RESPONSIVE)
})

it('pr_check が ls-remote を待つ間、ping に答え、取り消すとリモートの接続を止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  const workspace = await openStacked()
  workspace.git(['push', '-q', '-u', 'origin', UPPER])
  const sleeper = hangRemote(workspace)
  expect(await pingAndCancel({ name: 'pr_check', arguments: { directory: workspace.directory }, sleeper, directory: workspace.directory })).toEqual(RESPONSIVE)
})

it('session_finish が git pull を待つ間、ping に答え、取り消すとリモートの接続を止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  const github = [
    graphql('GetPullRequestForFinish', finishPullRequestData()),
    graphql('GetIssueKind', { repository: { issue: { number: 12, state: 'OPEN', issueType: undefined, subIssues: { totalCount: 0 } } } }, { variables: { number: 12 } }),
    rest('PATCH', '/repos/acme/demo/issues/12', 200, { number: 12, state: 'closed' }),
    graphql('GetIssueBlockingReferences', { repository: { issue: { blocking: { totalCount: 0, nodes: [] } } } }, { variables: { number: 12 } }),
  ]
  const workspace = await openWorkspace({ branch: UPPER, branches: [{ name: UPPER, commits: [{ message: 'change', files: { 'feature.txt': 'x\n' } }] }], github })
  const sleeper = hangRemote(workspace)
  expect(await pingAndCancel({ name: 'session_finish', arguments: { pr_ref: 'acme/demo/21' }, sleeper, directory: workspace.directory, state: () => workspace.git(['for-each-ref', '--format=%(refname)', `refs/heads/${UPPER}`]) })).toEqual(RESPONSIVE)
})

it('pr_create の題の scope の確認が nx graph を待つ間、ping に答え、取り消すと nx を止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  const workspace = await openWorkspace({ config: { releaseType: 'nx' }, files: { 'nx.json': '{}\n' }, branch: UPPER, branches: [{ name: UPPER, commits: [{ message: 'change', files: { 'feature.txt': 'x\n' } }] }] })
  const sleeper = writeSleeper(path.join(workspace.directory, 'node_modules', '.bin'), 'nx')
  const arguments_ = { message: 'body\n\nCloses #12\n', title: 'feat(demo): #12 変更', base: 'main', repo: 'acme/demo', screenshot: '撮らない' }
  expect(await pingAndCancel({ name: 'pr_create', arguments: arguments_, sleeper, directory: workspace.directory })).toEqual(RESPONSIVE)
})

it('トークンの無い issue_show が gh auth token を待つ間、ping に答え、取り消すと gh を止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  const workspace = await openWorkspace({ env: { PECOT_GITHUB_GHES_EXAMPLE_COM_TOKEN: undefined } })
  const bin = path.join(workspace.root, 'bin')
  const sleeper = writeSleeper(bin, 'gh')
  setEnvironment({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` })
  expect(await pingAndCancel({ name: 'issue_show', arguments: { issue_ref: 'acme/demo/12' }, sleeper, directory: workspace.directory })).toEqual(RESPONSIVE)
})

it('worktree_add が setup_command を待つ間、ping に答え、取り消すとシェルの下のコマンドも止める', { timeout: 30_000 }, async (context) => {
  await verifies(context, 'PW-COMMON-24')
  await verifies(context, 'PW-COMMON-25')
  const workspace = await openWorkspace({ files: { '.pecot/config/worktree-config.json': '{"version": 3, "links": []}\n', '.pecot/config/.worktreeignore': '.git/\n.pecot/\n' } })
  setEnvironment({ DEVCONTAINER: '1', REMOTE_CONTAINERS: undefined, CODESPACES: undefined })
  const sleeper = writeSleeper(path.join(workspace.root, 'hang'), 'setup')
  expect(await pingAndCancel({ name: 'worktree_add', arguments: { directory: workspace.directory, setup: sleeper.script }, sleeper, directory: workspace.directory })).toEqual(RESPONSIVE)
})

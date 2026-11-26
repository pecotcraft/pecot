// CUJ: MCP クライアントが、npx と同じく引数なしで起動した `dist/main.js` へ stdio で接続し、24 ツールを一覧して呼ぶ。
// stdout 汚染と終了処理（stdin の EOF・SIGTERM）の退行を実プロセスで捕まえるのは、このテストだけ。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  CLI_DIST,
  CLI_ROOT,
  PLUGIN_MANIFEST,
  drainStderr,
  makeTransport,
  serverEnvironment,
} from '../_helpers/mcp-stdio.js'
import { AttachingClient } from '../_helpers/attaching-client.js'
import { isReaped, isTerminated } from '../_helpers/process.js'
import {
  FAKE_AWS_BIN_DIR,
  fakeAwsEnvironment,
  readCallLog,
  readPidFile,
} from '../_helpers/fake-aws.js'
import { SSO_TOOL_NAMES } from '../_helpers/sso-tool-names.js'
import { attachOutput } from '../../../../../libs/interface-spec/src/vitest/attach.js'
import { ALLOWLIST } from '../../src/domain/allowlist.js'
import { MCP_SERVER_NAME } from '../../src/mcp/server.js'
import { loadVersionFromPluginJson } from '../../src/version.js'
import { explains } from '../../tests/_helpers/explains.js'

/**
SDK の request timeout。既定の 60s だと hang したときに it の timeout まで待たされる。
*/
const REQUEST_TIMEOUT_MS = 15_000

/**
client.close() が SIGTERM の後始末に入らず終わる上限。
SDK の close は 2000ms 待ってから kill する。
*/
const SELF_EXIT_BUDGET_MS = 2000

/**
serve.ts が stderr へ出す診断行の接頭辞。
*/
const LOG_PREFIX = 'error:'

/**
serveStdio が 2025 系とは別に応答する世代のプロトコル版。
*/
const MODERN_PROTOCOL_VERSION = '2026-07-28'

/**
キャンセル e2e を回す接続世代。pin が undefined なら既定の 2025 系で握手する。
*/
const ERA_CASES: readonly (readonly [string, string | undefined])[] = [
  ['2025 系', undefined],
  ['2026-07-28', MODERN_PROTOCOL_VERSION],
]

/**
SIGTERM を受けたときの終了コード（serve.ts の規約: 128 + シグナル番号）。
*/
const SIGTERM_EXIT_CODE = 143

/**
偽 awscli を PATH 先頭に置いた子プロセス環境の PATH。bash スクリプトなので node と coreutils も残す。
*/
function fakeAwsPath(): string {
  return `${FAKE_AWS_BIN_DIR}:${path.dirname(process.execPath)}:/usr/bin:/bin`
}

/**
initialize を直接送る生 JSON-RPC の開幕。2025 系の握手専用で、2026-07-28 の接続は
`server/discover` で始まるため、そちらは SDK Client 経由のテスト（modern 接続）が見る。
*/
const INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'pecot-tools-e2e-raw', version: '0.0.0' },
  },
})

const INITIALIZED_NOTIFICATION = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })

/**
生 spawn したサーバへの入出力。
*/
interface RawServer {
  /**
  1 行を stdin へ流す（末尾の改行は付ける）。
  */
  send(line: string): void
  stdout(): string
  stderr(): string
  /**
  stdin を閉じ、終了コードを待つ。
  */
  finish(): Promise<number | undefined>
  /**
  シグナルを送り、終了コードを待つ。
  */
  kill(signal: NodeJS.Signals): Promise<number | undefined>
}

/**
`dist/main.js` を引数なしで生 spawn する。

SDK Client 経由では非 JSON 行が捨てられて検出できない。
stdout を丸ごと回収する場合は、この形にする（stdout 汚染と異常入力の扱いを見るのはここだけ）。
*/
function spawnRawServer(environmentOverrides: Readonly<Record<string, string>> = {}): RawServer {
  const child = spawn(process.execPath, [CLI_DIST], {
    env: serverEnvironment(environmentOverrides),
    cwd: CLI_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  const readStderr = drainStderr(child.stderr)
  const exited = new Promise<number | undefined>((resolve) => {
    child.once('close', (code: number | null) => {
      resolve(code ?? undefined)
    })
  })

  // 終了を待った時点で、判定に使う標準出力・標準エラーを添付する。
  const settled = async (): Promise<number | undefined> => {
    const code = await exited
    attachOutput('pecot-tools mcp（生 spawn）', code, stdout, readStderr())
    return code
  }

  return {
    send: (line: string) => {
      child.stdin.write(`${line}\n`)
    },
    stdout: () => stdout,
    stderr: readStderr,
    finish: async () => {
      child.stdin.end()
      return settled()
    },
    kill: async (signal: NodeJS.Signals) => {
      child.kill(signal)
      return settled()
    },
  }
}

/**
空白のみの行も汚染として扱うため trim() では判定しない（JSON.parse('  ') は throw する）。
*/
function outputLines(text: string): readonly string[] {
  return text.split('\n').filter(line => line !== '')
}

/**
stdout の最終行が JSON-RPC 応答として読め、id が一致することを確かめる。

行数で待つと、改行が届いていない部分行を 1 行と数えることがある。
応答は約 1KB で、分割はまず起きない。ただ条件としては、行数より「読めた」ことの方が正確。
*/
function expectResponseId(stdout: string, id: number): void {
  const last = outputLines(stdout).at(-1)
  if (last === undefined) throw new Error('stdout に行がありません')
  const parsed: unknown = JSON.parse(last)
  expect(parsed).toMatchObject({ jsonrpc: '2.0', id })
}

/**
stdout の全行から、指定 id の JSON-RPC 応答を探す。まだ届いていなければ undefined。
*/
function findResponse(stdout: string, id: number): unknown {
  for (const line of outputLines(stdout)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    }
    catch {
      // 部分行は次の呼び出しで読み直す。
      continue
    }
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && parsed.id === id) return parsed
  }
  return undefined
}

/**
stdout の全行が JSON-RPC メッセージであることを確かめる。
*/
function expectJsonRpcOnly(stdout: string): void {
  const lines = outputLines(stdout)
  expect(lines).not.toEqual([])
  for (const line of lines) {
    // 非 JSON 行があればここで throw する = stdout 汚染の検知。
    const parsed: unknown = JSON.parse(line)
    expect(parsed).toMatchObject({ jsonrpc: '2.0' })
  }
}

beforeAll(() => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- import.meta.url 相対で組んだ固定パス
  if (!existsSync(CLI_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_DIST}\n先に \`pnpm build\` を実行してください`)
  }
})

describe('pecot-tools-mcp (stdio)', () => {
  it('initialize が成功し、serverInfo がサーバ名と plugin.json の版を返す', async () => {
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。クライアントを接続した場合に、`serverInfo` の名前が `MCP_SERVER_NAME`、版が `plugin.json` の版と一致し、transport のエラーがないことを確認します。')
    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const transportErrors: Readonly<Error>[] = []
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- SDK の Transport は onerror プロパティで通知する
    transport.onerror = (error: Readonly<Error>) => {
      transportErrors.push(error)
    }
    const client = new AttachingClient({ name: 'pecot-tools-e2e', version: '0.0.0' })

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })

      // 版数はリテラル固定にしない（リリース bump で壊さない）。
      expect(client.getServerVersion()).toMatchObject({
        name: MCP_SERVER_NAME,
        version: loadVersionFromPluginJson(PLUGIN_MANIFEST),
      })
      expect(transportErrors, `子プロセス stderr: ${readStderr()}`).toEqual([])
    }
    finally {
      await client.close()
    }
  }, 30_000)

  it('tools/list は、契約表の 24 件のツールを表の順に返す', async () => {
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。`tools/list` のツール名が、SSO の 2 件、許可リストのツール名の順に並ぶことを確認します。')
    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const client = new AttachingClient({ name: 'pecot-tools-e2e', version: '0.0.0' })

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const listed = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })

      expect(listed.tools.map(tool => tool.name), `子プロセス stderr: ${readStderr()}`)
        .toEqual([...SSO_TOOL_NAMES, ...ALLOWLIST.map(entry => entry.toolName)])
    }
    finally {
      await client.close()
    }
  }, 30_000)

  it('npx と同じ node_modules/.bin の symlink から cli 外の cwd で起動しても、plugin.json の版数で応える', async () => {
    // 直接起動の判定が argv[1] を realpath に揃えないと、サーバが起動せず無応答で終わる。
    await explains('`node_modules/.bin` のシンボリックリンク経由で `pecot-tools-mcp` を起動するテストです。`cli` の外のディレクトリで起動した場合に、サーバが応答し、`serverInfo` の版が `plugin.json` の版と一致することを確認します。')
    const linkRoot = mkdtempSync(path.join(tmpdir(), 'pecot-tools-e2e-bin-'))
    const binDirectory = path.join(linkRoot, 'node_modules', '.bin')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtemp で作った一時ディレクトリの配下
    mkdirSync(binDirectory, { recursive: true })
    const link = path.join(binDirectory, 'pecot-tools-mcp')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtemp で作った一時ディレクトリの配下
    symlinkSync(path.relative(binDirectory, CLI_DIST), link)
    const transport = makeTransport({}, { entry: link, cwd: linkRoot })
    const readStderr = drainStderr(transport.stderr)
    const client = new AttachingClient({ name: 'pecot-tools-e2e', version: '0.0.0' })

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })

      expect(client.getServerVersion(), `子プロセス stderr: ${readStderr()}`).toMatchObject({
        name: MCP_SERVER_NAME,
        version: loadVersionFromPluginJson(PLUGIN_MANIFEST),
      })
    }
    finally {
      await client.close()
      rmSync(linkRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('mcp を付けて起動しても引数を読まずに MCP のサーバとして tools/list に応える', async () => {
    // `pecot-tools-mcp mcp` と書いた登録も、そのまま動かすため。
    await explains('`pecot-tools-mcp` に引数 `mcp` を付けて起動するテストです。引数を読まずに MCP のサーバとして起動し、`tools/list` がツール名の一覧を返すことを確認します。')
    const transport = makeTransport({}, { extraArguments: ['mcp'] })
    const readStderr = drainStderr(transport.stderr)
    const client = new AttachingClient({ name: 'pecot-tools-e2e', version: '0.0.0' })

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const listed = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })

      expect(listed.tools.map(tool => tool.name), `子プロセス stderr: ${readStderr()}`)
        .toEqual([...SSO_TOOL_NAMES, ...ALLOWLIST.map(entry => entry.toolName)])
    }
    finally {
      await client.close()
    }
  }, 30_000)

  it('偽の awscli を PATH に置いて tools/call を呼び出すと、実行結果を返す', async () => {
    // 実プロセス越しに「引数の組み立て → 子プロセス起動 → 応答の structuredContent」までを 1 度通す。
    // 偽 awscli は bash スクリプトなので、PATH には node と coreutils も残す。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。偽の awscli で `aws_sts_get_caller_identity` を呼び出した場合は、`isError` が未設定で、`Account` が含まれ、`ok` は含まれないことを確認します。')
    const fake = fakeAwsEnvironment()
    const transport = makeTransport({ ...fake.env, PATH: fakeAwsPath() })
    const readStderr = drainStderr(transport.stderr)
    const client = new AttachingClient({ name: 'pecot-tools-e2e', version: '0.0.0' })

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const result = await client.callTool(
        { name: 'aws_sts_get_caller_identity', arguments: { region: 'ap-northeast-1' } },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(result.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(result.structuredContent).toStrictEqual(expect.objectContaining({ Account: '123456789012' }))
      expect(result.structuredContent).not.toHaveProperty('ok')
    }
    finally {
      await client.close()
      rmSync(fake.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('入れ子の配列の引数は、JSON-RPC の通信を経由しても、awscli の引数として 1 つの JSON になる', async () => {
    // dimensions（オブジェクトの配列）と statistics（列挙の配列）は、InMemoryTransport では
    // 素の JS オブジェクトのまま渡ってしまう。実プロセス越しに JSON へ直列化しても
    // JSON の 1 トークンに畳まれることを、呼び出し記録の argv で見る。
    // filters（list: true の項目を持つ要素）も同じ境界を越えるので 2 回目に呼ぶ。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。`dimensions` や `filters` のような入れ子の配列を持つ引数でツールを呼び出した場合は、それぞれが awscli へ JSON の 1 つの引数として渡されることを確認します。')
    const fake = fakeAwsEnvironment()
    const transport = makeTransport({ ...fake.env, PATH: fakeAwsPath() })
    const readStderr = drainStderr(transport.stderr)
    const client = new AttachingClient({ name: 'pecot-tools-e2e', version: '0.0.0' })

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const result = await client.callTool(
        {
          name: 'aws_cloudwatch_get_metric_statistics',
          arguments: {
            namespace: 'AWS/SQS',
            metric_name: 'NumberOfMessagesSent',
            dimensions: [{ name: 'QueueName', value: 'order-events' }],
            start_time: '2026-09-01T00:00:00Z',
            end_time: '2026-09-01T01:00:00Z',
            period: 300,
            statistics: ['Sum', 'Average'],
            region: 'ap-northeast-1',
          },
        },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(result.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(result.structuredContent).not.toHaveProperty('exitCode')

      const filtered = await client.callTool(
        {
          name: 'aws_ec2_describe_instances',
          arguments: {
            filters: [{ name: 'instance-state-name', values: ['running', 'stopped'] }],
            region: 'ap-northeast-1',
          },
        },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(filtered.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(filtered.structuredContent).not.toHaveProperty('exitCode')
      expect(readCallLog(fake.callLogPath).filter(call => call[0] !== '--version')).toEqual([
        [
          'cloudwatch', 'get-metric-statistics',
          '--namespace', 'AWS/SQS',
          '--metric-name', 'NumberOfMessagesSent',
          '--dimensions', '[{"Name":"QueueName","Value":"order-events"}]',
          '--start-time', '2026-09-01T00:00:00Z',
          '--end-time', '2026-09-01T01:00:00Z',
          '--period', '300',
          '--statistics', 'Sum', 'Average',
          '--output', 'json', '--no-cli-pager',
          '--region', 'ap-northeast-1',
        ],
        [
          'ec2', 'describe-instances',
          '--filters', '[{"Name":"instance-state-name","Values":["running","stopped"]}]',
          '--output', 'json', '--no-cli-pager',
          '--region', 'ap-northeast-1',
        ],
      ])
    }
    finally {
      await client.close()
      rmSync(fake.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('プロトコルの版 2026-07-28 で接続しても、tools/list と tools/call が成功する', async () => {
    // 既定の Client は 2025 系で握手する。serveStdio は 2026-07-28 の開幕 (server/discover) にも
    // 応答するので、実プロセス越しにこちらの世代でも一覧と呼び出しが通ることを固定する。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。版を `2026-07-28` に固定して接続した場合は、ネゴシエーションした版が `2026-07-28` になり、`tools/call` が成功することを確認します。')
    const fake = fakeAwsEnvironment()
    const transport = makeTransport({ ...fake.env, PATH: fakeAwsPath() })
    const readStderr = drainStderr(transport.stderr)
    const client = new AttachingClient(
      { name: 'pecot-tools-e2e', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    )

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION)
      expect(client.getServerVersion()).toMatchObject({
        name: MCP_SERVER_NAME,
        version: loadVersionFromPluginJson(PLUGIN_MANIFEST),
      })

      const listed = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })
      expect(listed.tools.map(tool => tool.name), `子プロセス stderr: ${readStderr()}`)
        .toEqual([...SSO_TOOL_NAMES, ...ALLOWLIST.map(entry => entry.toolName)])

      const result = await client.callTool(
        { name: 'aws_sts_get_caller_identity', arguments: { region: 'ap-northeast-1' } },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      expect(result.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(result.structuredContent).toStrictEqual(expect.objectContaining({ Account: '123456789012' }))
      expect(result.structuredContent).not.toHaveProperty('ok')
    }
    finally {
      await client.close()
      rmSync(fake.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it.each(ERA_CASES)('tools/call の実行中にクライアントがキャンセルすると、awscli のプロセスが終了し、次の呼び出しに応答する [%s]', async (_label, pinned) => {
    // キャンセルは notifications/cancelled で ctx.mcpReq.signal を abort し、runAwscli が子を落とす。
    // 偽 awscli は FAKE_AWS_HANG で SIGTERM まで居座る。子が消えれば、キャンセルが届いたと分かる。
    // 続く呼び出しは awscli を起動しない aws_sso_login_status で、サーバが生きて応答することを見る。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。終了しない awscli の実行中にクライアントがキャンセルした場合は、awscli のプロセスが終了し、続く呼び出しに `invalid-input` で応答することを確認します。')
    const fake = fakeAwsEnvironment({ hang: true })
    const transport = makeTransport({ ...fake.env, PATH: fakeAwsPath() })
    const readStderr = drainStderr(transport.stderr)
    const client = new AttachingClient(
      { name: 'pecot-tools-e2e', version: '0.0.0' },
      pinned === undefined ? {} : { versionNegotiation: { mode: { pin: pinned } } },
    )

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const controller = new AbortController()
      const call = client.callTool(
        { name: 'aws_sts_get_caller_identity', arguments: {} },
        { signal: controller.signal, timeout: REQUEST_TIMEOUT_MS },
      )
      await vi.waitFor(() => {
        expect(readCallLog(fake.callLogPath).some(entry => entry[0] !== '--version')).toBe(true)
      }, { timeout: REQUEST_TIMEOUT_MS })
      const pid = readPidFile(fake.pidFilePath)
      expect(typeof pid).toBe('number')
      expect(typeof pid === 'number' && isTerminated(pid)).toBe(false)

      controller.abort()
      await expect(call).rejects.toThrow()

      await vi.waitFor(() => {
        expect(typeof pid === 'number' && isTerminated(pid), `pid ${String(pid)} が生存している`).toBe(true)
      }, { timeout: 5000 })

      const next = await client.callTool(
        { name: 'aws_sso_login_status', arguments: {} },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      expect(next.structuredContent, `子プロセス stderr: ${readStderr()}`)
        .toMatchObject({ kind: 'invalid-input' })
    }
    finally {
      await client.close()
      rmSync(fake.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('SIGTERM を受けると、終了コード 143 で終了し、標準出力は JSON-RPC だけになる', async () => {
    // MCP クライアントが子プロセスを終わらせるときの動作。後始末を配線した以上、既定の即終了は
    // 無効になっている。そこで、明示的に 143 で終わることを固定する。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。`initialize` の応答の後に `SIGTERM` を送った場合に、終了コードが `143` で、標準出力のすべての行が JSON-RPC のメッセージであることを確認します。')
    const server = spawnRawServer()

    server.send(INITIALIZE_REQUEST)
    await vi.waitFor(() => {
      expectResponseId(server.stdout(), 1)
    }, { timeout: REQUEST_TIMEOUT_MS })

    const exitCode = await server.kill('SIGTERM')

    expect(exitCode, `子プロセス stderr: ${server.stderr()}`).toBe(SIGTERM_EXIT_CODE)
    expectJsonRpcOnly(server.stdout())
  }, 30_000)

  it('tools/call の実行中に SIGTERM を受けると、awscli のプロセスも終了する', async () => {
    // 後始末を配線しないと、親が 143 で終わっても、awscli の子は PPID 1 へ付け替えられて残る。
    // 120 秒 timeout を張っていた親が居なくなるため、長い呼び出しが野放しになる。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。終了しない awscli を実行中に `SIGTERM` を送った場合に、サーバが終了コード `143` で終了し、awscli のプロセスも終了することを確認します。')
    const fake = fakeAwsEnvironment({ hang: true })
    const server = spawnRawServer({ ...fake.env, PATH: fakeAwsPath() })

    try {
      server.send(INITIALIZE_REQUEST)
      await vi.waitFor(() => {
        expectResponseId(server.stdout(), 1)
      }, { timeout: REQUEST_TIMEOUT_MS })

      server.send(INITIALIZED_NOTIFICATION)
      server.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'aws_sts_get_caller_identity', arguments: {} },
      }))

      // 偽 awscli は PID を書いてから呼び出しを記録する。`--version` 以外の記録が出た時点で、
      // PID ファイルは hang 中の子のものになっている。
      await vi.waitFor(() => {
        expect(readCallLog(fake.callLogPath).some(call => call[0] !== '--version')).toBe(true)
      }, { timeout: REQUEST_TIMEOUT_MS })
      const pid = readPidFile(fake.pidFilePath)
      expect(typeof pid).toBe('number')

      const exitCode = await server.kill('SIGTERM')

      expect(exitCode, `子プロセス stderr: ${server.stderr()}`).toBe(SIGTERM_EXIT_CODE)
      await vi.waitFor(() => {
        expect(typeof pid === 'number' && isTerminated(pid), `pid ${String(pid)} が生存している`).toBe(true)
      }, { timeout: 5000 })
    }
    finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('client.close() を呼ぶと、SIGTERM を待たずにサーバが自力で終了する', async () => {
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。接続後に `client.close()` を呼んだ場合に、2000 ミリ秒未満で返り、サーバのプロセスが回収されることを確認します。')
    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const client = new AttachingClient({ name: 'pecot-tools-e2e', version: '0.0.0' })
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })

    const { pid } = transport
    expect(typeof pid).toBe('number')

    const start = performance.now()
    await client.close()
    const elapsed = performance.now() - start

    // SDK の close は stdin を閉じてから 2000ms 待ち、生きていれば SIGTERM を撃つ。
    // 2000ms 未満で返る = stdin の EOF だけで自力終了したということ。
    expect(elapsed, `子プロセス stderr: ${readStderr()}`).toBeLessThan(SELF_EXIT_BUDGET_MS)
    expect(typeof pid === 'number' && isReaped(pid)).toBe(true)
  }, 30_000)

  it('SSO ログインの待機中に SIGTERM を受けると、認証の awscli のプロセスも終了する', async () => {
    // aws_sso_login は URL とコードを返した後も子を生かす（2 段構成）。後始末を配線しないと、
    // サーバが 143 で終わった後も、子が PPID 1 へ付け替えられて最長 10 分動き続ける。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。`aws_sso_login` の応答の後に `SIGTERM` を送った場合に、サーバが終了コード `143` で終了し、待機中の `sso login` のプロセスも終了することを確認します。')
    const fake = fakeAwsEnvironment({ hang: true })
    const server = spawnRawServer({ ...fake.env, PATH: fakeAwsPath() })

    try {
      server.send(INITIALIZE_REQUEST)
      await vi.waitFor(() => {
        expectResponseId(server.stdout(), 1)
      }, { timeout: REQUEST_TIMEOUT_MS })

      server.send(INITIALIZED_NOTIFICATION)
      server.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'aws_sso_login', arguments: {} },
      }))

      // 応答が返った時点で、PID ファイルは待機中の `sso login` の子のものになっている。
      await vi.waitFor(() => {
        expectResponseId(server.stdout(), 2)
      }, { timeout: REQUEST_TIMEOUT_MS })
      const pid = readPidFile(fake.pidFilePath)
      expect(typeof pid).toBe('number')
      // kill 前提の生存を固定する。レジストリが settle 時に子を kill する退行が入ると、
      // 後段の isTerminated が最初から true で通ってしまう。
      expect(typeof pid === 'number' && isTerminated(pid)).toBe(false)
      // pid が `aws --version`（起動確認）の子ではなく `sso login` の子であることを固定する。
      expect(readCallLog(fake.callLogPath).some(call => call[0] === 'sso' && call[1] === 'login')).toBe(true)

      const exitCode = await server.kill('SIGTERM')

      expect(exitCode, `子プロセス stderr: ${server.stderr()}`).toBe(SIGTERM_EXIT_CODE)
      await vi.waitFor(() => {
        expect(typeof pid === 'number' && isTerminated(pid), `pid ${String(pid)} が生存している`).toBe(true)
      }, { timeout: 5000 })
      expectJsonRpcOnly(server.stdout())
    }
    finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('SSO ログインの待機中でも、標準入力が終端に達するとサーバが自力で終了し、awscli のプロセスを残さない', async () => {
    // client.close() は SDK Client 越しで、パースされた JSON-RPC しか見えず stdout 汚染を
    // 検知できない。SIGTERM 側（spawnRawServer）と対称にし、生 stdout で判定する。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。`aws_sso_login` の応答の後に標準入力を閉じた場合に、2000 ミリ秒未満で終了コード `0` で終了し、待機中のプロセスも終了することを確認します。')
    const fake = fakeAwsEnvironment({ hang: true })
    const server = spawnRawServer({ ...fake.env, PATH: fakeAwsPath() })

    try {
      server.send(INITIALIZE_REQUEST)
      await vi.waitFor(() => {
        expectResponseId(server.stdout(), 1)
      }, { timeout: REQUEST_TIMEOUT_MS })

      server.send(INITIALIZED_NOTIFICATION)
      server.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'aws_sso_login', arguments: {} },
      }))

      await vi.waitFor(() => {
        expectResponseId(server.stdout(), 2)
      }, { timeout: REQUEST_TIMEOUT_MS })
      const response: unknown = JSON.parse(outputLines(server.stdout()).at(-1) ?? '')
      expect(response, `子プロセス stderr: ${server.stderr()}`).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { structuredContent: { state: 'pending' } },
      })

      const pid = readPidFile(fake.pidFilePath)
      expect(typeof pid).toBe('number')
      // stdin を閉じる前提の生存を固定する（SIGTERM 側の assert と対称）。
      expect(typeof pid === 'number' && isTerminated(pid)).toBe(false)

      const start = performance.now()
      const exitCode = await server.finish()
      const elapsed = performance.now() - start

      // 2000ms 未満で返る = stdin の EOF だけで自力終了した。
      // SDK の close は 2000ms 待ってから SIGTERM を送る。
      // ここは stdin.end() を直接送るので、同じ処理を生 stdout で見ている。
      // 待機中の子を残すと親の stdio パイプが閉じずここで詰まる。
      expect(elapsed, `子プロセス stderr: ${server.stderr()}`).toBeLessThan(SELF_EXIT_BUDGET_MS)
      expect(exitCode, `子プロセス stderr: ${server.stderr()}`).toBe(0)
      await vi.waitFor(() => {
        expect(typeof pid === 'number' && isTerminated(pid), `pid ${String(pid)} が生存している`).toBe(true)
      }, { timeout: 5000 })
      expectJsonRpcOnly(server.stdout())
    }
    finally {
      rmSync(fake.directory, { recursive: true, force: true })
    }
  }, 30_000)

  it('標準出力には、JSON-RPC 以外の出力を含めない', async () => {
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。`initialize` と `tools/list` を送って標準入力を閉じた場合に、終了コードが `0` で、標準出力のすべての行が JSON-RPC のメッセージであることを確認します。')
    const server = spawnRawServer()

    let exitCode: number | undefined
    try {
      server.send(INITIALIZE_REQUEST)
      server.send(INITIALIZED_NOTIFICATION)
      server.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))

      await vi.waitFor(() => {
        expectResponseId(server.stdout(), 2)
      }, { timeout: REQUEST_TIMEOUT_MS })
    }
    finally {
      exitCode = await server.finish()
    }

    // serve.ts の exit code 規約 0 = 正常終了。stdin の EOF だけで 0 終了することを固定する。
    expect(exitCode, `子プロセス stderr: ${server.stderr()}`).toBe(0)
    expectJsonRpcOnly(server.stdout())
  }, 30_000)

  it('不正な JSON の行と未知のツールの呼び出しがあっても、標準出力は JSON-RPC だけのまま、終了コード 0 で終了する', async () => {
    // 異常入力の報告先は stderr のみ。stdout に診断行が漏れると、クライアントが解析に失敗する。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。不正な行と存在しないツールの呼び出しを送った場合は、標準出力が JSON-RPC だけになり、未知のツールには `-32602` を返し、終了コードが `0` であることを確認します。')
    const server = spawnRawServer()

    let exitCode: number | undefined
    try {
      server.send(INITIALIZE_REQUEST)
      // 握手の完了を待ってから不正行を送る。確定前だと transport の報告しか通らない。
      // 接続確定後に transport とインスタンスの両方へ流れる場合 (診断の二重化) を踏めない。
      await vi.waitFor(() => {
        expect(findResponse(server.stdout(), 1)).toHaveProperty('result')
      }, { timeout: REQUEST_TIMEOUT_MS })
      server.send(INITIALIZED_NOTIFICATION)
      // JSON としては読めるが JSON-RPC として不正な 1 行。応答は返らず、onerror だけが発火する。
      // (読めない JSON 行は v2 の transport が何も報告せず捨てるため、stderr の報告は期待できない)
      server.send('{"jsonrpc":"2.0","foo":1}')
      // 未知ツールの呼び出し。tools/call は登録済みなので、ハンドラ不在の -32601 ではなく
      // ツール名の解決失敗として -32602 の error 応答になる。
      server.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'no_such_tool', arguments: {} },
      }))

      await vi.waitFor(() => {
        expectResponseId(server.stdout(), 2)
      }, { timeout: REQUEST_TIMEOUT_MS })
    }
    finally {
      exitCode = await server.finish()
    }

    expect(exitCode, `子プロセス stderr: ${server.stderr()}`).toBe(0)
    expectJsonRpcOnly(server.stdout())
    const lastLine = outputLines(server.stdout()).at(-1) ?? ''
    expect(JSON.parse(lastLine)).toMatchObject({
      id: 2,
      error: { code: -32_602 },
    })
    // 不正フレーム 1 件につき診断は 1 件 (transport とインスタンスの両方に流れても重複させない)。
    expect(
      outputLines(server.stderr()).filter(line => line.startsWith(`${LOG_PREFIX} `)),
      `子プロセス stderr: ${server.stderr()}`,
    ).toHaveLength(1)
  }, 30_000)

  it('server/discover の後に同じ接続で initialize を送ると、2025 系の版で応答し、tools/call まで成功する', async () => {
    // Claude Code は discover の待ち時間を超えると、同じ接続へ initialize を送り直す。
    // 2026-07-28 の探査から 2025 系の握手へ切り替わる流れで、単体配布の初回起動で実際に起きる。
    await explains('`dist/main.js` を引数なしで実際のプロセスとして起動し、標準入出力（stdio）で通信するテストです。`server/discover` に応答した後、同じ接続へ `initialize` を送った場合に、最新の 2025 系の版で応答し、続く `tools/call` が成功することを確認します。')
    const fake = fakeAwsEnvironment()
    const server = spawnRawServer({ ...fake.env, PATH: fakeAwsPath() })
    const clientInfo = { name: 'pecot-tools-e2e-raw', version: '0.0.0' }

    let exitCode: number | undefined
    try {
      server.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': clientInfo,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }))
      await vi.waitFor(() => {
        expect(findResponse(server.stdout(), 1)).toHaveProperty('result')
      }, { timeout: REQUEST_TIMEOUT_MS })

      server.send(INITIALIZE_REQUEST.replace('"id":1', '"id":2'))
      await vi.waitFor(() => {
        expect(findResponse(server.stdout(), 2)).toMatchObject({
          result: { protocolVersion: LATEST_PROTOCOL_VERSION, serverInfo: { name: MCP_SERVER_NAME } },
        })
      }, { timeout: REQUEST_TIMEOUT_MS })

      server.send(INITIALIZED_NOTIFICATION)
      server.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'aws_sts_get_caller_identity', arguments: { region: 'ap-northeast-1' } },
      }))
      await vi.waitFor(() => {
        expect(findResponse(server.stdout(), 3)).toMatchObject({
          result: { structuredContent: { Account: '123456789012' } },
        })
      }, { timeout: REQUEST_TIMEOUT_MS })
    }
    finally {
      exitCode = await server.finish()
      rmSync(fake.directory, { recursive: true, force: true })
    }

    expect(exitCode, `子プロセス stderr: ${server.stderr()}`).toBe(0)
    expectJsonRpcOnly(server.stdout())
  }, 30_000)
})

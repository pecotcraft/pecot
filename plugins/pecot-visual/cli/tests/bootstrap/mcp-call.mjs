// bootstrap CUJ から `pecotv mcp` のツールを 1 件呼ぶための最小 MCP クライアント。
//
// bash の FIFO 手続きでは initialize → initialized → tools/call の 3 往復を安全に組めない。
// そのため、ここだけ node で書く。
// SDK は使わず、改行区切り JSON-RPC を直接話す。一時 worktree 側の node_modules 解決に依存させないため。
//
// 使い方は次のとおり。BIN_PECOTV と必要な env は、呼び出し元が export する。
//   node mcp-call.mjs <toolName> [argumentsJson]
// stdout には tools/call の result を 1 行の JSON で出す。
// 子プロセスの stderr はそのまま本プロセスの stderr へ流す。
// 失敗時は非 0 で終了する。

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
実ダウンロードを伴う setup を呼ぶため、待ち時間は bootstrap + 取得の合計を見込む。
*/
const TIMEOUT_MS = 600_000

const [toolName, argumentsJson] = process.argv.slice(2)
const binary = process.env['BIN_PECOTV']
if (binary === undefined || toolName === undefined) {
  throw new Error('usage: BIN_PECOTV=<path> node mcp-call.mjs <toolName> [argumentsJson]')
}

const child = spawn(binary, ['mcp'], { stdio: ['pipe', 'pipe', 'inherit'] })

/**
id → { resolve, reject }。応答が来たら解決する。
*/
const pending = new Map()

function failAll(error) {
  for (const [, handlers] of pending) handlers.reject(error)
  pending.clear()
}

const lines = createInterface({ input: child.stdout })
lines.on('line', (rawLine) => {
  const line = rawLine.trim()
  if (line === '') return
  let message
  try {
    message = JSON.parse(line)
  }
  catch {
    failAll(new Error(`[mcp-call] non-JSON line on stdout: ${line}`))
    return
  }
  const handlers = pending.get(message.id)
  if (handlers === undefined) return
  pending.delete(message.id)
  handlers.resolve(message)
})

child.on('close', (code) => {
  failAll(new Error(`[mcp-call] server exited early (code ${String(code)})`))
})

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function request(id, method, parameters) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[mcp-call] ${method} timed out after ${String(TIMEOUT_MS)}ms`))
    }, TIMEOUT_MS)
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer)
        resolve(message)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    send({ jsonrpc: '2.0', id, method, params: parameters })
  })
}

try {
  await request(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'bootstrap-test', version: '0.0.0' },
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const called = await request(2, 'tools/call', {
    name: toolName,
    arguments: argumentsJson === undefined ? {} : JSON.parse(argumentsJson),
  })
  process.stdout.write(`${JSON.stringify(called)}\n`)
}
catch (error) {
  console.error(String(error))
  // 例外を投げると unhandled rejection の体裁になるため、終了コードで伝える。
  process.exitCode = 1
}
finally {
  child.stdin.end()
  child.kill()
}

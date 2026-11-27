// サーバの起動ファイル（src/main.ts）と、package.json の bin の形。実プロセスでの起動は tests/e2e/mcp-stdio.test.ts が見る。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { InMemoryTransport } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isRecord } from '../../../tests/_helpers/records.js'
import { suggestedNodeVersion } from '../../node-runtime.js'
import { mcpServeDefaultDependencies } from '../serve.js'
import { allTools } from '../tools/index.js'
import type * as MainModule from '../../main.js'
import { AttachingClient } from '../../../tests/_helpers/attaching-client.js'
import { explains } from '../../../tests/_helpers/explains.js'

const CLI_ROOT = path.resolve(import.meta.dirname, '../../..')

function readPackageJson(): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'))
  if (!isRecord(parsed)) throw new TypeError('package.json がオブジェクトではありません')
  return parsed
}

describe('サーバの起動ファイル', () => {
  it('package.json の bin は pecot-tools-mcp だけで dist/main.js を指す', async () => {
    await explains('`package.json` の `bin` 項目のテストです。コマンド名が `pecot-tools-mcp` の 1 つだけで、`dist/main.js` を指していることを確認します。')
    expect(readPackageJson()['bin']).toStrictEqual({ 'pecot-tools-mcp': 'dist/main.js' })
  })

  it('CLI の起動ファイルを持たず commander に依存しない', async () => {
    await explains('CLI の廃止後の構成のテストです。`commander` が依存関係に含まれず、`src/cli.ts` が存在しないことを確認します。')
    const dependencies = readPackageJson()['dependencies']
    expect(isRecord(dependencies) && Object.hasOwn(dependencies, 'commander')).toBe(false)
    expect(existsSync(path.join(CLI_ROOT, 'src/cli.ts'))).toBe(false)
  })

  it('既定の依存で作るサーバの tools/list が allTools の名前と一致する', async () => {
    await explains('既定の依存で作成した MCP のサーバのテストです。メモリ内の transport でクライアントを接続した場合に、`tools/list` のツール名が `allTools` の名前と同じ順序で一致することを確認します。')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const handle = serveStdio(mcpServeDefaultDependencies().createServer, { transport: serverTransport })
    const client = new AttachingClient({ name: 'entry-test', version: '0.0.0' })
    try {
      await client.connect(clientTransport)
      const listed = await client.listTools()
      expect(listed.tools.map(tool => tool.name)).toEqual(allTools().map(tool => tool.name))
    }
    finally {
      await client.close()
      await handle.close()
    }
  })
})

describe('main', () => {
  const loaded = { count: 0 }
  const executeMcpServe = vi.fn()

  // 本物の serve.js は実 stdin/stdout へ繋ぐ。読み込まれたかと、渡した依存だけを見る。
  function mockServe(): void {
    vi.doMock('../serve.js', () => {
      loaded.count += 1
      return { executeMcpServe, mcpServeDefaultDependencies }
    })
  }

  async function importMain(): Promise<typeof MainModule> {
    vi.resetModules()
    mockServe()
    return import('../../main.js')
  }

  afterEach(() => {
    vi.doUnmock('../serve.js')
    vi.restoreAllMocks()
    executeMcpServe.mockReset()
    loaded.count = 0
    process.exitCode = 0
  })

  it('修正版未満の Node.js では SDK を読み込まずに案内を stderr に出し exitCode 1 で終える', async () => {
    await explains('サーバの起動処理 `main` のテストです。修正版未満の Node.js の場合に、SDK を読み込まず、標準エラーへ案内を出力して終了コード 1 で終了することを確認します。')
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const isStdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { main } = await importMain()

    await main('24.20.0')

    expect(process.exitCode).toBe(1)
    expect(writes.join('')).toContain('error: Node.js 24.20.0 does not include fixes for known vulnerabilities')
    expect(isStdoutSpy).not.toHaveBeenCalled()
    expect(loaded.count).toBe(0)
    expect(executeMcpServe).not.toHaveBeenCalled()
  })

  it('修正版未満の Node.js では案内の 2 行目以降が空白 2 つで始まる', async () => {
    await explains('サーバの起動処理 `main` のテストです。修正版未満の Node.js の場合に、標準エラーへ出力する案内が 3 行以上あり、2 行目以降が空白 2 つで始まることを確認します。')
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const { main } = await importMain()

    await main('24.20.0')

    const lines = writes.join('').trimEnd().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines.slice(1)) expect(line).toMatch(/^ {2}\S/)
  })

  it('許可される Node.js では引数に関わらず既定の依存でサーバを起動する', async () => {
    await explains('サーバの起動処理 `main` のテストです。許可される Node.js の場合に、引数の内容にかかわらず既定の依存でサーバを 1 回だけ起動し、終了コードを書き換えないことを確認します。')
    const { main } = await importMain()
    const previousArgv = process.argv
    process.argv = ['node', 'main.js', 'mcp']
    // 非 0 を仕込み、main() が exitCode を書き換えないことを見る。
    process.exitCode = 9
    try {
      await main(suggestedNodeVersion())

      expect(loaded.count).toBe(1)
      expect(executeMcpServe).toHaveBeenCalledExactlyOnceWith(mcpServeDefaultDependencies)
      expect(process.exitCode).toBe(9)
    }
    finally {
      process.argv = previousArgv
    }
  })
})

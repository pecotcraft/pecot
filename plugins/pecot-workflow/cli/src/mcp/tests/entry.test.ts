// サーバの起動ファイル（src/main.ts）と、package.json の bin の形。実プロセスでの起動は tests/mcp/session-directory.test.ts が見る。
/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは cli の固定のファイルと一時ディレクトリ配下のみ */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../tests/_helpers/step.js'
import { connectInMemory } from '../../../tests/_helpers/mcp-client.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { TOOLS } from '../../commands/registry.js'
import { templateFile } from '../../infra/template-store.js'
import { createMcpServer } from '../server.js'
import type * as MainModule from '../../main.js'

const CLI_ROOT = path.resolve(import.meta.dirname, '../../..')

function readPackageJson(): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('package.json がオブジェクトではありません')
  return Object.fromEntries(Object.entries(parsed))
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('サーバの起動ファイル', () => {
  it('package.json の bin は pecot-workflow-mcp だけで dist/main.js を指す', async () => {
    await explains('`package.json` の `bin` 項目のテストです。コマンド名が `pecot-workflow-mcp` の 1 つだけで、`dist/main.js` を指していることを確認します。')
    const bin = stepSync('package.json の bin を読む', () => readPackageJson()['bin'])
    stepSync('bin を比べる', () => {
      expect(bin).toStrictEqual({ 'pecot-workflow-mcp': 'dist/main.js' })
    })
  })

  it('CLI の起動ファイルを持たず、commander に依存しない', async () => {
    await explains('CLI の廃止後の構成のテストです。`commander` が依存関係に含まれず、`src/cli.ts` が存在しないことを確認します。')
    const dependencies = stepSync('package.json の dependencies を読む', () => readPackageJson()['dependencies'])
    const isCliExists = stepSync('src/cli.ts の有無を調べる', () => existsSync(path.join(CLI_ROOT, 'src/cli.ts')))
    stepSync('依存関係とファイルの有無を比べる', () => {
      expect(dependencies).toBeTypeOf('object')
      expect(Object.keys(dependencies ?? {})).not.toContain('commander')
      expect(isCliExists).toBe(false)
    })
  })

  it('既定のサーバの tools/list は、TOOLS の 25 個のツールを同じ順に並べる', async () => {
    await explains('既定の MCP のサーバのテストです。メモリ内の transport でクライアントを接続した場合に、`tools/list` のツール名が `TOOLS` の 25 個の名前と同じ順序で一致することを確認します。')
    const connected = await step('サーバにメモリ内でクライアントを接続する', async () => await connectInMemory(createMcpServer()))
    try {
      const listed = await step('サーバに tools/list を送る', async () => await connected.client.listTools())
      stepSync('ツール名を TOOLS と比べる', () => {
        expect(TOOLS).toHaveLength(25)
        expect(listed.tools.map(tool => tool.name)).toEqual(TOOLS.map(tool => tool.name))
      })
    }
    finally {
      await connected.close()
    }
  })

  it('CLAUDE_PLUGIN_ROOT が別のディレクトリでも、テンプレートの resource は同梱のファイルの中身を返す', async () => {
    await explains('テンプレートの resource のテストです。`CLAUDE_PLUGIN_ROOT` を別の中身のテンプレートを置いたディレクトリにしても、`pecot-template://issue/task` が同梱のファイルの中身を返すことを確認します。')
    await step('別のテンプレートを置いたディレクトリを CLAUDE_PLUGIN_ROOT にする', () => {
      const elsewhere = makeTemporaryDirectory('pecot-plugin-root-')
      mkdirSync(path.join(elsewhere, 'cli', 'templates', 'issue'), { recursive: true })
      writeFileSync(path.join(elsewhere, 'cli', 'templates', 'issue', 'task.md'), '# elsewhere\n')
      vi.stubEnv('CLAUDE_PLUGIN_ROOT', elsewhere)
    })
    const connected = await step('サーバにメモリ内でクライアントを接続する', async () => await connectInMemory(createMcpServer()))
    try {
      const read = await step('サーバに resource の読み出しを送る', async () => await connected.client.readResource({ uri: 'pecot-template://issue/task' }))
      stepSync('resource の中身と同梱のパスを比べる', () => {
        expect(read.contents).toEqual([{ uri: 'pecot-template://issue/task', mimeType: 'text/markdown', text: readFileSync(path.join(CLI_ROOT, 'templates', 'issue', 'task.md'), 'utf8') }])
        expect(templateFile('issue', 'task')).toBe(path.join(CLI_ROOT, 'templates', 'issue', 'task.md'))
      })
    }
    finally {
      await connected.close()
    }
  })
})

describe('main', () => {
  const executeMcpServe = vi.fn(() => 0)

  // 本物の serve.js は実 stdin/stdout へ繋ぐ。呼ばれたかだけを見る
  async function importMain(): Promise<typeof MainModule> {
    vi.resetModules()
    vi.doMock('../serve.js', () => ({ executeMcpServe }))
    return await import('../../main.js')
  }

  afterEach(() => {
    vi.doUnmock('../serve.js')
    executeMcpServe.mockReset()
    process.exitCode = 0
  })

  it('引数があっても、引数を読まずにサーバを 1 回起動し、終了コードを書き換えない', async () => {
    await explains('サーバの起動処理 `main` のテストです。`process.argv` に `mcp` や `--help` を付けた場合でも、引数を読まずにサーバを 1 回だけ起動し、起動に成功したときは終了コードを書き換えないことを確認します。')
    const { main } = await step('main を読み込み、サーバの起動を成功にする', async () => {
      executeMcpServe.mockReturnValue(0)
      return await importMain()
    })
    const previousArgv = process.argv
    stepSync('引数と、非 0 の終了コードを仕込む', () => {
      process.argv = ['node', 'main.js', 'mcp', '--help']
      // 非 0 を仕込み、main() が exitCode を書き換えないことを見る
      process.exitCode = 9
    })
    try {
      await step('main を呼ぶ', async () => {
        await main()
      })

      stepSync('起動の回数と終了コードを比べる', () => {
        expect(executeMcpServe).toHaveBeenCalledExactlyOnceWith()
        expect(process.exitCode).toBe(9)
      })
    }
    finally {
      process.argv = previousArgv
    }
  })

  it('サーバの起動が失敗すると、終了コードを 1 にする', async () => {
    await explains('サーバの起動処理 `main` のテストです。サーバの起動の処理が `1` を返した場合に、プロセスの終了コードを `1` にすることを確認します。')
    const { main } = await step('main を読み込み、サーバの起動を失敗にする', async () => {
      executeMcpServe.mockReturnValue(1)
      return await importMain()
    })
    await step('main を呼ぶ', async () => {
      await main()
    })
    stepSync('終了コードを比べる', () => {
      expect(process.exitCode).toBe(1)
    })
  })
})

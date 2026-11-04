// T013: CLI と MCP の同等性テスト (SC-002)。
//
// 同じ入力に対して 2 つのエントリポイント (commander の `--json` 実行と MCP の tools/call) を in-process で実行する。
// CLI が stdout へ出す JSON と MCP の structuredContent.data が一致することを見る。
// 実処理と data 組み立ては execute<Cmd>() に一本化してある。
// ここで不一致が出たときは、「どちらかのルートにだけ後処理が残った」ことを意味する。
//
// 実プロセスを起こさないのは、比較したいのが結果オブジェクトの同形性だけだからで、
// stdio 越しの実プロセス検証は tests/e2e/mcp-tools.test.ts が担う。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp で作った一時ディレクトリ配下のみ */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createDrawioUrlCommand,
  drawioUrlDefaultDependencies,
  type DrawioUrlDependencies,
} from '../../commands/drawio/url.js'
import {
  createEvidenceCreateCommand,
  evidenceCreateDefaultDependencies,
  type EvidenceCreateDependencies,
} from '../../commands/evidence-xlsx/create.js'
import { buildPng } from '../../../tests/_helpers/image-fixture.js'
import { createChromiumCacheDirectory, removeChromiumCacheDirectory } from '../../../tests/_helpers/chromium-cache.js'
import { copyFixtureTheme } from '../../../tests/_helpers/theme-fixtures.js'
import { readZipEntries } from '../../../tests/_helpers/zip-entries.js'
import { createOutputCapture } from '../result.js'
import { allTools } from '../tools/index.js'
import { isRecord } from '../../../tests/_helpers/records.js'
import { closeMcp, connectMcp, type ConnectedMcp } from './_client.js'

// src/mcp/tests → cli/ → plugins/pecot-visual
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')
// 警告 0 件で URL を返す既存 fixture。
const MINIMAL_DRAWIO = path.join(CLI_ROOT, 'tests', 'fixtures', 'drawio', 'minimal.drawio')

// talk-dir の外で --theme 無しのとき、data.theme に載る既定値
const DEFAULT_THEME_DATA = { source: 'default', fonts: { body: ['sans-serif'] } }

/**
commander の action が書いた `--json` の 1 行を JSON として取り出す。
*/
function parseJsonLine(text: string): Record<string, unknown> {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const last = lines.at(-1)
  if (last === undefined) throw new Error(`stdout に JSON 行がありません: ${JSON.stringify(text)}`)
  const parsed: unknown = JSON.parse(last)
  if (!isRecord(parsed)) throw new Error(`JSON 行がオブジェクトではありません: ${last}`)
  return parsed
}

// 引数を Record で受けるのは、client.callTool の戻り型が structuredContent を持たない応答型との union だから。
// errors.test.ts と同じ扱い。
function dataOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  const data = structured['data']
  if (!isRecord(data)) throw new Error('data が返っていません')
  return data
}

/**
CLI 側を `--json` で実行し、stdout へ出た JSON を返す。

deps は MCP ツールと同じ既定ファクトリから作る。片方だけ差し替えると比較の意味が
「同じ実装を通ったか」から「同じスタブを通ったか」にすり替わる。
*/
async function runDrawioUrlCli(argv: readonly string[]): Promise<Record<string, unknown>> {
  const stdout = createOutputCapture()
  const stderr = createOutputCapture()
  const dependencies: DrawioUrlDependencies = {
    ...drawioUrlDefaultDependencies(),
    stdout: stdout.stream,
    stderr: stderr.stream,
  }
  await createDrawioUrlCommand(() => dependencies).parseAsync([...argv], { from: 'user' })
  return parseJsonLine(stdout.text())
}

describe('CLI と MCP の結果同等性 (SC-002)', () => {
  let previousExitCode: typeof process.exitCode
  let connected: ConnectedMcp | undefined
  let workDirectory = ''
  // drawio_create の PNG ルートには chromium の実行時ガードが入る。実行ホストの chromium の
  // 有無で結果が変わらないよう、Playwright の解決先を一時ディレクトリへ向けて
  // 「取得済み / 未取得」をテストごとに固定する。
  const chromiumCacheDirectories: string[] = []

  /**
  Playwright の解決先を貼り替える。戻り値は後片付け対象として登録済み。
  */
  function stubChromium(isInstalled: boolean): void {
    chromiumCacheDirectories.push(createChromiumCacheDirectory(isInstalled))
  }

  beforeAll(async () => {
    connected = await connectMcp(allTools())
  })

  afterAll(async () => {
    if (connected !== undefined) await closeMcp(connected)
  })

  beforeEach(() => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
    // 既定は「取得済み」。比較対象を PNG 生成の成否だけに絞る。
    stubChromium(true)
    // CLI ルートは失敗と警告を process.exitCode に書く。
    // vitest 自身の終了コードを巻き込まないよう毎回退避する。
    // tests/integration/commands/drawio-url.test.ts と同じ扱い。
    previousExitCode = process.exitCode
    workDirectory = mkdtempSync(path.join(tmpdir(), 'pecotv-test-parity-'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    process.exitCode = previousExitCode
    rmSync(workDirectory, { recursive: true, force: true })
    for (const directory of chromiumCacheDirectories.splice(0)) removeChromiumCacheDirectory(directory)
  })

  function client(): ConnectedMcp['client'] {
    if (connected === undefined) throw new Error('サーバへ接続できていません')
    return connected.client
  }

  describe('drawio_create', () => {
    it('out_path 省略時 (data = url) が一致する', async () => {
      const cli = await runDrawioUrlCli([MINIMAL_DRAWIO, '--json'])
      const called = await client().callTool({
        name: 'drawio_create',
        arguments: { input_path: MINIMAL_DRAWIO },
      })

      expect(dataOf(called)).toEqual(cli)
      expect(cli['event']).toBe('drawio.url.done')
      expect(cli['url']).toEqual(expect.stringContaining('https://'))
    })

    it('out_path 指定・PNG 抑止時 (data = file) が一致する', async () => {
      // 同じ出力先へ順に書く。表示用 HTML は同じ URL からは同じバイト列になり決定的なので上書きしてよく、
      // data.file が両ルートで同一パスになるぶん比較が素直になる。
      const outPath = path.join(workDirectory, 'diagram.drawio.html')

      const cli = await runDrawioUrlCli([MINIMAL_DRAWIO, '--json', '-o', outPath, '--no-png'])
      const called = await client().callTool({
        name: 'drawio_create',
        arguments: { input_path: MINIMAL_DRAWIO, out_path: outPath, png: false },
      })

      expect(dataOf(called)).toEqual(cli)
      expect(cli).toEqual({ event: 'drawio.url.done', file: outPath, warnings: 0, theme: DEFAULT_THEME_DATA })
    })

    it('out_path 指定・PNG 生成失敗時 (data = png:null / pngFailed) が一致する', async () => {
      // Chromium を起こさずに PNG 失敗ルートへ入れるための注入 (infra/drawio/screenshot.ts)。
      // 両ルートとも既定 deps の capturePng を通るので、同じ env が同じように働く。
      vi.stubEnv('PECOTV_FORCE_PNG_FAIL', '1')
      const outPath = path.join(workDirectory, 'diagram.drawio.html')

      const cli = await runDrawioUrlCli([MINIMAL_DRAWIO, '--json', '-o', outPath])
      const called = await client().callTool({
        name: 'drawio_create',
        arguments: { input_path: MINIMAL_DRAWIO, out_path: outPath, png: true },
      })

      expect(dataOf(called)).toEqual(cli)
      expect(cli).toEqual({
        event: 'drawio.url.done',
        file: outPath,
        // eslint-disable-next-line unicorn/no-null -- PNG 失敗時に png: null を返すことが契約
        png: null,
        pngFailed: true,
        // PNG 失敗は警告 1 件として数える (CLI の exit code 3 の根拠)。
        warnings: 1,
        theme: DEFAULT_THEME_DATA,
      })
    })

    it('chromium 未取得時も degrade して一致する (MCP だけが hard-fail しない)', async () => {
      // MCP には chromium の実行時ガードがあり、CLI には無い。ガードが実処理前に弾くと
      // 「表示用 HTML すら作られない MCP」と「HTML は書いて PNG だけ諦める CLI」に割れる。
      // MCP 側はガードで PNG を諦めるルート、CLI 側は capturePng の失敗ルートを通り、
      // どちらも同じ degrade 後の data になることを見る。
      stubChromium(false)
      vi.stubEnv('PECOTV_FORCE_PNG_FAIL', '1')
      const outPath = path.join(workDirectory, 'diagram.drawio.html')

      const cli = await runDrawioUrlCli([MINIMAL_DRAWIO, '--json', '-o', outPath])
      const called = await client().callTool({
        name: 'drawio_create',
        arguments: { input_path: MINIMAL_DRAWIO, out_path: outPath, png: true },
      })

      expect(called.isError, 'URL の生成そのものは成立しているので失敗にしない').toBeUndefined()
      expect(dataOf(called)).toEqual(cli)
      expect(cli).toEqual({
        event: 'drawio.url.done',
        file: outPath,
        // eslint-disable-next-line unicorn/no-null -- PNG 失敗時に png: null を返すことが契約
        png: null,
        pngFailed: true,
        warnings: 1,
        theme: DEFAULT_THEME_DATA,
      })
    })

    it('theme 指定時 (data.theme = option) が一致する', async () => {
      const themeDirectory = path.join(workDirectory, 'theme')
      copyFixtureTheme('with-declaration', themeDirectory)

      const cli = await runDrawioUrlCli([MINIMAL_DRAWIO, '--json', '--theme', themeDirectory])
      const called = await client().callTool({
        name: 'drawio_create',
        arguments: { input_path: MINIMAL_DRAWIO, theme: themeDirectory },
      })

      expect(dataOf(called)).toEqual(cli)
      expect(cli['theme']).toMatchObject({ source: 'option', name: 'slidev-theme-pecotv-test-declared' })
    })

    it('解けない theme (invalid-theme) の失敗が一致する', async () => {
      const empty = path.join(workDirectory, 'empty')
      mkdirSync(empty)

      const cli = await runDrawioUrlCli([MINIMAL_DRAWIO, '--json', '--theme', empty])
      const called = await client().callTool({
        name: 'drawio_create',
        arguments: { input_path: MINIMAL_DRAWIO, theme: empty },
      })

      expect(called.isError).toBe(true)
      expect(dataOf(called)).toEqual(cli)
      expect(cli).toMatchObject({ event: 'drawio.url.error', reason: 'invalid-theme' })
    })
  })

  describe('evidence_create', () => {
    it('data と生成 xlsx の中身が一致する', async () => {
      const imagePath = path.join(workDirectory, '01-login.png')
      writeFileSync(imagePath, buildPng(40, 30))
      const specPath = path.join(workDirectory, 'spec.json')
      writeFileSync(specPath, JSON.stringify({
        title: 'ログイン機能 動作確認エビデンス',
        createdDate: '2026-08-26',
        items: [{ imagePath, caption: 'ログイン画面' }],
      }), 'utf8')

      // data.outPath を同値にするため出力先は共通にし、CLI の生成物は先に退避しておく。
      const outPath = path.join(workDirectory, 'evidence.xlsx')
      const cliCopy = path.join(workDirectory, 'evidence-cli.xlsx')

      const stdout = createOutputCapture()
      const stderr = createOutputCapture()
      const dependencies: EvidenceCreateDependencies = {
        ...evidenceCreateDefaultDependencies(),
        stdout: stdout.stream,
        stderr: stderr.stream,
      }
      await createEvidenceCreateCommand(() => dependencies)
        .parseAsync(['--input', specPath, '--out', outPath, '--json'], { from: 'user' })
      const cli = parseJsonLine(stdout.text())
      copyFileSync(outPath, cliCopy)

      const called = await client().callTool({
        name: 'evidence_create',
        arguments: { input_path: specPath, out_path: outPath },
      })

      expect(dataOf(called)).toEqual(cli)
      expect(cli).toEqual({
        event: 'result',
        outPath,
        items: 1,
        annotations: 0,
        skipped: [],
      })

      // xlsx はファイル単位のバイト比較ができない (yazl が各エントリに書き込み時刻を載せる)。
      // 比較はエントリ名の並びと、各エントリの中身で行う。
      const fromCli = await readZipEntries(cliCopy)
      const fromMcp = await readZipEntries(outPath)
      expect(fromMcp.keys().toArray()).toEqual(fromCli.keys().toArray())
      for (const [name, content] of fromCli) {
        expect(fromMcp.get(name)).toEqual(content)
      }
    })
  })
})

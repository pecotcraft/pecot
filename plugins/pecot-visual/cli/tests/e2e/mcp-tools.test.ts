// CUJ: MCP クライアントが `pecotv mcp` へ stdio 接続し、11 ツールを一覧して呼び出す。
//
// in-process の contract / errors テストが見ているのは、応答の形だけ。
// 「実プロセスに登録されたツールが本当に一覧に出て、呼ぶと動くか」は、spawn しないと分からない。
// dist を経由するので、build 対象から漏れたモジュールや実行時 import の失敗も、ここで落ちる。
//
// 対象は次の 5 件に絞る。
//   - drawio_create: out_path 省略と、表示用 HTML を書き出す out_path 付きの 2 通り。
//   - drawio_export: SVG と兄弟 PDF を書き出す。成功と、PDF 失敗の degrade の 2 通りで、chromium 取得済みのときだけ。
//   - evidence_create: xlsx を書き出す。
//   - slide_dev: 実 slidev の dev サーバを起こす。
//   - slide_page: talk-dir へページを書き出す。
// slide_page を入れるのは、参照 yaml の読み取りと 1 ファイルの書き込みだけで、安価にカタログ全件を回せるため。
// drawio_export を入れるのは、次の 2 点を dist から起動したサーバでしか観測できないため。
// 1 点目は応答の artifacts に PDF が載ること、2 点目は警告時の exitCode。
// in-process テストは embed を mock する。
// slide_convert は実 build や Chromium を起こして、wall time が数分単位になる。
// e2e lane (maxWorkers 制限付き並列) の負荷に見合わないため、含めない。
// 変換本体は既存の e2e が別途カバーしている。
//
// slide_dev だけは、in-process テストで代替できない性質を持つ。
// 子プロセスの実起動・ポートの占有と解放・MCP サーバ終了時に孤児を残さないことは、
// deps 注入では原理的に観測できない。

/* eslint-disable security/detect-non-literal-fs-filename */
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- Client は mutable なクラス型 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { isChromiumInstalled } from '../../src/infra/playwright/chromium.js'
import { createFixtureThemeSpec } from '../_helpers/pecotv-e2e-run.js'
import { buildPng } from '../_helpers/image-fixture.js'
import { CLI_DIST, CLI_ROOT, drainStderr, isReaped, makeTransport } from '../_helpers/mcp-stdio.js'
import { compareStrings } from '../../src/domain/_shared/compare-strings.js'
import { ignoreRejection } from '../../src/domain/_shared/ignore-rejection.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { FIXTURE_THEMES } from '../_helpers/theme-fixtures.js'

/**
fixture テーマの見せ方の分類 id を、宣言（references/_common.yaml の layout_categories）の並びのまま返す。
slide_create が返す categories の期待値。
*/
function fixtureCategoryIds(): readonly string[] {
  const common: unknown = parse(readFileSync(path.join(FIXTURE_THEMES, 'with-declaration', 'references', '_common.yaml'), 'utf8'))
  const categories = isRecord(common) ? common['layout_categories'] : undefined
  if (!Array.isArray(categories)) throw new TypeError('_common.yaml に layout_categories が無い')
  return categories.map(entry => (isRecord(entry) ? String(entry['id']) : ''))
}

/**
SDK の request timeout。既定の 60s だと hang したときに it の timeout まで待たされる。
*/
const REQUEST_TIMEOUT_MS = 15_000

/**
setup は取得済みでも playwright install を 1 回起動するため、他のツールより長く待つ。
*/
const SETUP_TIMEOUT_MS = 90_000

/**
実行ホストが chromium を取得済みか。判定はサーバ本体と同じ実装を使う
(テスト側で基準を書き写すと、本体を直したときに片側だけ古くなる)。
*/
const isChromiumReady = await isChromiumInstalled()

/**
drawio_export は embed.diagrams.net の往復と chromium 2 回の起動を含むため、他のツールより長く待つ。
it の timeout はこれに 30s 足し、子プロセス stderr 付きで落ちる callTool の timeout を先に発火させる。
*/
const DRAWIO_EXPORT_TIMEOUT_MS = 90_000

/**
slide_dev は talk-dir 生成と vite の初回起動を含むため、他のツールより長く待つ。
*/
const DEV_SERVER_TIMEOUT_MS = 30_000

/**
ポートの解放を待つ上限 (計測では SIGTERM から約 100ms で解放される)。
*/
const PORT_RELEASE_TIMEOUT_MS = 15_000

/**
契約で定めた公開ツール数 (内訳の検証は src/mcp/tests/contract.test.ts が持つ)。
*/
const EXPECTED_TOOL_COUNT = 11

/**
127.0.0.1 の該当ポートに TCP で繋がるか。dev サーバの生存・解放の観測に使う。
*/
async function isPortListening(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const settle = (isListening: boolean): void => {
      socket.destroy()
      resolve(isListening)
    }
    socket.setTimeout(1000)
    socket.on('connect', () => {
      settle(true)
    })
    socket.on('timeout', () => {
      settle(false)
    })
    socket.on('error', () => {
      settle(false)
    })
  })
}

/**
slide_dev へ `port` で渡す空きポートを OS に選ばせる。

既定のポート (3030〜3034) は使わない。開発機で動いている実プレビューと取り合うと、
テストの合否が実行環境の状態で変わる。
*/
async function findFreePort(): Promise<number> {
  const server: Server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject)
      server.listen(0, '0.0.0.0', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('空きポートを特定できませんでした')
    return address.port
  }
  finally {
    // close のコールバックはエラーを無視する: ポート番号は listen の時点で既に得ており、
    // close の失敗で結果は変わらない。
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
}

/**
ポートが LISTEN でなくなるまで待つ。kill は非同期なので即時判定にはできない。

偽陰性が原理的に残る。
ポートは findFreePort が OS の ephemeral range から取る。
解放された直後に、e2e lane の別 worker (vitest.e2e.config.ts の maxWorkers、最大 6) が同じ番号を掴むと、
「解放されていない」と判定する。
range の広さから確率は極めて低いが、本 assert が flake として現れたときは、この流れを調べる。
*/
async function expectPortReleased(port: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await isPortListening(port), `ポート ${String(port)} が解放されていない`).toBe(false)
  }, { timeout: PORT_RELEASE_TIMEOUT_MS, interval: 100 })
}

// 警告 0 件で URL を返す既存 fixture。out_path を省略するので、PNG 生成とネットワークのどちらにも触れない。
const MINIMAL_DRAWIO = path.join(CLI_ROOT, 'tests', 'fixtures', 'drawio', 'minimal.drawio')
// drawio_export の icons_dir。プラグイン同梱のカタログを渡す (chromium 未取得のケースではガードが先に返るため中身は使われない)。
const ICONS_DIR = path.join(CLI_ROOT, '..', 'assets', 'drawio-icons')

/**
接続済みクライアントを渡して 1 本のシナリオを動かせ、後片付けまで面倒を見る。
*/
async function withClient(
  scenario: (client: Client, readStderr: () => string) => Promise<void>,
  environmentOverrides: Readonly<Record<string, string>> = {},
): Promise<void> {
  const transport = makeTransport(environmentOverrides)
  const readStderr = drainStderr(transport.stderr)
  const client = new Client({ name: 'pecotv-e2e-tools', version: '0.0.0' })
  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
    await scenario(client, readStderr)
  }
  finally {
    await client.close()
  }
}

// 引数を Record で受けるのは、client.callTool の戻り型が、structuredContent を持たない応答型との union だから。
// これは src/mcp/tests 側と同じ扱い。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

function dataOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const data = structuredOf(result)['data']
  if (!isRecord(data)) throw new Error('data が返っていません')
  return data
}

/**
structuredContent.artifacts を文字列配列として取り出す。
*/
function artifactsOf(result: Readonly<Record<string, unknown>>): readonly string[] {
  const artifacts = structuredOf(result)['artifacts']
  if (!Array.isArray(artifacts)) throw new TypeError('artifacts が返っていません')
  return artifacts.filter(entry => typeof entry === 'string')
}

const workDirectory = useTemporaryDirectory('pecotv-test-e2e-', { hook: 'all' })

beforeAll(() => {
  if (!existsSync(CLI_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_DIST}\n先に \`pnpm build\` を実行してください`)
  }
})

afterAll(() => {
  if (workDirectory() !== '') rmSync(workDirectory(), { recursive: true, force: true })
})

describe('pecotv mcp のツール (stdio)', () => {
  it('tools/list が 11 件を description と inputSchema つきで返す', async () => {
    await withClient(async (client, readStderr) => {
      const listed = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })

      expect(listed.tools, `子プロセス stderr: ${readStderr()}`).toHaveLength(EXPECTED_TOOL_COUNT)
      // 件数だけだと「別のツールと入れ替わった」を見逃すため、dist に載ったことを名前でも見る。
      expect(listed.tools.map(tool => tool.name)).toContain('slide_page')
      expect(listed.tools.map(tool => tool.name)).toContain('slide_theme')
      for (const tool of listed.tools) {
        expect(tool.description, `${tool.name} の description`).toEqual(expect.any(String))
        expect(tool.description).not.toBe('')
        expect(tool.inputSchema.type).toBe('object')
      }
    })
  }, 60_000)

  it('drawio_create を out_path 省略で呼ぶと URL を返す', async () => {
    await withClient(async (client, readStderr) => {
      const called = await client.callTool(
        { name: 'drawio_create', arguments: { input_path: MINIMAL_DRAWIO } },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(called.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      const data = dataOf(called)
      // out_path を省略した分岐の data は、event / theme / url / warnings の 4 キーだけ。
      // in-process の parity テストが、CLI の --json と同形であることを別途 pin している。
      expect(Object.keys(data).toSorted(compareStrings)).toEqual(['event', 'theme', 'url', 'warnings'])
      expect(data['theme']).toEqual({ source: 'default', fonts: { body: ['sans-serif'] } })
      expect(data['event']).toBe('drawio.url.done')
      expect(data['url']).toEqual(expect.stringContaining('https://'))
      expect(data['warnings']).toBe(0)
    })
  }, 60_000)

  it('drawio_create を out_path 付きで呼ぶと表示用 HTML を実ファイルとして書き出す', async () => {
    // 利用者が実際に踏むのはこちら (v-drawio スキルが out_path を必須にしている)。
    // in-process のハンドラテストは同一プロセスの fs しか見ない。
    // そのため、dist 経由で起動したサーバが本当に HTML を残すかは、ここでしか観測できない。
    // png: false を渡すので、Chromium は使わない。
    const outPath = workDirectory('diagram.drawio.html')

    await withClient(async (client, readStderr) => {
      const called = await client.callTool(
        { name: 'drawio_create', arguments: { input_path: MINIMAL_DRAWIO, out_path: outPath, png: false } },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(called.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(dataOf(called)).toEqual({ event: 'drawio.url.done', file: outPath, warnings: 0, theme: { source: 'default', fonts: { body: ['sans-serif'] } } })
      expect(artifactsOf(called)).toEqual([outPath])
      const written = readFileSync(outPath, 'utf8')
      expect(written.startsWith('<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n')).toBe(true)
      expect(written).toContain('<meta http-equiv="refresh" content="0;url=https://app.diagrams.net/')
      expect(written).toContain('<a id="target" href="https://app.diagrams.net/')
    })
  }, 60_000)

  it.skipIf(!isChromiumReady)('drawio_export を out_path 付きで呼ぶと SVG と兄弟 PDF を artifacts に載せる', async () => {
    const outPath = workDirectory('export-ok', 'diagram.drawio.svg')
    const pdfPath = workDirectory('export-ok', 'diagram.drawio.pdf')

    await withClient(async (client, readStderr) => {
      const called = await client.callTool(
        { name: 'drawio_export', arguments: { input_path: MINIMAL_DRAWIO, icons_dir: ICONS_DIR, out_path: outPath } },
        { timeout: DRAWIO_EXPORT_TIMEOUT_MS },
      )

      expect(called.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(structuredOf(called)['exitCode']).toBe(0)
      expect(dataOf(called)).toMatchObject({
        event: 'drawio.export.done',
        file: outPath,
        pdf: pdfPath,
        pdfFailed: false,
        warnings: 0,
      })
      expect(artifactsOf(called)).toEqual([outPath, pdfPath])
      expect(existsSync(outPath)).toBe(true)
      expect(readFileSync(pdfPath).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    })
  }, DRAWIO_EXPORT_TIMEOUT_MS + 30_000)

  it.skipIf(!isChromiumReady)('drawio_export は PDF 生成に失敗しても SVG を返し exitCode 3 で degrade する', async () => {
    const outPath = workDirectory('export-degrade', 'diagram.drawio.svg')
    const pdfPath = workDirectory('export-degrade', 'diagram.drawio.pdf')

    await withClient(async (client, readStderr) => {
      const called = await client.callTool(
        { name: 'drawio_export', arguments: { input_path: MINIMAL_DRAWIO, icons_dir: ICONS_DIR, out_path: outPath } },
        { timeout: DRAWIO_EXPORT_TIMEOUT_MS },
      )

      // 警告ありでも SVG は書けているので ok: true のまま (isError を立てない)。
      // 失敗の理由（SVG export の時間切れ等）は ToolResult の本文に出るため、子プロセスの stderr と並べて残す。
      expect(called.isError, `ToolResult: ${JSON.stringify(called).slice(0, 2000)}\n子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(structuredOf(called)['ok']).toBe(true)
      expect(structuredOf(called)['exitCode']).toBe(3)
      expect(dataOf(called)).toMatchObject({
        event: 'drawio.export.done',
        file: outPath,
        // eslint-disable-next-line unicorn/no-null -- JSON の契約が `pdf: null`
        pdf: null,
        pdfFailed: true,
        warnings: 1,
      })
      expect(artifactsOf(called)).toEqual([outPath])
      expect(existsSync(outPath)).toBe(true)
      expect(existsSync(pdfPath)).toBe(false)
    }, { PECOTV_FORCE_PDF_FAIL: '1' })
  }, DRAWIO_EXPORT_TIMEOUT_MS + 30_000)

  it('evidence_create が spec から xlsx を実ファイルとして書き出す', async () => {
    // 成果物をファイルとして書くツールを、実プロセスで 1 本通す。
    // in-process の unit test では同一プロセスの fs しか見ない。
    // そのため、dist 経由で起動したサーバが本当に xlsx を残すかは、ここでしか観測できない。
    // Chromium と LibreOffice のどちらも起動しないので、skip 条件は要らない。
    const imagePath = workDirectory('01-login.png')
    writeFileSync(imagePath, buildPng(80, 60))
    const specPath = workDirectory('spec.json')
    writeFileSync(specPath, JSON.stringify({
      title: 'MCP 経由のエビデンス',
      createdDate: '2026-08-26',
      items: [{ imagePath, caption: 'ログイン画面' }],
    }), 'utf8')
    const outPath = workDirectory('evidence.xlsx')

    await withClient(async (client, readStderr) => {
      const called = await client.callTool(
        { name: 'evidence_create', arguments: { input_path: specPath, out_path: outPath } },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(called.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(structuredOf(called)['ok']).toBe(true)
      expect(dataOf(called)).toMatchObject({ event: 'result', outPath, items: 1, skipped: [] })
      expect(artifactsOf(called)).toEqual([outPath])
      expect(existsSync(outPath)).toBe(true)
      expect(statSync(outPath).size).toBeGreaterThan(0)
    })
  }, 60_000)

  it('slide_page が talk-dir のカタログ全件のページを実ファイルとして書き出す', async () => {
    // 実プロセスの talk-dir に対して、カタログに載る全レイアウトを 1 本の接続で順に回す
    // (ファイル読みと 1 ファイル書き込みだけなので spawn 1 回で足りる)。レイアウト名は
    // テスト側に書き写さず slide_create の data.layouts から取る — 書き写すとレイアウトを
    // 足したときに片側だけ古くなる。
    const talkDirectory = workDirectory('page-talk')

    await withClient(async (client, readStderr) => {
      const created = await client.callTool(
        { name: 'slide_create', arguments: { project_dir: talkDirectory, theme: createFixtureThemeSpec(workDirectory('page-theme')) } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(created.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()

      const layouts = dataOf(created)['layouts']
      if (!Array.isArray(layouts)) throw new TypeError('slide_create が data.layouts を返していません')
      expect(layouts.length).toBeGreaterThan(0)

      // 見せ方の分類も同じ応答に載り、layouts[].category と必ず join できる。
      const categories = dataOf(created)['categories']
      if (!Array.isArray(categories)) throw new TypeError('slide_create が data.categories を返していません')
      const categoryIds = categories.map(entry => (isRecord(entry) ? entry['id'] : undefined))
      expect(categoryIds).toEqual(fixtureCategoryIds())
      for (const entry of layouts) {
        if (!isRecord(entry)) throw new Error('data.layouts の要素が object ではありません')
        expect(categoryIds).toContain(entry['category'])
      }

      // 群化順も実プロセス経由で押さえる。スキル指示文は「分類を決めてから、その分類の
      // レイアウトを数える」と書いており、並びが崩れると数える範囲がずれる。
      const ranks = layouts.map(entry => categoryIds.indexOf(isRecord(entry) ? entry['category'] : undefined))
      expect(ranks).toEqual(ranks.toSorted((a, b) => a - b))

      // 同一分類の中では stable が deprecated に先行する。
      const deprecatedSeen = new Set<string>()
      const stableAfterDeprecated: string[] = []
      for (const entry of layouts) {
        if (!isRecord(entry)) throw new Error('data.layouts の要素が object ではありません')
        const category = String(entry['category'])
        if (entry['deprecated'] === true) deprecatedSeen.add(category)
        else if (deprecatedSeen.has(category)) stableAfterDeprecated.push(String(entry['layout']))
      }
      expect(stableAfterDeprecated).toEqual([])

      const generatedFiles: string[] = []
      for (const entry of layouts) {
        if (!isRecord(entry)) throw new Error('data.layouts の要素が object ではありません')
        const layout = String(entry['layout'])
        const file = `e2e-${layout}`
        const target = path.join(talkDirectory, 'pages', `${file}.md`)

        // MCP の tools/call は直列キューで処理されるため、並列化しても短縮しない。
        const called = await client.callTool(
          { name: 'slide_page', arguments: { layout, dir: talkDirectory, file } },
          { timeout: REQUEST_TIMEOUT_MS },
        )

        expect(called.isError, `${layout}: ${readStderr()}`).toBeUndefined()
        expect(artifactsOf(called), `layout: ${layout}`).toEqual([target])
        expect(dataOf(called), `layout: ${layout}`).toMatchObject({
          event: 'slide.page.done',
          layout,
          category: entry['category'],
          deprecated: entry['deprecated'],
          path: target,
        })

        // 実プロセス経由でも欠損なく届き、貼れば書き始められる形になっていること。
        const written = readFileSync(target, 'utf8')
        expect(written.startsWith('---\n'), `layout: ${layout}`).toBe(true)
        expect(written.endsWith('---\n'), `layout: ${layout}`).toBe(true)
        expect(written, `layout: ${layout}`).toContain(`layout: ${layout}`)
        generatedFiles.push(`${file}.md`)
      }

      // 未知名は選択可能な一覧つきで失敗し、ページも作らない。
      const unknown = await client.callTool(
        { name: 'slide_page', arguments: { layout: 'no-such-layout', dir: talkDirectory, file: 'e2e-unknown' } },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      expect(unknown.isError).toBe(true)
      expect(dataOf(unknown)['reason']).toBe('unknown-layout')
      expect(dataOf(unknown)['layouts']).toHaveLength(layouts.length)
      expect(dataOf(unknown)['categories']).toHaveLength(categories.length)
      expect(existsSync(path.join(talkDirectory, 'pages', 'e2e-unknown.md'))).toBe(false)

      // 既存ページは、force なしなら触らない。force: true なら上書きする。
      const existing = path.join(talkDirectory, 'pages', 'e2e-cover.md')
      const refused = await client.callTool(
        { name: 'slide_page', arguments: { layout: 'section', dir: talkDirectory, file: 'e2e-cover' } },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      expect(refused.isError).toBe(true)
      expect(dataOf(refused)['reason']).toBe('file-exists')
      expect(readFileSync(existing, 'utf8')).toContain('layout: cover')

      const overwritten = await client.callTool(
        { name: 'slide_page', arguments: { layout: 'section', dir: talkDirectory, file: 'e2e-cover', force: true } },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      expect(overwritten.isError).toBeUndefined()
      expect(readFileSync(existing, 'utf8')).toContain('layout: section')

      // 生成したページを全件 slides.md へ登録して lint する。examples から取った雛形が
      // そのままで lint クリーンであることは、slide_page が「貼れば書き始められる形」を
      // 返す前提そのもの。参照 yaml の examples が破損するとここで落ちる。
      const slidesPath = path.join(talkDirectory, 'slides.md')
      const entries = generatedFiles.map(name => `\n---\nsrc: ./pages/${name}\n---\n`).join('')
      writeFileSync(slidesPath, `${readFileSync(slidesPath, 'utf8')}${entries}`, 'utf8')

      const linted = await client.callTool(
        { name: 'slide_lint', arguments: { dir: talkDirectory } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(linted.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      const lintData = dataOf(linted)
      expect(
        structuredOf(linted)['exitCode'],
        `lint 違反: ${JSON.stringify(lintData['violations'])}`,
      ).toBe(0)
      expect(lintData['event']).toBe('slide.lint.done')
    })
  }, 120_000)

  it('slide_dev が実 slidev の dev サーバを起こし、stop とサーバ終了でポートを解放する', async () => {
    // 実プロセスでしか観測できないものを 1 本にまとめる。
    //   - 実 slidev が起動して、応答 URL でデッキを配信すること。
    //   - 使用中ポートを指定すると、既存を止めずに失敗すること。
    //   - stop でポートが解放されること。
    //   - 止め忘れたサーバが、MCP サーバの終了 (client.close() → stdin EOF) で回収されること。
    // ポートは OS に選ばせて `port` で渡す (e2e lane は最大 6 並列で動く)。
    // 確保は、使う slide_dev 呼び出しの直前で行う。
    // 確保から使用までの間隔が空くと、その間に別 worker が同じ番号を掴み、dev-server-port-in-use になり得る。
    const talkDirectory = workDirectory('dev-talk')
    let leftRunningPort = 0

    await withClient(async (client, readStderr) => {
      const created = await client.callTool(
        { name: 'slide_create', arguments: { project_dir: talkDirectory, theme: createFixtureThemeSpec(workDirectory('dev-theme')) } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(created.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()

      const port = await findFreePort()
      const started = await client.callTool(
        { name: 'slide_dev', arguments: { dir: talkDirectory, port } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(started.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      const startedData = dataOf(started)
      expect(startedData['event']).toBe('slide.dev.started')
      expect(startedData['reused']).toBe(false)
      expect(typeof startedData['pid']).toBe('number')
      expect(startedData['port']).toBe(port)
      expect(startedData['url']).toBe(`http://localhost:${String(port)}`)

      // GET が返すのは vite のアプリシェルまで。スライド本体はクライアント側 JS が描くため、
      // ここで見るのは「Slidev が配信している」ところまで (描画の合否は利用者の目視)。
      const response = await fetch(String(startedData['url']))
      const html = await response.text()
      expect(response.status).toBe(200)
      expect(html).toContain('slidev:version')

      // 起動し直した後もブラウザが古い変換結果を使わないよう、`?v=` 付きの配信にも no-cache が付く。
      // Vite の既定は `max-age=31536000,immutable` で、`vite.config.ts` の server.headers がそれを上書きする。
      // @slidev/client の実体は、Slidev が使うものと同じ talk-dir の node_modules から求める。
      const clientEntry = realpathSync(createRequire(path.join(talkDirectory, 'package.json')).resolve('@slidev/client/main.ts'))
      const versioned = await fetch(`${String(startedData['url'])}/@fs/${clientEntry}?v=e2e`)
      const cacheControl = versioned.headers.get('cache-control')
      expect(versioned.status).toBe(200)
      expect(cacheControl).toBe('no-cache')
      expect(cacheControl).not.toContain('immutable')

      // 使用中のポートを指定すると、別ポートへ移らず既存のデッキを止めずに失敗する。
      // 実物の空き判定を通すのはここだけ (unit test は判定を差し替えるため、実物が誤って
      // 「空き」を返す回帰を検出できない)。
      const occupiedServer = createServer()
      try {
        await new Promise<void>((resolve, reject) => {
          occupiedServer.on('error', reject)
          occupiedServer.listen(0, '0.0.0.0', resolve)
        })
        const occupiedAddress = occupiedServer.address()
        if (occupiedAddress === null || typeof occupiedAddress === 'string') {
          throw new Error('使用中ポートを特定できませんでした')
        }

        const blocked = await client.callTool(
          { name: 'slide_dev', arguments: { dir: talkDirectory, port: occupiedAddress.port } },
          { timeout: DEV_SERVER_TIMEOUT_MS },
        )
        expect(blocked.isError, `子プロセス stderr: ${readStderr()}`).toBe(true)
        expect(dataOf(blocked)['reason']).toBe('dev-server-port-in-use')
        expect(await isPortListening(port)).toBe(true)
      }
      finally {
        // ポート番号は listen の時点で既に得ており、close の失敗で結果は変わらない。
        await new Promise<void>((resolve) => {
          occupiedServer.close(() => {
            resolve()
          })
        })
      }

      // 同じ talk-dir の再呼び出しは新しく起こさず、同じ URL を返す。使用中ポートでの
      // 失敗の直後でも、起動中のデッキ自体は影響を受けていないことも合わせて確かめる。
      const reused = await client.callTool(
        { name: 'slide_dev', arguments: { dir: talkDirectory } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(dataOf(reused)).toMatchObject({ event: 'slide.dev.reused', reused: true, port })

      // 別のポートを指定すると、起動中のサーバを止めてそのポートで開き直す。
      const reopenedPort = await findFreePort()
      const reopened = await client.callTool(
        { name: 'slide_dev', arguments: { dir: talkDirectory, port: reopenedPort } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(reopened.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(dataOf(reopened)).toMatchObject({ event: 'slide.dev.started', reused: false, port: reopenedPort })
      expect(await isPortListening(reopenedPort)).toBe(true)
      await expectPortReleased(port)

      const stopped = await client.callTool(
        { name: 'slide_dev', arguments: { dir: talkDirectory, stop: true } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(dataOf(stopped)).toMatchObject({ event: 'slide.dev.stopped', stopped: true, port: reopenedPort })
      await expectPortReleased(reopenedPort)

      // 最後の 1 本は止めずに残す。detach しない設計の証明はここから先にしかない。
      const leftRunningTargetPort = await findFreePort()
      const leftRunning = await client.callTool(
        { name: 'slide_dev', arguments: { dir: talkDirectory, port: leftRunningTargetPort } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      leftRunningPort = Number(dataOf(leftRunning)['port'])
      expect(await isPortListening(leftRunningPort)).toBe(true)
    })

    // withClient は client.close() まで済ませている。stdin の EOF で `pecotv mcp` が終わると、
    // 預かっていた dev サーバも道連れになる (孤児を残さない)。
    await expectPortReleased(leftRunningPort)
  }, 120_000)

  it('親プロセスへの SIGTERM でも dev サーバを回収する', async () => {
    // 終了の契機は stdin EOF / SIGTERM / SIGINT / 'exit' の 4 本ある。
    // in-process の serve.test.ts が見ているのはフェイクの signals までで、実シグナルは通っていない。
    // SIGTERM は実運用の主な流れになり得る。
    // MCP SDK の close は stdin を閉じて 2 秒待ち、終了していなければ SIGTERM を撃つ。
    // そのため、ここで 1 本通す。
    const talkDirectory = workDirectory('sigterm-talk')
    const transport = makeTransport()
    const readStderr = drainStderr(transport.stderr)
    const client = new Client({ name: 'pecotv-e2e-sigterm', version: '0.0.0' })

    try {
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
      const created = await client.callTool(
        { name: 'slide_create', arguments: { project_dir: talkDirectory, theme: createFixtureThemeSpec(workDirectory('sigterm-theme')) } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(created.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()

      // 確保は使う slide_dev 呼び出しの直前で行う (間隔が空くと別 worker に番号を取られ得る)。
      const port = await findFreePort()
      const started = await client.callTool(
        { name: 'slide_dev', arguments: { dir: talkDirectory, port } },
        { timeout: DEV_SERVER_TIMEOUT_MS },
      )
      expect(started.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(dataOf(started)['port']).toBe(port)
      expect(await isPortListening(port)).toBe(true)

      const pid = transport.pid
      if (typeof pid !== 'number') throw new TypeError('MCP サーバの pid を取得できませんでした')
      process.kill(pid, 'SIGTERM')

      await expectPortReleased(port)
      // 親も終わること。SIGTERM ハンドラを登録すると既定の即終了が無効になるため、
      // 明示 exit が欠けるとサーバが止まらないまま残る。
      await vi.waitFor(() => {
        expect(isReaped(pid), `MCP サーバ (pid ${String(pid)}) が終了していない`).toBe(true)
      }, { timeout: PORT_RELEASE_TIMEOUT_MS, interval: 100 })
    }
    finally {
      // 既に SIGTERM で終わっているプロセスへの close。報告先が無いので握り潰す。
      await ignoreRejection(client.close())
    }
  }, 120_000)

  it('chromium 未取得でも serve は続き、依存ツールは setup を案内する', async () => {
    // `pecotv mcp` は接続を MCP_TIMEOUT に収めるため chromium を起動条件から外し、デフォルトでは
    // 取得もしない (bin/pecotv)。未取得のまま呼ばれたときの見え方は、サーバプロセス側の
    // 環境でしか作れないのでここで観測する。空の browsers root を向けて未取得を作る。
    // 実ダウンロードを誘発しないよう opt-in の env は立てない。
    const emptyBrowsersRoot = mkdtempSync(path.join(tmpdir(), 'pecotv-test-e2e-nochromium-'))
    try {
      await withClient(async (client, readStderr) => {
        const blocked = await client.callTool(
          {
            name: 'drawio_export',
            arguments: { input_path: MINIMAL_DRAWIO, icons_dir: ICONS_DIR },
          },
          { timeout: REQUEST_TIMEOUT_MS },
        )

        expect(blocked.isError, `子プロセス stderr: ${readStderr()}`).toBe(true)
        expect(dataOf(blocked)).toMatchObject({
          event: 'chromium.unavailable',
          reason: 'chromium-not-installed',
          expectedAt: emptyBrowsersRoot,
        })
        expect(String(dataOf(blocked)['detail'])).toContain('`setup` ツール')

        // chromium を要さない呼び出しは同じプロセスでそのまま通る (サーバは落ちていない)。
        const succeeded = await client.callTool(
          { name: 'drawio_create', arguments: { input_path: MINIMAL_DRAWIO } },
          { timeout: REQUEST_TIMEOUT_MS },
        )

        expect(succeeded.isError).toBeUndefined()
        expect(dataOf(succeeded)['url']).toEqual(expect.stringContaining('https://'))
      }, { PLAYWRIGHT_BROWSERS_PATH: emptyBrowsersRoot })
    }
    finally {
      rmSync(emptyBrowsersRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it.skipIf(!isChromiumReady)('setup は chromium 取得済みならダウンロードせずに成功を返す', async () => {
    // 実プロセス経由で setup が呼べること (dist に含まれ、引数なしで通ること) を見る。
    // setup は取得済みでも `playwright install chromium` を実行する (判定が「取得済み」に
    // 倒れていても実体が欠けていることがあるため)。取得済みホストでは Playwright 側が
    // skip して数秒で返る。取得済みでないホストでは 120MB を落としに行くので skip する
    // — 実ダウンロードを伴う処理は bootstrap CUJ 13 が持つ。
    // browsers root は上書きしない (上書きすると必ず実ダウンロードになる)。
    await withClient(async (client, readStderr) => {
      const called = await client.callTool(
        { name: 'setup', arguments: {} },
        { timeout: SETUP_TIMEOUT_MS },
      )

      expect(called.isError, `子プロセス stderr: ${readStderr()}`).toBeUndefined()
      expect(dataOf(called)).toMatchObject({
        event: 'setup.skipped',
        runtime: { installed: true, downloaded: false },
        chromium: { installed: true, downloaded: false },
      })
      expect(artifactsOf(called), '何も置いていないので成果物は無い').toEqual([])
    })
  }, 120_000)

  it('エラー呼び出しのあとも同じプロセスが次の呼び出しに応える', async () => {
    await withClient(async (client, readStderr) => {
      const failed = await client.callTool(
        { name: 'drawio_create', arguments: { input_path: path.join(CLI_ROOT, 'no-such-dir-980', 'missing.drawio') } },
        { timeout: REQUEST_TIMEOUT_MS },
      )
      const succeeded = await client.callTool(
        { name: 'drawio_create', arguments: { input_path: MINIMAL_DRAWIO } },
        { timeout: REQUEST_TIMEOUT_MS },
      )

      expect(failed.isError, `子プロセス stderr: ${readStderr()}`).toBe(true)
      // 2 件目の応答が返れば、1 件目の失敗でプロセスは落ちていない (SC-005)。
      expect(succeeded.isError).toBeUndefined()
      expect(dataOf(succeeded)['url']).toEqual(expect.stringContaining('https://'))
    })
  }, 60_000)
})

// Issue #924 — `pecotv evidence create` を実 CLI プロセスとして通す e2e。
//
// integration test は in-process (parseAsync) で command を呼ぶ。
// そのため bin/pecotv → node dist/cli.js の起動手順と、`--out` を相対パスで渡したときの cwd 基準の解決は、
// この流れでしか観測できない。
// ヘッダー・キャプション・並び順 (US3) の指定が実プロセスの出力 xlsx まで届くことを、生成物の中身まで見て確かめる。

/* eslint-disable security/detect-non-literal-fs-filename */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildPng } from '../_helpers/image-fixture.js'
import {
  inlineStringTexts,
  mediaPartsByRelationship,
  OOXML_NS,
  parsePart,
  readSingleJsonEvent,
} from '../_helpers/ooxml-parts.js'
import { readZipEntries } from '../_helpers/zip-entries.js'
import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'

const HERE = import.meta.dirname
const CLI_TS_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_ROOT = path.resolve(CLI_TS_ROOT, '..')
const BIN_PECOTV = path.resolve(PLUGIN_ROOT, 'bin', 'pecotv')
const CLI_TS_SOURCE = path.join(CLI_TS_ROOT, 'src')
const CLI_TS_DIST = path.join(CLI_TS_ROOT, 'dist', 'cli.js')

interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
dist が src の変更を取り込んでいるかを見る。存在チェックだけだと、古い dist を
観測して「直したはずの退行が出ない / 直っていない退行が出る」ことに気付けない。
比較対象は tsconfig.build.json が実際にビルドする範囲 (テストファイルは除く) に揃える。
*/
function assertBuiltCliIsFresh(): void {
  if (!existsSync(CLI_TS_DIST)) {
    throw new Error(`cli dist が存在しません: ${CLI_TS_DIST}\n先に \`pnpm build\` を実行してください`)
  }
  const builtCliMtimeMs = statSync(CLI_TS_DIST).mtimeMs
  const staleSource = readdirSync(CLI_TS_SOURCE, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(filePath => !filePath.includes(`${path.sep}tests${path.sep}`))
    .find(filePath => statSync(filePath).mtimeMs > builtCliMtimeMs)
  if (staleSource !== undefined) {
    throw new Error(
      `cli dist が src より古いです (${staleSource} の方が新しい)\n`
      + '先に `pnpm build` を実行してください',
    )
  }
}

/**
bin/pecotv を cwd 指定で起動する。
bootstrap (pnpm install / build) は run-tests.sh が済ませているので、PECOTV_BOOTSTRAP_SKIP=1 でそのまま通す。
これで観測対象を CLI 本体に絞る。
*/
function runPecotv(arguments_: readonly string[], cwd: string): RunResult {
  const result = spawnSync(BIN_PECOTV, [...arguments_], {
    cwd,
    env: { ...process.env, PECOTV_BOOTSTRAP_SKIP: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

const workDirectory = useTemporaryDirectory('pecotv-924-evidence-cli-', { hook: 'all', resolveRealPath: true })

beforeAll(() => {
  assertBuiltCliIsFresh()
  // --out の cwd 基準解決を絶対パスで比較するため、symlink を解決した実体を使う。
})

afterAll(() => {
  if (workDirectory() !== '' && existsSync(workDirectory())) {
    rmSync(workDirectory(), { recursive: true, force: true })
  }
})

describe('pecotv evidence create の実プロセス実行', () => {
  it('指定順・caption 混在・複数ヘッダーの xlsx を cwd 基準の --out に書き出す', async () => {
    // caption は 2 件目だけファイル名の stem と異なる文言を明示し、明示と補完 (FR-004) を
    // 判別できるようにする。
    const shots = [
      { name: '03-logout.png', bytes: buildPng(1920, 1080, [200, 40, 40]), caption: undefined },
      { name: '01-login.png', bytes: buildPng(800, 600, [40, 80, 200]), caption: 'ログイン画面を表示' },
      { name: '02-submit.png', bytes: buildPng(400, 300, [40, 160, 80]), caption: undefined },
    ]
    for (const shot of shots) {
      writeFileSync(workDirectory(shot.name), shot.bytes)
    }
    const specPath = workDirectory('spec.json')
    writeFileSync(specPath, JSON.stringify({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-17',
      extraHeaders: [
        { label: '作成者', value: 'K. Hayakawa' },
        { label: '環境', value: 'staging' },
      ],
      // ファイル名の自然順 (01 → 02 → 03) とは別の順序を宣言する。
      items: shots.map(shot => (shot.caption === undefined
        ? { imagePath: workDirectory(shot.name) }
        : { imagePath: workDirectory(shot.name), caption: shot.caption })),
    }), 'utf8')

    const result = runPecotv(
      ['evidence', 'create', '--input', specPath, '--out', 'evidence.xlsx', '--json'],
      workDirectory(),
    )

    expect(result.status).toBe(0)
    const event = readSingleJsonEvent(result.stdout)
    expect(event['event']).toBe('result')
    // 相対 --out は起動時の cwd を基準に絶対パス化して報告される (FR-007)。
    expect(event['outPath']).toBe(workDirectory('evidence.xlsx'))
    expect(event['items']).toBe(3)
    expect(event['skipped']).toStrictEqual([])

    const entries = await readZipEntries(workDirectory('evidence.xlsx'))
    const sheet = parsePart(entries, 'xl/worksheets/sheet1.xml')
    expect(inlineStringTexts(sheet)).toStrictEqual([
      'ログイン機能 動作確認エビデンス',
      '作成日',
      '2026-08-17',
      '作成者',
      'K. Hayakawa',
      '環境',
      'staging',
      'No.1 03-logout',
      'No.2 ログイン画面を表示',
      'No.3 02-submit',
    ])

    const drawing = parsePart(entries, 'xl/drawings/drawing1.xml')
    expect(drawing.selectNodes('//xdr:oneCellAnchor//xdr:pic', OOXML_NS)).toHaveLength(3)
    const mediaParts = mediaPartsByRelationship(entries)
    const embeds = drawing.selectNodes('//a:blip', OOXML_NS).map(node => node.getAttr('r:embed') ?? '')
    expect(embeds).toStrictEqual(['rId1', 'rId2', 'rId3'])
    // 3 枚は寸法違いで byte が異なるため、順序を取り違えれば一致しない。
    expect(embeds.map(embed => entries.get(mediaParts.get(embed) ?? '')))
      .toStrictEqual(shots.map(shot => shot.bytes))
  })
})

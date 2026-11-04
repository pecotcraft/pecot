// T006: tools/list に載る 11 ツールの契約テスト。
//
// 期待値テーブル (TOOL_CONTRACTS) は、次の契約の原本からの **転記** になる。
//   aist-roadmap: specs/011-aistv-mcp-server/contracts/mcp-tools.md
// 原本は別リポジトリにあり、本リポジトリの CI からは参照できない。
// 契約が動いたときは、原本を直したうえで本テーブルも同時に直すこと。
//
// annotations だけは原本に規定が無く、#980 の実装計画で決めた方針を pin している。
//   - readOnlyHint: 何も書き換えない slide_lint のみ true。他は true にしない。
//     slide_page はページを書き出すため false のまま。
//   - openWorldHint: SDK 既定が true のため、false を明示するのは 4 件だけ。
//     対象は、ネットワークに到達しないことが確定する evidence_create / slide_lint /
//     slide_page / slide_theme。残りは既定のままで良く (false でなければ通る)、true を強制はしない。
//     slide_create と slide_sync は git でテーマを取得しうるため、明示しない。
//
// `setup` (#981) だけは、既定値と同じでも annotations を明示する。
// Claude Code は annotations から自動承認の可否を組み立てる。
// 120MB のダウンロードを始める本ツールが、読み取り専用や非破壊に見えてはならない。
// 専用の it で個別に pin している。
//
// 終了コードの値域そのものは、本テストの対象外とする。
// README の終了コード表は 5 コマンド分に分散し、exit 3 の行も無い。比べる先として使えない。
// README 側の整備は別 Issue 候補。
//
// FR-011 の相対パス規約は、Windows 形式の事前変換を挟む (#1094)。原本は未追従。

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'

import type { Tool } from '@modelcontextprotocol/server'
import { createChromiumCacheDirectory, removeChromiumCacheDirectory } from '../../../tests/_helpers/chromium-cache.js'
import { allTools } from '../tools/index.js'
import { isRecord } from '../../../tests/_helpers/records.js'
import { closeMcp, connectMcp, type ConnectedMcp } from './_client.js'
import { compareStrings } from '../../domain/_shared/compare-strings.js'

/**
JSON Schema の scalar 型 (契約表の「型」列)。integer は z.number().int() が落ちる先。
*/
type ParameterType = 'string' | 'boolean' | 'number' | 'integer'

interface ToolContract {
  readonly name: string
  /**
  inputSchema のプロパティ全集合と型。契約表の行と 1:1 で、CLI の --json は含めない。
  */
  readonly parameters: Readonly<Record<string, ParameterType>>
  /**
  必須パラメータ。
  */
  readonly required: readonly string[]
  /**
  絶対パス必須のパス型パラメータ (*_path / *_dir)。description に「絶対パス」を明記する。
  */
  readonly pathParameters: readonly string[]
  /**
  列挙値を持つパラメータ。zod は z.enum で表現する (JSON Schema の enum になる)。
  */
  readonly enums: Readonly<Record<string, readonly string[]>>
  /**
  既定値を持つパラメータと、その値。ここに無いパラメータは default を持ってはならない。
  */
  readonly defaults: Readonly<Record<string, string | boolean>>
  /**
  readOnlyHint: true を要求するか。
  */
  readonly readOnly: boolean
  /**
  ネットワーク到達の可能性があるか。false のツールは openWorldHint: false を明示する。
  */
  readonly openWorld: boolean
}

const TRANSITION_TYPES = ['fade', 'morph']
const MORPH_OPTIONS = ['byObject', 'byWord', 'byChar']

const TOOL_CONTRACTS: readonly ToolContract[] = [
  {
    name: 'slide_create',
    parameters: {
      project_dir: 'string',
      theme: 'string',
      force: 'boolean',
    },
    required: ['project_dir', 'theme'],
    pathParameters: ['project_dir'],
    enums: {},
    defaults: { force: false },
    readOnly: false,
    // git でテーマを取得するため、ネットワークに到達しうる。
    openWorld: true,
  },
  {
    name: 'slide_convert',
    parameters: {
      project_dir: 'string',
      out_path: 'string',
      theme: 'string',
      spacing_json_path: 'string',
      href_json_path: 'string',
      transition_type: 'string',
      transition_duration_ms: 'integer',
      morph_option: 'string',
      cache: 'boolean',
    },
    required: ['project_dir'],
    pathParameters: ['project_dir', 'out_path', 'spacing_json_path', 'href_json_path'],
    enums: { transition_type: TRANSITION_TYPES, morph_option: MORPH_OPTIONS },
    defaults: { cache: true },
    readOnly: false,
    openWorld: true,
  },
  {
    name: 'slide_sync',
    parameters: {
      dir: 'string',
      theme: 'string',
      node_modules_only: 'boolean',
    },
    required: ['dir'],
    pathParameters: ['dir'],
    enums: {},
    defaults: { node_modules_only: false },
    readOnly: false,
    // theme と node_modules_only は、テーマを git で取得しうる。
    openWorld: true,
  },
  {
    name: 'slide_lint',
    parameters: {
      dir: 'string',
    },
    required: ['dir'],
    pathParameters: ['dir'],
    enums: {},
    defaults: {},
    readOnly: true,
    openWorld: false,
  },
  {
    // `--remote` で全インタフェースに LISTEN する dev サーバを起こすため、openWorldHint は
    // 明示しない (「ネットワークに到達しないことが確定する」ツールではない)。
    name: 'slide_dev',
    parameters: {
      dir: 'string',
      port: 'integer',
      stop: 'boolean',
    },
    required: ['dir'],
    pathParameters: ['dir'],
    enums: {},
    defaults: { stop: false },
    readOnly: false,
    openWorld: true,
  },
  {
    name: 'slide_page',
    parameters: {
      layout: 'string',
      dir: 'string',
      file: 'string',
      force: 'boolean',
    },
    required: ['layout', 'dir', 'file'],
    pathParameters: ['dir'],
    enums: {},
    defaults: { force: false },
    readOnly: false,
    openWorld: false,
  },
  {
    name: 'slide_theme',
    parameters: {
      dir: 'string',
    },
    required: ['dir'],
    pathParameters: ['dir'],
    enums: {},
    defaults: {},
    readOnly: true,
    openWorld: false,
  },
  {
    name: 'drawio_create',
    parameters: {
      input_path: 'string',
      mode: 'string',
      out_path: 'string',
      png: 'boolean',
      theme: 'string',
    },
    required: ['input_path'],
    pathParameters: ['input_path', 'out_path'],
    enums: { mode: ['view', 'edit'] },
    defaults: { mode: 'view', png: true },
    readOnly: false,
    openWorld: true,
  },
  {
    name: 'drawio_export',
    parameters: {
      input_path: 'string',
      icons_dir: 'string',
      out_path: 'string',
      print_hash: 'boolean',
      pdf: 'boolean',
    },
    required: ['input_path'],
    pathParameters: ['input_path', 'icons_dir', 'out_path'],
    enums: {},
    defaults: { print_hash: false, pdf: true },
    readOnly: false,
    openWorld: true,
  },
  {
    name: 'evidence_create',
    parameters: {
      input_path: 'string',
      out_path: 'string',
    },
    required: ['input_path'],
    pathParameters: ['input_path', 'out_path'],
    enums: {},
    defaults: {},
    readOnly: false,
    openWorld: false,
  },
  {
    // 引数を取らない唯一のツール。Chromium を取得するので openWorld。
    name: 'setup',
    parameters: {},
    required: [],
    pathParameters: [],
    enums: {},
    defaults: {},
    readOnly: false,
    openWorld: true,
  },
]

/**
ToolResult 同形の outputSchema で必須になるフィールド (stdout / stderr は任意)。
*/
const OUTPUT_REQUIRED = ['artifacts', 'data', 'exitCode', 'message', 'ok']

// src/mcp/tests → cli/。実在しないディレクトリを起点に、実処理が即失敗する入力を作る。
const CLI_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const MISSING_DIRECTORY = path.join(CLI_ROOT, 'no-such-dir-980')
/**
プラグイン導入時の CLAUDE_PLUGIN_ROOT の値 (cli/ の親)。
*/
const PLUGIN_ROOT = path.resolve(CLI_ROOT, '..')

/**
相対パスの確認 (FR-011) を突く値。実処理まで進めば「入力不在」の exitCode 1 になる。
*/
const RELATIVE_PATH = 'no-such-dir-980/probe'
/**
slide_create の theme に渡す値。タグが無いため、取得の前に usage error で止まる。
*/
const NO_TAG_THEME = 'git+https://example.invalid/org/theme.git'
/**
タグ付きの git の指定。生成先が既にあれば取得の前に止まる (ネットワークには出ない)。
*/
const TAGGED_THEME = 'git+https://example.invalid/org/theme.git#v1.0.0'
/**
相対パスの確認の対象外にしたいパス引数へ入れる値。
*/
const ABSOLUTE_PATH = path.join(MISSING_DIRECTORY, 'probe')

/**
即失敗テーブルの対象外にするツール。`setup` は引数を取らないため、入力起因の即失敗を作れない。
失敗させるには、実際に Chromium の取得を動かすしかない (取得先の細工が要る)。
出力捕捉を含む setup の応答は src/mcp/tools/tests/setup.test.ts が見る。
`slide_theme` は読み取りだけで何も出力しないため、出力捕捉（stdout / stderr のキー）の対象外にする。
*/
const NO_FAST_FAILURE = new Set(['setup', 'slide_theme'])

/**
実処理に入って即座に失敗する引数。「捕捉した出力は空でもキーを残す」を一律で見るために使う。
成功時の呼び出しは実 build / LibreOffice を起こし、e2e 相当の重さになる。
捕捉の有無という観測対象は、失敗時でも変わらない。
*/
const FAST_FAILURES: readonly { readonly name: string, readonly arguments: Readonly<Record<string, unknown>> }[] = [
  // タグの無いテーマの指定は、取得と生成先のどちらよりも先に弾かれる。
  { name: 'slide_create', arguments: { project_dir: path.join(MISSING_DIRECTORY, 'deck'), theme: NO_TAG_THEME } },
  {
    name: 'slide_convert',
    arguments: {
      project_dir: path.join(MISSING_DIRECTORY, 'deck'),
      out_path: path.join(MISSING_DIRECTORY, 'deck.pptx'),
    },
  },
  { name: 'slide_sync', arguments: { dir: path.join(MISSING_DIRECTORY, 'talk') } },
  { name: 'slide_lint', arguments: { dir: path.join(MISSING_DIRECTORY, 'talk') } },
  // 実在しない talk-dir は spawn する前に弾かれる (dev サーバの ready 待ちには入らない)。
  { name: 'slide_dev', arguments: { dir: path.join(MISSING_DIRECTORY, 'talk') } },
  // 実在しない talk-dir はテーマを引く前に弾かれる (参照 yaml も開かない)。
  {
    name: 'slide_page',
    arguments: { layout: 'two-column', dir: path.join(MISSING_DIRECTORY, 'talk'), file: 'probe' },
  },
  { name: 'drawio_create', arguments: { input_path: path.join(MISSING_DIRECTORY, 'diagram.drawio') } },
  {
    name: 'drawio_export',
    arguments: { input_path: path.join(MISSING_DIRECTORY, 'diagram.drawio'), icons_dir: MISSING_DIRECTORY },
  },
  { name: 'evidence_create', arguments: { input_path: path.join(MISSING_DIRECTORY, 'spec.json') } },
]

/**
Windows 形式の表記 2 種。どちらも `<mount root>/c/pecotv-1094/missing` に畳まれる。

Windows のクライアントは区切りをバックスラッシュで組むが、JSON の手書きを嫌って
スラッシュで送るクライアントもあるため、両方を同じ結果に落とすことを見る。
*/
const WINDOWS_PATHS = [String.raw`C:\pecotv-1094\missing`, 'C:/pecotv-1094/missing']

/**
Windows 形式の変換を観測するための、ツールごとの基本の引数。

対象のパス引数だけを Windows 形式に差し替えて呼ぶ。
FAST_FAILURES と分けているのは、変換後のパスが応答に現れるところまで見たいため。
slide_create は生成先が既にあるとき、取得の前に止まる。
drawio_export は print_hash を使って chromium を避ける。
*/
const WINDOWS_BASE_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  slide_create: { project_dir: path.join(MISSING_DIRECTORY, 'deck'), theme: TAGGED_THEME },
  slide_convert: { project_dir: path.join(MISSING_DIRECTORY, 'deck') },
  slide_sync: { dir: path.join(MISSING_DIRECTORY, 'talk') },
  slide_lint: { dir: path.join(MISSING_DIRECTORY, 'talk') },
  slide_dev: { dir: path.join(MISSING_DIRECTORY, 'talk') },
  slide_page: { layout: 'two-column', dir: path.join(MISSING_DIRECTORY, 'talk'), file: 'probe' },
  slide_theme: { dir: path.join(MISSING_DIRECTORY, 'talk') },
  drawio_create: { input_path: path.join(MISSING_DIRECTORY, 'diagram.drawio') },
  drawio_export: { input_path: path.join(MISSING_DIRECTORY, 'diagram.drawio'), print_hash: true },
  evidence_create: { input_path: path.join(MISSING_DIRECTORY, 'spec.json') },
  setup: {},
}

/**
パス引数が 1 件のツール。変換後の値が下流の応答に現れることで観測する。
*/
const SINGLE_PATH_CONTRACTS = TOOL_CONTRACTS.filter(contract => contract.pathParameters.length === 1)

/**
SINGLE_PATH_CONTRACTS の各ツールが、変換後のパス (実在する空ディレクトリ) を受け取ったときに、
実処理へ進んで即座に失敗する reason。測定結果 (#1094 F-15) は次のとおり。
  - slide_create は dest dir が既に存在するため usage エラー。
  - slide_sync / slide_lint / slide_dev / slide_page は、空ディレクトリが talk-dir の体をなしていないため実行時エラー。

「空ディレクトリを受理する」方向へ挙動が変わると、このテーブルとの不一致でテストが落ちる。
その変化に気付かないまま実行を続けると、表記 2 種ぶんの実 scaffold / dev サーバ起動が毎回動く、
重いテストへ静かに変わってしまう。
*/
const SINGLE_PATH_IMMEDIATE_FAILURE: Readonly<Record<string, string>> = {
  slide_create: 'dest-exists',
  slide_sync: 'not-talk-dir',
  slide_lint: 'not-talk-dir',
  slide_dev: 'slides-md-not-found',
  slide_page: 'theme-none',
  slide_theme: 'theme-none',
}

/**
パス引数が 2 件以上のツール。拒否結果の convertedPaths で観測する。
*/
const MULTI_PATH_CONTRACTS = TOOL_CONTRACTS.filter(contract => contract.pathParameters.length > 1)

function windowsBaseArgumentsOf(name: string): Readonly<Record<string, unknown>> {
  // eslint-disable-next-line security/detect-object-injection -- name は本ファイルの期待値テーブル由来
  const base = WINDOWS_BASE_ARGUMENTS[name]
  if (base === undefined) throw new Error(`${name} の基盤引数が未定義です`)
  return base
}

function sorted(values: readonly string[]): readonly string[] {
  return values.toSorted(compareStrings)
}

/**
tools/call の structuredContent を Record として取り出す。
*/
function structuredOf(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const structured = result['structuredContent']
  if (!isRecord(structured)) throw new Error('structuredContent が返っていません')
  return structured
}

/**
JSON Schema のプロパティ 1 件を Record として取り出す。
*/
function propertyOf(schema: Readonly<Record<string, unknown>> | undefined, name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-object-injection -- name は本ファイルの期待値テーブル由来の定数
  const property = schema?.[name]
  if (!isRecord(property)) throw new Error(`JSON Schema に ${name} がありません`)
  return property
}

describe('MCP ツール契約 (tools/list)', () => {
  let listed: readonly Tool[] = []
  let connected: ConnectedMcp | undefined
  // 即失敗テーブルは、chromium 依存ツールも実処理へ入れて出力捕捉を観測する。
  // 実行ホストが chromium 未取得だと、実行時ガードが捕捉前に返してしまう。そのため取得済みに固定する
  // (ガードそのものの確認は tools/tests/chromium-guard.test.ts が持つ)。
  let chromiumCacheDirectory = ''
  // Windows 形式の変換先。実行ホストが WSL でも `C:\` 実体へ書かないよう mount root を差し替える。
  let mountRoot = ''
  let convertedPath = ''

  beforeAll(async () => {
    chromiumCacheDirectory = createChromiumCacheDirectory(true)
    mountRoot = mkdtempSync(path.join(tmpdir(), 'pecotv-1094-mount-'))
    convertedPath = path.join(mountRoot, 'c', 'pecotv-1094', 'missing')
    // 実体を置くのは、変換後のパスが下流の応答に現れる失敗 (既存ディレクトリ / talk-dir でない)
    // まで進ませるため。無いと、最初のパス確認より後ろを観測できないツールがある。
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- mkdtemp で作った tmp 配下の固定名
    mkdirSync(convertedPath, { recursive: true })
    connected = await connectMcp(allTools())
    const result = await connected.client.listTools()
    listed = result.tools
  })

  beforeEach(() => {
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', chromiumCacheDirectory)
    vi.stubEnv('PECOTV_WSL_MOUNT_ROOT', mountRoot)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    if (connected !== undefined) await closeMcp(connected)
    removeChromiumCacheDirectory(chromiumCacheDirectory)
    rmSync(mountRoot, { recursive: true, force: true })
  })

  function client(): ConnectedMcp['client'] {
    if (connected === undefined) throw new Error('サーバへ接続できていません')
    return connected.client
  }

  function toolOf(name: string): Tool {
    const found = listed.find(tool => tool.name === name)
    if (found === undefined) throw new Error(`tools/list に ${name} が載っていません`)
    return found
  }

  it('契約どおり 11 件のツールを公開する', () => {
    expect(listed).toHaveLength(TOOL_CONTRACTS.length)
    expect(sorted(listed.map(tool => tool.name))).toEqual(sorted(TOOL_CONTRACTS.map(contract => contract.name)))
  })

  it('CLAUDE_PLUGIN_ROOT 未設定でもサーバ生成と tools/list が成功する', async () => {
    // 既定 deps ファクトリは CLAUDE_PLUGIN_ROOT 未設定で throw する。
    // deps をモジュール top-level や allTools() の評価時に組み立てると、11 件まとめて公開できなくなる。
    // deps はハンドラ内で毎回生成する、という設計をここで pin する。

    vi.stubEnv('CLAUDE_PLUGIN_ROOT', undefined)
    const connected = await connectMcp(allTools())
    try {
      const result = await connected.client.listTools()
      expect(result.tools).toHaveLength(TOOL_CONTRACTS.length)
    }
    finally {
      await closeMcp(connected)
    }
  })

  it.each(TOOL_CONTRACTS)('$name の inputSchema が契約表と一致する', (contract) => {
    const tool = toolOf(contract.name)
    const properties = tool.inputSchema.properties

    expect(sorted(Object.keys(properties ?? {}))).toEqual(sorted(Object.keys(contract.parameters)))
    expect(sorted(tool.inputSchema.required ?? [])).toEqual(sorted(contract.required))

    for (const [name, type] of Object.entries(contract.parameters)) {
      const property = propertyOf(properties, name)
      expect(property['type']).toBe(type)
      // description はエージェントが引数を決める唯一の手掛かりなので全パラメータに要る。
      expect(typeof property['description']).toBe('string')
      expect(property['description']).not.toBe('')
    }

    for (const [name, values] of Object.entries(contract.enums)) {
      expect(propertyOf(properties, name)['enum']).toEqual(values)
    }
  })

  it.each(TOOL_CONTRACTS)('$name の inputSchema が契約表どおりの既定値を持つ', (contract) => {
    const properties = toolOf(contract.name).inputSchema.properties ?? {}

    // 契約表に無いパラメータが既定値を持ってしまう退行も見たいので、集合として比べる。
    const withDefault = Object.entries(properties)
      .filter(([, property]) => isRecord(property) && 'default' in property)
      .map(([name]) => name)
    expect(sorted(withDefault)).toEqual(sorted(Object.keys(contract.defaults)))

    for (const [name, value] of Object.entries(contract.defaults)) {
      expect(propertyOf(properties, name)['default']).toEqual(value)
    }
  })

  it.each(TOOL_CONTRACTS)('$name のパス型パラメータが絶対パス必須だと description に書いてある', (contract) => {
    const properties = toolOf(contract.name).inputSchema.properties
    for (const name of contract.pathParameters) {
      expect(propertyOf(properties, name)['description']).toContain('絶対パス')
      // 受理する形は description が唯一の手掛かりなので、Windows 形式も同じ行に書く (#1094)。
      expect(propertyOf(properties, name)['description']).toContain('Windows')
    }
  })

  it.each(TOOL_CONTRACTS)('$name のパス型パラメータは相対パスなら実処理前に exitCode 2 で弾く', async (contract) => {
    // 必須パラメータは絶対パスで埋め、対象の 1 件だけを相対パスにする。
    // 実処理まで進めば、結果は「入力不在」の exitCode 1。
    // exitCode 2 を返すこと自体が、実行前の拒否の証拠となる (FR-011)。
    const absoluteRequired = Object.fromEntries(contract.required.map(name => [name, ABSOLUTE_PATH]))

    for (const name of contract.pathParameters) {
      const called = await client().callTool({
        name: contract.name,
        arguments: { ...absoluteRequired, [name]: RELATIVE_PATH },
      })
      const structured = structuredOf(called)

      expect(called.isError, `${contract.name}.${name}`).toBe(true)
      expect(structured['exitCode'], `${contract.name}.${name}`).toBe(2)
      expect(structured['artifacts']).toEqual([])
      expect(structured['data']).toEqual({ invalidPaths: [`${name}=${RELATIVE_PATH}`] })
    }
  })

  it('Windows 形式の検証がパス型パラメータを持つ全ツールを覆う', () => {
    expect(sorted([...SINGLE_PATH_CONTRACTS, ...MULTI_PATH_CONTRACTS].map(contract => contract.name)))
      .toEqual(sorted(TOOL_CONTRACTS
        .filter(contract => contract.pathParameters.length > 0)
        .map(contract => contract.name)))
  })

  it.each(SINGLE_PATH_CONTRACTS)('$name は Windows 形式のパスを変換して下流へ渡す', async (contract) => {
    // パス引数が 1 件のツールは、変換後の値がそのまま下流へ渡るので応答 (message / data) に現れる。
    // slide 系の既定 deps ファクトリは CLAUDE_PLUGIN_ROOT を要る。未設定だと、引数を見る前に失敗する。
    // すると変換後のパスが応答に出ない。プラグイン導入時と同じ値を入れて、実処理まで進ませる。
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
    const base = windowsBaseArgumentsOf(contract.name)

    for (const windowsPath of WINDOWS_PATHS) {
      for (const name of contract.pathParameters) {
        const structured = structuredOf(await client().callTool({
          name: contract.name,
          arguments: { ...base, [name]: windowsPath },
        }))

        // 変換に失敗していれば最初のガードで弾かれ、ここに invalidPaths が載る。
        expect(structured['data'], `${contract.name}.${name} (${windowsPath})`)
          .not.toHaveProperty('invalidPaths')
        expect(
          JSON.stringify([structured['message'], structured['data']]),
          `${contract.name}.${name} (${windowsPath})`,
        ).toContain(convertedPath)

        // 変換後のパス (実在する空ディレクトリ) を受けて実処理へ進み、即座に失敗している前提を
        // 明示的に pin する (#1094 F-15)。空ディレクトリを受理する方向へ挙動が変わっても
        // ここで検知できないと、実 scaffold / dev サーバ起動を伴う重いテストへ静かに変わる。
        const expectedReason = SINGLE_PATH_IMMEDIATE_FAILURE[contract.name]
        if (expectedReason === undefined) throw new Error(`${contract.name} の即失敗 reason が SINGLE_PATH_IMMEDIATE_FAILURE に未定義です`)
        expect(structured['ok'], `${contract.name}.${name} (${windowsPath})`).toBe(false)
        expect(structured['data'], `${contract.name}.${name} (${windowsPath})`).toMatchObject({ reason: expectedReason })
      }
    }
  })

  it.each(MULTI_PATH_CONTRACTS)('$name は Windows 形式のパスを変換して受理する', async (contract) => {
    // パス引数が 2 件以上のツールには、下流が out_path 等を応答に載せない場合がある。
    // 「変換後のパスが応答に現れる」だけでは、全引数を覆えない。
    // そこで 2 点で引数ごとに変換を観測する。
    // 1 点目は、受理されること (invalidPaths が無いこと)。
    // 2 点目は、別のパス引数を相対パスにして拒否させたときの data.convertedPaths (元値 → 変換後)。
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
    const base = windowsBaseArgumentsOf(contract.name)

    for (const windowsPath of WINDOWS_PATHS) {
      for (const name of contract.pathParameters) {
        const accepted = structuredOf(await client().callTool({
          name: contract.name,
          arguments: { ...base, [name]: windowsPath },
        }))
        expect(accepted['data'], `${contract.name}.${name} (${windowsPath})`)
          .not.toHaveProperty('invalidPaths')

        const companion = contract.pathParameters.find(other => other !== name)
        if (companion === undefined) throw new Error(`${contract.name}.${name} に相方のパス引数がありません`)
        const rejected = structuredOf(await client().callTool({
          name: contract.name,
          arguments: { ...base, [name]: windowsPath, [companion]: RELATIVE_PATH },
        }))

        expect(rejected['exitCode'], `${contract.name}.${name} (${windowsPath})`).toBe(2)
        expect(rejected['data'], `${contract.name}.${name} (${windowsPath})`).toEqual({
          invalidPaths: [`${companion}=${RELATIVE_PATH}`],
          convertedPaths: { [name]: { from: windowsPath, to: convertedPath } },
        })
      }
    }
  })

  it('drawio_create の out_path を変換後の mount root 配下へ向けると artifacts に変換後パスが載る (#1094 F-13)', async () => {
    // 直前の 2 テストは、「受理されること (invalidPaths 無し)」までしか見ていない。
    // out_path が実際に下流 (成果物の書き出し先) で使われることまでは、テストで覆えていなかった。
    // 対象は drawio_create / drawio_export / slide_convert の out_path。
    // 下流利用まで見ていたのは、evidence_create の E2E だけだった。
    // そこで Chromium を要らない設定 (png: false) の drawio_create を 1 件足す。
    // 既定 deps ファクトリは CLAUDE_PLUGIN_ROOT 未設定で throw する。
    // プラグイン導入時と同じ値を入れて実処理まで進ませる (SINGLE_PATH_CONTRACTS 系のテストと同じ理由)。
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', PLUGIN_ROOT)
    const inputPath = path.join(CLI_ROOT, 'tests', 'fixtures', 'drawio', 'minimal.drawio')
    const windowsOutPath = String.raw`C:\pecotv-1094\missing\diagram.drawio.html`
    const expectedOutPath = path.join(convertedPath, 'diagram.drawio.html')

    const structured = structuredOf(await client().callTool({
      name: 'drawio_create',
      arguments: { input_path: inputPath, out_path: windowsOutPath, png: false },
    }))

    expect(structured['ok']).toBe(true)
    expect(structured['exitCode']).toBe(0)
    expect(structured['artifacts']).toEqual([expectedOutPath])
  })

  it.each(TOOL_CONTRACTS)('$name が ToolResult 同形の outputSchema を公開する', (contract) => {
    const outputSchema = toolOf(contract.name).outputSchema
    const properties = Object.keys(outputSchema?.['properties'] ?? {})
    const required = outputSchema?.['required']

    expect(properties).toEqual(expect.arrayContaining(OUTPUT_REQUIRED))
    // stdout / stderr は捕捉できたときだけ載るため必須にしない。
    expect(sorted(Array.isArray(required) ? required.map(String) : [])).toEqual(OUTPUT_REQUIRED)
  })

  it.each(TOOL_CONTRACTS)('$name の annotations が実行判断のヒントを持つ', (contract) => {
    const annotations = toolOf(contract.name).annotations ?? {}
    expect(annotations.readOnlyHint === true).toBe(contract.readOnly)
    expect(annotations.openWorldHint === false).toBe(!contract.openWorld)
  })

  it.each(TOOL_CONTRACTS)('$name が title と description を持つ', (contract) => {
    const tool = toolOf(contract.name)
    // title はツール一覧の見出しとして 11 件横並びで出るため、1 件でも欠けると並びが崩れる。
    expect(typeof tool.title).toBe('string')
    expect(tool.title).not.toBe('')
    expect(typeof tool.description).toBe('string')
    expect(tool.description).not.toBe('')
  })

  it.each(['drawio_create', 'evidence_create'])('%s は生成前に文言を文章規則で確認すると description に書いてある', (name) => {
    // 違反で生成されないことを、呼び出す側が description から読み取れるようにする。
    expect(toolOf(name).description).toContain('文章規則で確認し、違反があれば生成しない')
  })

  it('即失敗テーブルが setup 以外の全ツールを覆う', () => {
    expect(sorted(FAST_FAILURES.map(entry => entry.name)))
      .toEqual(sorted(TOOL_CONTRACTS
        .map(contract => contract.name)
        .filter(name => !NO_FAST_FAILURE.has(name))))
  })

  it('setup が引数を取らず、破壊的かつ外部到達として宣言されている', () => {
    // Claude Code は annotations から自動承認の可否を組み立てるため、Chromium を
    // ダウンロードする本ツールが読み取り専用や非破壊に見えてはいけない。
    const tool = toolOf('setup')

    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([])
    expect(tool.annotations?.readOnlyHint).not.toBe(true)
    expect(tool.annotations?.destructiveHint).toBe(true)
    expect(tool.annotations?.openWorldHint).toBe(true)
    // 何度呼んでも状態は変わらない (取得済みなら Playwright 側が skip する)。
    expect(tool.annotations?.idempotentHint).toBe(true)
    // 利用者が許可判断できるよう、いつ呼ぶかとダウンロード量を description に書く。
    // 取得対象は 2 系統 (実行時依存の永続層 / Chromium) なので両方の量を出す。
    expect(tool.description).toContain('120MB')
    expect(tool.description).toContain('600MB')
  })

  it.each(FAST_FAILURES)('$name は捕捉した出力が空でも stdout / stderr のキーを残す', async (failure) => {
    // stdout / stderr が省略されるのは「捕捉していない」ときだけ、という宣言 (tools/_shared.ts)
    // を 11 ツール一律で pin する。相対パス拒否は捕捉前に返るので、ここでは実処理へ入る
    // 引数 (絶対パスだが実在しない入力) を使う。
    const structured = structuredOf(await client().callTool({
      name: failure.name,
      arguments: { ...failure.arguments },
    }))

    // 相対パス拒否になっていないこと = 捕捉を伴う処理まで進んだことの確認。
    expect(structured['data'], `${failure.name} が実処理へ入っていない`).not.toHaveProperty('invalidPaths')
    expect(typeof structured['stdout'], `${failure.name} の stdout`).toBe('string')
    expect(typeof structured['stderr'], `${failure.name} の stderr`).toBe('string')
  })
})

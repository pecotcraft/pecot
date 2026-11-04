// 11 ツール共通の outputSchema と、ハンドラが系統別ファイルに複製していた定型処理。
//
// outputSchema は ToolResult (src/mcp/result.ts) と同形の zod object で、全ツールが共有する。
// contract.test.ts は、required が artifacts・data・exitCode・message・ok の sorted であることを pin している。
// stdout / stderr は任意として pin しているため、フィールドの必須性はここでのみ管理する。
//
// 出力捕捉・エラー整形・パス引数の説明文は、11 ツールで同一の振る舞いが要る。
// とくに stdout / stderr は「捕捉したなら空でもキーを残す」が契約なので、実装はここに 1 本だけ置く。
//
// 引数の narrowing も、4 ファイル共通の方式に揃える。
// SDK は inputSchema で検証済みの引数を渡してくる。ただしハンドラの引数型は Record<string, unknown> のまま。
// そこで inputSchema と同じ z.object で parse し直して型を得る。
// これは `as` キャスト禁止の下で型を得る手段で、検証済みの引数に対しては既定値の適用も冪等になる。

import path from 'node:path'
import type { Writable } from 'node:stream'

import { z } from 'zod'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import {
  areRuntimeDependenciesInstalled,
  DEPENDENCY_RECOVERY_HINT,
  runtimeDependencyRoot,
} from '../../infra/_shared/dependency-root.js'
import { LOCK_CONFLICT_EXIT_CODE, LOCK_WAIT_SECONDS } from '../../infra/_shared/flock.js'
import { resolvePluginRoot } from '../../infra/_shared/plugin-root.js'
import { installRuntimeDependencies, runtimeInstallStamp, RUNTIME_MANIFEST_DIRECTORY, type RuntimeInstallResult } from '../../infra/_shared/runtime-install.js'
import {
  AUTO_INSTALL_ENV,
  browsersRoot,
  installChromium,
  isAutoInstallEnabled,
  isChromiumInstalled,
} from '../../infra/playwright/chromium.js'
import { createOutputCapture, truncateCapturedText, type ToolResult } from '../result.js'
import { toPosixPath } from '../windows-path.js'

/**
パス型パラメータの description 末尾に足す 1 文 (直前の文は句点で閉じてから連結する)。

配布 README は Windows の MCP クライアントに WSL2 経由での起動を案内しており、
クライアントが渡すパスは Windows 形式になる。受理する形を description に書かないと、
エージェントは「絶対パス」の指示から POSIX パスだけを組み立てようとして詰まる。
変換の実装は src/mcp/windows-path.ts。
*/
export const WINDOWS_PATH_NOTE
  = String.raw`Windows 形式 (C:\... / \\wsl.localhost\<distro>\...) で渡した場合は、`
    + '/mnt/<drive>/ 配下または WSL 内の絶対パスへ変換して受け付ける。'

/**
ToolResult 同形の outputSchema。

data はツールごとに形が異なる (対応 CLI の --json 出力と同形) ため、共通スキーマでは
record として受け、同形性の検証は contract / parity テスト側で行う。
*/
export const TOOL_OUTPUT_SCHEMA = z.object({
  ok: z.boolean().describe('ツールが目的の実行を完了したか'),
  exitCode: z.number().describe('終了コード (0 = success)'),
  artifacts: z.array(z.string()).describe('生成・更新したファイル・ディレクトリの絶対パス'),
  data: z.record(z.string(), z.unknown()).describe('実行結果の詳細オブジェクト'),
  message: z.string().describe('呼び出し元エージェント向けの 1 行サマリ'),
  stdout: z.string().optional().describe('捕捉した stdout (未捕捉のときは省略)'),
  stderr: z.string().optional().describe('捕捉した stderr (未捕捉のときは省略)'),
})

export interface CommandOutput {
  /**
  既存コマンドの deps.stdout / deps.stderr にそのまま渡す。
  */
  readonly stdout: Writable
  readonly stderr: Writable
  /**
  捕捉した内容を ToolResult へ転写する。

  内容が空でもキーは残す。ToolResult の stdout / stderr が省略されるのは「捕捉していない」
  ときで、捕捉した結果が空であることとは意味が違う。
  */
  part(): Pick<ToolResult, 'stdout' | 'stderr'>
}

/**
MCP サーバの process.stdout は JSON-RPC 専有なので、コマンドの出力は必ずここへ逃がす。
*/
export function captureCommandOutput(): CommandOutput {
  const stdout = createOutputCapture()
  const stderr = createOutputCapture()
  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
    part: () => ({ stdout: stdout.text(), stderr: stderr.text() }),
  }
}

/**
子プロセスの結果を ToolResult の stdout / stderr へ載せる形に整える。

Writable を通さない出力にも、captureCommandOutput と同じ上限をかけるための関数。
空でもキーを残すのは CommandOutput.part() と同じ契約。
*/
export function spawnOutputPart(result: Readonly<SpawnResult>): Pick<ToolResult, 'stdout' | 'stderr'> {
  return {
    stdout: truncateCapturedText(result.stdout),
    stderr: truncateCapturedText(result.stderr),
  }
}

/**
ツールの失敗 message / data.detail に載せる 1 行の理由。
*/
export function formatError(error: unknown): string {
  /* c8 ignore next -- 非 Error 例外は本実装範囲では未発生、false 分岐は防御網のみ */
  return error instanceof Error ? error.message : String(error)
}

/**
文面の違反で生成を止めたときの message。drawio_create と evidence_create で同じ文言にする。
*/
export function textViolationMessage(count: number): string {
  return `文面の違反 ${count.toString()} 件。規則は緩めず文面を直して再実行してください`
}

/**
errorData の data から、文面の違反の件数を取る。違反を持たない失敗は undefined。
*/
export function violationCountOf(data: Readonly<Record<string, unknown>>): number | undefined {
  const violations = data['violations']
  return Array.isArray(violations) ? violations.length : undefined
}

/**
chromium 不在 / 取得失敗で実処理を諦めたときの exit code (各コマンドの RuntimeError と同じ 1)。
*/
export const CHROMIUM_UNAVAILABLE_EXIT_CODE = 1

/**
実行時依存 (永続層) 不在 / 取得失敗で実処理を諦めたときの exit code。
*/
export const RUNTIME_UNAVAILABLE_EXIT_CODE = 1

/**
永続層の場所を特定できないときに利用者向けの応答へ載せる既定の表記。
*/
export const RUNTIME_ROOT_PLACEHOLDER = '<データ置き場>/mcp-dist'

/**
chromium の取得状態を扱う依存。既定は infra/playwright/chromium.ts の実装。

実際の取得は 120MB 級のダウンロードを伴うため、テストからは差し替えられる形にする
(ツール定義がファクトリ関数で deps を受ける slide 系と同じ扱い)。
*/
export interface ChromiumDependencies {
  readonly isInstalled: () => Promise<boolean>
  readonly isAutoInstallEnabled: () => boolean
  readonly browsersRoot: () => string | undefined
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal は可変。EventTarget で addEventListener を呼ぶため readonly 化できない
  readonly install: (signal?: AbortSignal) => Promise<SpawnResult>
}

export function chromiumDefaultDependencies(): ChromiumDependencies {
  return {
    isInstalled: isChromiumInstalled,
    isAutoInstallEnabled,
    browsersRoot,
    install: signal => installChromium({ signal }),
  }
}

/**
取得先として期待している場所。特定できないときも、文言が崩れないようにする。
*/
function expectedLocation(dependencies: Readonly<ChromiumDependencies>): string {
  return dependencies.browsersRoot() ?? 'Playwright の既定の browsers ディレクトリ'
}

/**
取得先とネットワークの設定を確認させる誘導。bin/pecotv の fatal メッセージと同じ内容に揃える。
*/
const NETWORK_HINT
  = 'ネットワーク到達性 / プロキシ設定 (HTTPS_PROXY / HTTP_PROXY) / PLAYWRIGHT_DOWNLOAD_HOST を確認のうえ再実行してください。'

/**
TLS の鎖の検証で失敗したと判断する stderr の目印。

前半は node が TLS エラーに付ける OpenSSL の検証コード (npm はこれを err.code として出す)。
`UNABLE_TO_GET_ISSUER_CERT` は部分一致なので `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` も拾う。
後半は playwright の取得が出す OpenSSL の文言 (コードではなく message に出る)。

`CERT` だけのような広い一致は使わない。取得先 URL やパスに文字列として現れるだけで
誤って誘導が付き、無関係な失敗の原因を TLS に見せてしまう。
*/
const TLS_FAILURE_MARKERS: readonly string[] = [
  'unable_to_get_issuer_cert',
  'unable_to_verify_leaf_signature',
  'self_signed_cert_in_chain',
  'depth_zero_self_signed_cert',
  'cert_has_expired',
  'unable to verify the first certificate',
  'unable to get local issuer certificate',
  'self signed certificate in certificate chain',
]

/**
TLS 証明書の検証失敗に添える、利用者向けの誘導。
SSL を中継するプロキシの配下では、そのプロキシの CA が必要になる。
pecot は証明書を同梱しないので、利用者が NODE_EXTRA_CA_CERTS で渡す。
*/
const TLS_CERT_HINT
  = 'TLS 証明書の検証で失敗しています。SSL を中継するプロキシの配下では、'
    + 'そのプロキシの CA を含む PEM ファイルのパスを NODE_EXTRA_CA_CERTS に設定してください。'
    + '設定済みの場合は、その PEM にプロキシの CA が含まれているか確認してください。'

/**
取得プロセスの stderr が TLS の証明書検証の失敗を示すなら足す 1 文。示さなければ空文字。

実行時依存側 (setup.ts の runtimeInstallFailureDetail) と chromium 側で同じ判定・同じ文言を
使うため、ここに 1 つだけ置く。
*/
export function tlsCertificateHint(result: Readonly<SpawnResult>): string {
  const stderr = result.stderr.toLowerCase()
  return TLS_FAILURE_MARKERS.some(marker => stderr.includes(marker)) ? TLS_CERT_HINT : ''
}

/**
取得が失敗したときに載せる理由。stderr が TLS の証明書検証の失敗を示すなら誘導を足す。
*/
export function chromiumInstallFailureDetail(result: Readonly<SpawnResult>): string {
  return `${chromiumFailureReason(result)}${tlsCertificateHint(result)}`
}

/**
失敗の種類ごとの理由 (誘導を足す前の本文)。

SpawnResult.exitCode は、起動失敗 (ENOENT・playwright 未解決) とシグナル終了でも null になる。
`exit null` という無意味な文言を出さないよう、原因ごとに分岐する。
*/
function chromiumFailureReason(result: Readonly<SpawnResult>): string {
  if (result.exitCode === LOCK_CONFLICT_EXIT_CODE) {
    return `別のプロセスが chromium を取得中です (ロック待ちが ${String(LOCK_WAIT_SECONDS)} 秒を超えました)。`
      + '取得の完了を待ってから再実行してください。'
  }
  if (result.timedOut) return `取得がタイムアウトしました。${NETWORK_HINT}`
  if (result.exitCode === null) {
    return result.signal === null
      ? '取得コマンドを起動できませんでした (理由は stderr を参照)。node_modules を再構築 (pnpm install) してから再実行してください。'
      : `取得コマンドが ${result.signal} で中断されました。取得が外部から打ち切られています。`
  }
  return `取得コマンドが exit ${String(result.exitCode)} で終了しました。${NETWORK_HINT}`
}

/**
chromium を要するツールのハンドラ冒頭で使う実行時ガード (続行可否を ToolResult の有無で返す形)。
続行してよければ undefined、諦めるなら失敗の ToolResult を返す。

`pecotv mcp` は接続タイムアウト (Claude Code の MCP_TIMEOUT は 30000ms が初期値) に収めるため、
起動時に chromium を取得しない。モデルから呼ばれるツールが 120MB のダウンロードを無断で始めないよう、
初期状態では取得せず、`setup` ツールの呼び出しを案内する。
PECOTV_AUTO_INSTALL_BROWSER=1 のときだけ、その場で取得してから処理を続行する。
これは CI・コンテナ・繰り返し使う開発者が、往復を省くための抜け道になる。

取得中も MCP の無音タイムアウトは進まない。progress ハートビートは createMcpServer が
全ツール一律で送っており (src/mcp/server.ts)、ツール側で送出する必要はない。
*/
export async function ensureChromium(
  label: string,
  dependencies: Readonly<ChromiumDependencies> = chromiumDefaultDependencies(),
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal は可変。EventTarget で addEventListener を呼ぶため readonly 化できない
  signal?: AbortSignal,
): Promise<ToolResult | undefined> {
  if (await dependencies.isInstalled()) return undefined

  if (!dependencies.isAutoInstallEnabled()) {
    return {
      ok: false,
      exitCode: CHROMIUM_UNAVAILABLE_EXIT_CODE,
      artifacts: [],
      data: {
        event: 'chromium.unavailable',
        reason: 'chromium-not-installed',
        detail: `${label} は Playwright Chromium を必要としますが、`
          + `${expectedLocation(dependencies)} に見つかりません。`
          + '`setup` ツールを呼ぶと取得できます (約 120MB のダウンロード)。'
          + `取得を自動化する場合は ${AUTO_INSTALL_ENV}=1 を設定してください。`,
        expectedAt: expectedLocation(dependencies),
      },
      message: `Playwright Chromium が未取得のため ${label} を実行できません。\`setup\` ツールを呼んでください`,
    }
  }

  const result = await dependencies.install(signal)
  // 取得コマンドが成功を返しても、実体が置かれたかは改めて確認する
  // (exit 0 でダウンロードを skip した場合を成功と取り違えないため)。
  if (result.exitCode === 0 && await dependencies.isInstalled()) return undefined

  const detail = result.exitCode === 0
    ? `取得コマンドは成功しましたが ${expectedLocation(dependencies)} に chromium がありません。`
    : chromiumInstallFailureDetail(result)
  return {
    ok: false,
    exitCode: CHROMIUM_UNAVAILABLE_EXIT_CODE,
    artifacts: [],
    data: {
      event: 'chromium.unavailable',
      reason: 'chromium-install-failed',
      detail: `${label} のために ${AUTO_INSTALL_ENV}=1 で chromium を取得しようとして失敗しました。${detail}`,
      expectedAt: expectedLocation(dependencies),
    },
    message: `Playwright Chromium の取得に失敗したため ${label} を実行できません`,
    // 失敗原因が stdout 側にあることもある (playwright install は進捗・取得先を stdout へ書く)。
    ...spawnOutputPart(result),
  }
}

/**
実行時依存 (@slidev/cli / dom-to-pptx / @slidev/parser 等) の取得状態を扱う依存。
*/
export interface RuntimeDependencies {
  readonly isInstalled: () => boolean
  /**
  取得先 (永続層) の場所。表示用で、決められないときは undefined。
  */
  readonly root: () => string | undefined
  // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- AbortSignal は可変。EventTarget で addEventListener を呼ぶため readonly 化できない
  readonly install: (signal?: AbortSignal) => Promise<RuntimeInstallResult>
}

export function runtimeDefaultDependencies(): RuntimeDependencies {
  const manifestPath = path.join(resolvePluginRoot(), RUNTIME_MANIFEST_DIRECTORY, 'package.json')
  return {
    // 永続層は版を持たない固定パスなので、解決の可否だけでなく、install 対象の内容から導く
    // stamp も照らし合わせる (前の版で取得したツリーを、取得済みと誤判定させない)。
    isInstalled: () => areRuntimeDependenciesInstalled(runtimeInstallStamp(manifestPath)),
    root: runtimeDependencyRoot,
    install: signal => installRuntimeDependencies({ manifestPath, signal }),
  }
}

/**
実行時依存を要するツールのハンドラ冒頭で使う実行時ガード (ensureChromium と同型)。
続行してよければ undefined、諦めるなら失敗の ToolResult を返す。

slide_create / slide_convert / slide_sync / slide_dev の 4 ツールが引数検証の直後に呼ぶ。
4 つとも依存ルートの実体を要る。create / sync は node_modules の張り直し、convert は pipeline の
実行時解決、dev は @slidev/cli の bin を使う。そこで未取得のときの失敗の型を、1 か所に置いて揃える。

プラグインとして導入した場合、実行時依存は同梱されているため、このガードは常に通る。
単体配布では起動層に重量依存を載せられないため、`setup` を呼ぶまで解決できない。
ensureChromium と違い、自動取得の抜け道は持たない。npm install は 600MB 級で、
モデルから呼ばれるツールが無断で始めてよい規模ではないため、必ず `setup` を経由させる。
*/
export function ensureRuntimeDependencies(
  label: string,
  dependencies: Readonly<RuntimeDependencies> = runtimeDefaultDependencies(),
): ToolResult | undefined {
  if (dependencies.isInstalled()) return undefined

  const expectedAt = dependencies.root() ?? RUNTIME_ROOT_PLACEHOLDER
  return {
    ok: false,
    exitCode: RUNTIME_UNAVAILABLE_EXIT_CODE,
    artifacts: [],
    data: {
      event: 'runtime-dependencies.unavailable',
      reason: 'runtime-dependencies-not-installed',
      detail: `${label} は @slidev/cli / dom-to-pptx / @slidev/parser を必要としますが、解決できません。`
        + DEPENDENCY_RECOVERY_HINT,
      expectedAt,
    },
    message: `実行時依存が未取得のため ${label} を実行できません。\`setup\` ツールを呼んでください`,
  }
}

/**
`file:` 形式のテーマの指定の接頭辞。
*/
const FILE_THEME_PREFIX = 'file:'
const GIT_THEME_PREFIX = 'git+'

export type NormalizedThemeArgument = { readonly ok: true, readonly theme: string } | { readonly ok: false, readonly detail: string }

/**
テーマの指定のパスを、MCP サーバが読める絶対パスにそろえる。

サーバの cwd は利用者の cwd ではない。相対パスは基準を決められないため拒む。
Windows 形式のパスは、他のパス引数と同じく POSIX パスへ変換する。
subject は拒む文言の主語（どの形の指定かを示す）。
*/
function absoluteThemePath(filePath: string, subject: string, original: string): { readonly ok: true, readonly path: string } | { readonly ok: false, readonly detail: string } {
  const conversion = toPosixPath(filePath)
  if (conversion.kind === 'unsupported') {
    return { ok: false, detail: `${subject}のパスを解決できません: ${conversion.reason}` }
  }
  const resolved = conversion.kind === 'converted' ? conversion.path : filePath
  if (!path.isAbsolute(resolved)) {
    return {
      ok: false,
      detail: `${subject}には絶対パスを指定してください（受け取った値: ${original}）。`
        + 'MCP サーバの作業ディレクトリは呼び出し元と異なるため、相対パスは解決できません',
    }
  }
  return { ok: true, path: resolved }
}

/**
MCP の `theme` 引数を、MCP サーバが読める形にそろえる。
`file:` のパスは絶対パスにする。git の指定はそのまま返す。
allowPath を true にすると、`file:` でも `git+` でもない値を talk-dir かテーマ root のパスとして絶対パスにする（drawio_create）。
slide_create はパスを受けないため、その値はそのまま返し、後段の指定の解釈に任せる。
*/
export function normalizeThemeArgument(theme: string, options: Readonly<{ allowPath?: boolean }> = {}): NormalizedThemeArgument {
  if (theme.startsWith(FILE_THEME_PREFIX)) {
    const absolute = absoluteThemePath(theme.slice(FILE_THEME_PREFIX.length), 'theme の file: ', theme)
    return absolute.ok ? { ok: true, theme: `${FILE_THEME_PREFIX}${absolute.path}` } : absolute
  }
  if (options.allowPath !== true || theme.startsWith(GIT_THEME_PREFIX)) return { ok: true, theme }
  const absolute = absoluteThemePath(theme, 'theme ', theme)
  return absolute.ok ? { ok: true, theme: absolute.path } : absolute
}

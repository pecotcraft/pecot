// SSO 認証の 2 段構成（contracts/mcp-tools.md §SSO 認証 / research R5 / FR-007）。
//
// `aws sso login` は認証が終わるまで戻らないため、開始（URL とコードを即時に返す）と
// 完了確認を別のツールに分ける。子プロセスの保持と状態遷移は infra/sso/login-registry.ts が持ち、
// ここは応答の組み立て（ヒント・上限・annotations）だけを持つ。
//
// この 2 件は許可リスト（domain/allowlist.ts）に入れない。許可リストは「awscli を 1 回起動して
// 出力を返す」形のコマンド表で、tests/integration/real-awscli.test.ts が全件を実 awscli へ通す。
// そのため、入れると実行のたびに本物のデバイス認証が発行される。

import { z } from 'zod'

import type { FailureCategory } from '../../domain/allowlist.js'
import { ensureAwscli } from '../../infra/awscli.js'
import {
  loginRegistry as sharedLoginRegistry,
  type LoginRegistry,
  type SsoLoginSession,
} from '../../infra/sso/login-registry.js'
import { limitOutput, toCallToolResult, type ExecutionResult } from '../result.js'
import type { ToolDefinition } from '../server.js'
import {
  PRE_EXECUTION_EXIT_CODE,
  PROFILE_INPUT_SHAPE,
  resolveExitCode,
  TIMEOUT_EXIT_CODE,
  TOOL_OUTPUT_SCHEMA,
  UNKNOWN_FAILURE_EXIT_CODE,
  type ToolOptions,
} from './_shared.js'

/**
SSO 専用の失敗種別ごとの再試行方法。

共通表（_shared.ts の FAILURE_HINTS）は auth-missing / auth-expired で、
「aws_sso_login を実行してください」と案内する。SSO 自身の失敗に使うと、案内が循環する。
*/
const SSO_FAILURE_HINTS: Record<FailureCategory, string> = {
  'not-allowed': '許可されていない操作です。公開しているツールの範囲で実行してください',
  'invalid-input': 'profile を修正して再実行してください',
  'awscli-missing': 'awscli v2 (2.22 以上) を導入して PATH を通してください',
  'auth-missing': 'profile に SSO の設定がありません。端末で aws configure sso を実行してください',
  'auth-expired': 'トークンのキャッシュを読めませんでした。profile の SSO 設定を確認してください',
  'permission-denied': 'SSO の許可セットに対象アカウントが含まれているか確認してください',
  'resource-not-found': 'profile の sso_start_url / sso_region を確認してください',
  'timeout': '制限時間内に認証が完了しませんでした。aws_sso_login を再度呼び出してください',
  'other': 'awscli が失敗しました。stderr を確認してください',
}

/**
出力が上限で切り詰められたときに message へ足す注記。
*/
const OUTPUT_TRUNCATION_NOTE = '（出力は上限を超えたため先頭のみ載せています）'

/**
annotations（判断の根拠は契約書の共通規約）。

`aws_sso_login` は AWS 側に新しいトークンを発行させるので readOnlyHint は false。
`aws_sso_login_status` はレジストリを読むだけなので true。壊す対象を持たないため
destructiveHint は 2 件とも false。openWorldHint は共通規約に合わせて 2 件とも true にする
（status は awscli を起動しないが、返す内容は外界での承認の進み具合に依存する）。
*/
const LOGIN_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
const STATUS_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }

function profileOf(arguments_: Readonly<Record<string, unknown>>): string | undefined {
  const profile = arguments_['profile']
  return typeof profile === 'string' ? profile : undefined
}

/**
応答 data に載せる URL / コード。確定前と、デバイスフローに入らなかった場合は載らない。
*/
function promptData(session: Readonly<SsoLoginSession>): Record<string, unknown> {
  return {
    ...(session.verificationUrl !== undefined && { verificationUrl: session.verificationUrl }),
    ...(session.verificationUrlComplete !== undefined && { verificationUrlComplete: session.verificationUrlComplete }),
    ...(session.userCode !== undefined && { userCode: session.userCode }),
  }
}

/**
pending 応答の案内文。

`promptData` は未確定の項目をキーごと data から落とす。
autofill URL（verificationUrlComplete）が未確定のときに、それを第一候補として案内すると、
応答に無い項目を案内することになる。
autofill 行は URL・コードより後の chunk で届くことがあり、揃うまでの間はこの分岐に入る。
*/
function pendingMessage(session: Readonly<SsoLoginSession>): string {
  return (session.verificationUrlComplete === undefined
    ? 'デバイス認証を開始しました。verificationUrl をブラウザで開き、userCode を入力してください。'
    : 'デバイス認証を開始しました。verificationUrlComplete をブラウザで開けば'
      + 'コード入力は要りません（verificationUrl を開いた場合は userCode を入力します）。')
    + '承認後に aws_sso_login_status で完了を確認してください'
}

function hintOf(category: FailureCategory): string {
  // eslint-disable-next-line security/detect-object-injection -- category は FailureCategory の列挙値
  return SSO_FAILURE_HINTS[category]
}

/**
失敗セッションを ExecutionResult にする。exitCode は必ず 1 以上になる。
*/
function failureResult(
  session: Readonly<SsoLoginSession>,
  data: Readonly<Record<string, unknown>>,
): ExecutionResult {
  /* c8 ignore next -- レジストリは failed に必ず category を付ける。既定値は型を閉じるための防御網 */
  const category = session.category ?? 'other'
  const limited = limitOutput(session.output)
  // awscli の終了コードをそのまま返す（許可リストのツールと同じ規約。SSO 設定なしなら 253）。
  // シグナル終了・未終了は resolveExitCode が 1 へ畳む。0 以下は ok: false と同居させられないので、
  // ここでも 1 にする。
  const resolved = resolveExitCode(category, session.exitCode)

  return {
    ok: false,
    // resolveExitCode は 'timeout' なら 124、'awscli-missing' なら 127、それ以外は session.exitCode（未設定なら 1）を返す。
    // 0 以下にならず、false 分岐は型を閉じるための防御。
    /* c8 ignore next */
    exitCode: resolved > 0 ? resolved : UNKNOWN_FAILURE_EXIT_CODE,
    category,
    data: { ...data },
    artifacts: [],
    message: `SSO 認証が失敗しました (${category})。${hintOf(category)}`
      + (limited.truncated ? OUTPUT_TRUNCATION_NOTE : ''),
    stderr: limited.text,
  }
}

/**
時間切れセッションを ExecutionResult にする。
*/
function timedOutResult(data: Readonly<Record<string, unknown>>): ExecutionResult {
  return {
    ok: false,
    exitCode: TIMEOUT_EXIT_CODE,
    category: 'timeout',
    data: { ...data },
    artifacts: [],
    message: `SSO 認証が時間切れになりました。${hintOf('timeout')}`,
  }
}

async function startLogin(
  arguments_: Readonly<Record<string, unknown>>,
  registry: Readonly<LoginRegistry>,
): Promise<ExecutionResult> {
  // バージョンの判定を先に行う。`--use-device-code` は awscli 2.22 以降にしか無い。
  // 古い awscli では「不正な引数」として失敗し、そのままだと invalid-input になって対処法が伝わらない。
  const probe = await ensureAwscli()
  if (!probe.ok) {
    return {
      ok: false,
      exitCode: resolveExitCode(probe.category),
      category: probe.category,
      data: {},
      artifacts: [],
      message: probe.message,
    }
  }

  const session = await registry.start(profileOf(arguments_))
  const base = { state: session.state, profile: session.profile }

  switch (session.state) {
    case 'pending': {
      return {
        ok: true,
        exitCode: 0,
        data: { ...promptData(session), ...base },
        artifacts: [],
        message: pendingMessage(session),
      }
    }
    case 'completed': {
      return {
        ok: true,
        exitCode: 0,
        data: { ...promptData(session), ...base },
        artifacts: [],
        message: 'デバイス認証を始める前から認証済みでした',
      }
    }
    case 'timed-out': {
      return timedOutResult(base)
    }
    case 'failed': {
      return failureResult(session, base)
    }
  }
}

function loginStatus(
  arguments_: Readonly<Record<string, unknown>>,
  registry: Readonly<LoginRegistry>,
): ExecutionResult {
  const session = registry.get(profileOf(arguments_))
  if (session === undefined) {
    return {
      ok: false,
      exitCode: PRE_EXECUTION_EXIT_CODE,
      category: 'invalid-input',
      data: {},
      artifacts: [],
      message: '開始済みの SSO ログインがありません。aws_sso_login を先に呼んでください',
    }
  }

  const base = { state: session.state }

  switch (session.state) {
    case 'pending': {
      return {
        ok: true,
        exitCode: 0,
        data: { ...promptData(session), ...base },
        artifacts: [],
        message: 'まだ承認されていません。案内した URL での承認後に再度呼び出してください',
      }
    }
    case 'completed': {
      const limited = limitOutput(session.output)
      return {
        ok: true,
        exitCode: 0,
        data: { ...promptData(session), ...base, output: limited.text },
        artifacts: [],
        message: 'SSO 認証が完了しました'
          + (limited.truncated ? OUTPUT_TRUNCATION_NOTE : ''),
      }
    }
    case 'timed-out': {
      return timedOutResult(base)
    }
    case 'failed': {
      return failureResult(session, base)
    }
  }
}

/**
SSO の 2 件を組み立てる。

ハンドラは ToolCallContext（signal）を使わない。tools/call のキャンセルで子を落とすと、
「開始だけして後で確認する」という 2 段構成の趣旨に反する。
クライアントの接続断は serve.ts の stdin end の処理が子を片付けるため、孤児は残らない。
*/
export function ssoTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  // 既定の解決はここで済ませる。ハンドラ内で遅延解決すると、テストが注入したレジストリと
  // 共有インスタンスのどちらを見るかが呼び出し時まで決まらない。
  const registry = options.loginRegistry ?? sharedLoginRegistry()

  return [
    {
      name: 'aws_sso_login',
      config: {
        title: 'SSO ログインの開始',
        description: 'AWS SSO のデバイス認証を開始し、認証 URL とコードを即時に返す。完了は待たないため、'
          + '利用者の承認後に aws_sso_login_status で確認する',
        inputSchema: z.object({ ...PROFILE_INPUT_SHAPE }),
        outputSchema: TOOL_OUTPUT_SCHEMA,
        annotations: LOGIN_ANNOTATIONS,
      },
      handler: async (arguments_: Readonly<Record<string, unknown>>) =>
        toCallToolResult(await startLogin(arguments_, registry)),
    },
    {
      name: 'aws_sso_login_status',
      config: {
        title: 'SSO ログインの完了確認',
        description: 'aws_sso_login で開始した認証の状態（pending / completed / failed / timed-out）を返す。'
          + 'awscli は起動しない',
        inputSchema: z.object({ ...PROFILE_INPUT_SHAPE }),
        outputSchema: TOOL_OUTPUT_SCHEMA,
        annotations: STATUS_ANNOTATIONS,
      },
      handler: (arguments_: Readonly<Record<string, unknown>>) =>
        Promise.resolve(toCallToolResult(loginStatus(arguments_, registry))),
    },
  ]
}

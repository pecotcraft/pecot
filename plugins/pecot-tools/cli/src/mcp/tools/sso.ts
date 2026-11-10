// SSO 認証の 2 段構成（contracts/mcp-tools.md §SSO 認証 / research R5）。開始と完了確認を別ツールに分け、子の保持は login-registry.ts が持つ。
// 許可リストに入れない。実 awscli テストが全件を通すため、入れると実行のたびに本物のデバイス認証が発行される。

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
SSO 専用の失敗種別ごとの再試行方法。共通表は「aws_sso_login を実行」と案内するので、SSO 自身の失敗に使うと循環する。
*/
const SSO_FAILURE_HINTS: Record<FailureCategory, string> = {
  'not-allowed': 'Operation not allowed. Use only the exposed tools',
  'invalid-input': 'Fix the profile and run again',
  'awscli-missing': 'Install awscli v2 (2.22 or later) and add it to PATH',
  'auth-missing': 'The profile has no SSO configuration. Run aws configure sso in a terminal',
  'auth-expired': 'Could not read the token cache. Check the SSO settings of the profile',
  'permission-denied': 'Check that the SSO permission set includes the target account',
  'resource-not-found': 'Check sso_start_url / sso_region of the profile',
  'timeout': 'Authentication did not complete within the time limit. Call aws_sso_login again',
  'other': 'awscli failed. Check stderr',
}

/**
出力が上限で切り詰められたときに message へ足す注記。
*/
const OUTPUT_TRUNCATION_NOTE = '(Output exceeded the limit, so only the beginning is included)'

/**
annotations。status は awscli を起動しないが、返す内容は外界の承認の進み具合に依存するので openWorldHint は 2 件とも true。
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
pending 応答の案内文。autofill URL は後の chunk で届くことがあり、未確定の間は応答に無い項目を案内しない。
*/
function pendingMessage(session: Readonly<SsoLoginSession>): string {
  return (session.verificationUrlComplete === undefined
    ? 'Device authorization started. Open verificationUrl in a browser and enter userCode. '
    : 'Device authorization started. Open verificationUrlComplete in a browser; '
      + 'no code entry is needed (if you open verificationUrl, enter userCode). ')
    + 'After approval, check completion with aws_sso_login_status.'
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
  // awscli の終了コードをそのまま返す（SSO 設定なしなら 253）。ok: false と同居できないので、0 以下とシグナル終了は 1 にする。
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
    message: `SSO authentication failed (${category}). ${hintOf(category)}`
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
    message: `SSO authentication timed out. ${hintOf('timeout')}`,
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
        message: 'Already authenticated before device authorization started',
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
      message: 'No SSO login in progress. Call aws_sso_login first',
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
        message: 'Not approved yet. Approve at the given URL, then call again',
      }
    }
    case 'completed': {
      const limited = limitOutput(session.output)
      return {
        ok: true,
        exitCode: 0,
        data: { ...promptData(session), ...base, output: limited.text },
        artifacts: [],
        message: 'SSO authentication completed'
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
SSO の 2 件を組み立てる。signal を使わないのは、キャンセルで子を落とすと 2 段構成の趣旨に反するため（接続断は serve.ts が片付ける）。
*/
export function ssoTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  // 既定の解決はここで済ませる。ハンドラ内で遅延解決すると、テストが注入したレジストリと
  // 共有インスタンスのどちらを見るかが呼び出し時まで決まらない。
  const registry = options.loginRegistry ?? sharedLoginRegistry()

  return [
    {
      name: 'aws_sso_login',
      config: {
        title: 'Start SSO login',
        description: 'Starts AWS SSO device authorization and returns the verification URL and code immediately. It does not wait for completion, so '
          + 'check with aws_sso_login_status after the user approves',
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
        title: 'Check SSO login status',
        description: 'Returns the state (pending / completed / failed / timed-out) of the authorization started by aws_sso_login. '
          + 'Does not run awscli',
        inputSchema: z.object({ ...PROFILE_INPUT_SHAPE }),
        outputSchema: TOOL_OUTPUT_SCHEMA,
        annotations: STATUS_ANNOTATIONS,
      },
      handler: (arguments_: Readonly<Record<string, unknown>>) =>
        Promise.resolve(toCallToolResult(loginStatus(arguments_, registry))),
    },
  ]
}

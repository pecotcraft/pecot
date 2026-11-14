// awscli の失敗理由の種別判定（FR-009 / research R4）。
//
// awscli はエラーを構造化して返さないため、終了コードと stderr の文字列比較が唯一の手段になる。
// 比較表は research R4 の表を元にしている。
// awscli 2.36.40 の実採取（2026-09-07）で確認した文言を優先して直している。
// 例えば `Found invalid choice` は、R4 の `Invalid choice` と大小文字が異なる。
// AccessDenied / ResourceNotFound 系は実アカウントを使っていないため R4 転記のまま。

import type { FailureKind } from './allowlist.js'

/**
awscli v2 の「構文不正」終了コード。
*/
const SYNTAX_ERROR_EXIT_CODE = 252

/**
判定の材料。runAwscli の SpawnResult から組み立てる。
*/
export interface FailureSignals {
  readonly exitCode: number | null
  readonly stderr: string
  readonly timedOut: boolean
  /**
  spawn 自体が失敗したときの errno（ENOENT 等）。
  */
  readonly spawnErrorCode?: string
}

interface StderrRule {
  readonly kind: FailureKind
  /**
  部分一致で比較する断片。
  */
  readonly fragments: readonly string[]
  /**
  可変部を含む文言のための正規表現。
  */
  readonly patterns?: readonly Readonly<RegExp>[]
}

/**
stderr の比較表。上から順に見るため、並びがそのまま優先順になる。

auth-expired を auth-missing より先に置くのは、期限切れの stderr に「認証情報が無い」系の
文言を併記する場合があるため。
permission-denied は resource-not-found より先に置く。権限不足を「対象が無い」と誤って伝えないため。
*/
const STDERR_RULES: readonly StderrRule[] = [
  {
    kind: 'auth-expired',
    fragments: [
      'Error loading SSO Token',
      'The SSO session associated with this profile has expired',
      'ExpiredToken',
      'InvalidClientTokenId',
      'Token has expired',
    ],
  },
  {
    kind: 'auth-missing',
    fragments: [
      'Unable to locate credentials',
      'Missing the following required SSO configuration',
    ],
    // R4 の `The config profile (<name>) could not be found`。
    // `could not be found` の断片だけでは、リソース不在の stderr も auth-missing になる。
    // 例は `The specified log group could not be found`。
    // aws_sso_login を促す誤案内になるので、文全体で比較する。
    patterns: [/The config profile \(.+\) could not be found/],
  },
  {
    kind: 'permission-denied',
    fragments: [
      'AccessDenied',
      'AccessDeniedException',
      'UnauthorizedOperation',
      'not authorized to perform',
    ],
  },
  {
    kind: 'resource-not-found',
    fragments: [
      'ResourceNotFoundException',
      'NoSuchBucket',
      'NoSuchKey',
      'QueueDoesNotExist',
      'AWS.SimpleQueueService.NonExistentQueue',
      '(404)',
    ],
  },
  {
    kind: 'invalid-input',
    fragments: [
      'Unknown options',
      // 実採取は `argument operation: Found invalid choice 'bogus-op'`。R4 転記の
      // `Invalid choice` は大小文字が違って掛からないため、両方を並べる。
      'Found invalid choice',
      'Invalid choice',
      'the following arguments are required:',
    ],
    // R4 の `argument ... is required`（v1 語法）。オプション名が可変なので正規表現で見る。
    patterns: [/argument .+ is required/],
  },
]

function doesMatch(rule: Readonly<StderrRule>, stderr: string): boolean {
  return rule.fragments.some(fragment => stderr.includes(fragment)) || (rule.patterns ?? []).some(pattern => pattern.test(stderr))
}

/**
失敗の種別を決める。

順は ENOENT → 時間切れ → 終了コード 252 → stderr 比較 → other。
ENOENT を最優先にするのは、awscli 未導入では stderr に何が出ていても打つ手が
「awscli を入れる」しかないため。
*/
export function classifyFailure(signals: Readonly<FailureSignals>): FailureKind {
  if (signals.spawnErrorCode === 'ENOENT') return 'awscli-missing'
  if (signals.timedOut) return 'timeout'
  if (signals.exitCode === SYNTAX_ERROR_EXIT_CODE) return 'invalid-input'

  for (const rule of STDERR_RULES) {
    if (doesMatch(rule, signals.stderr)) return rule.kind
  }
  return 'other'
}

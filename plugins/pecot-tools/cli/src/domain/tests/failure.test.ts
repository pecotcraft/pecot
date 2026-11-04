/* eslint-disable unicorn/no-null -- exitCode は SpawnResult 契約で null（spawn 失敗・シグナル終了）を取る */
import { describe, expect, it } from 'vitest'

import type { FailureCategory } from '../allowlist.js'
import { classifyFailure, type FailureSignals } from '../failure.js'

/**
実 awscli から採取した失敗の signals。

出典: awscli 2.36.40（Python/3.14.6 Linux/7.0.0-30-generic）の出力。
2026-09-07 に `env -i` + 隔離 HOME + `AWS_EC2_METADATA_DISABLED=true` で実行した。
stderr は先頭の空行と `aws: [ERROR]: ` 接頭辞まで実出力どおりに写している
（判定に影響しない usage バナーだけ省いた）。
*/
interface CapturedFailure {
  readonly label: string
  readonly exitCode: number
  readonly stderr: string
  readonly expected: FailureCategory
}

const CAPTURED_FAILURES: readonly CapturedFailure[] = [
  {
    label: 'lambda get-function-configuration（必須オプション未指定）',
    exitCode: 252,
    stderr: '\naws: [ERROR]: An error occurred (ParamValidation): '
      + 'the following arguments are required: --function-name\n',
    expected: 'invalid-input',
  },
  {
    label: 'lambda bogus-op（存在しないサブコマンド）',
    exitCode: 252,
    stderr: '\naws: [ERROR]: An error occurred (ParamValidation): '
      + 'argument operation: Found invalid choice \'bogus-op\'\n',
    expected: 'invalid-input',
  },
  {
    label: 'lambda list-functions --bogus（未知のオプション）',
    exitCode: 252,
    stderr: '\naws: [ERROR]: Unknown options: --bogus\n',
    expected: 'invalid-input',
  },
  {
    label: 'sts get-caller-identity（資格情報なし）',
    exitCode: 253,
    stderr: '\naws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials. '
      + 'You can configure credentials by running "aws login".\n',
    expected: 'auth-missing',
  },
  {
    label: 's3 cp（資格情報なし。高レベルコマンドは終了コード規約が違う）',
    exitCode: 1,
    stderr: 'fatal error: Unable to locate credentials\n',
    expected: 'auth-missing',
  },
  {
    label: '--profile nosuch（プロファイル不在）',
    exitCode: 255,
    stderr: '\naws: [ERROR]: The config profile (nosuch) could not be found\n',
    expected: 'auth-missing',
  },
  {
    label: 'SSO プロファイル（トークン未取得）',
    exitCode: 255,
    stderr: '\naws: [ERROR]: Error loading SSO Token: Token for mysso does not exist\n',
    expected: 'auth-expired',
  },
  {
    label: 'SSO プロファイル（トークン期限切れ）',
    exitCode: 255,
    stderr: '\naws: [ERROR]: Error when retrieving token from sso: '
      + 'Token has expired and refresh failed\n',
    expected: 'auth-expired',
  },
  {
    label: 'sts get-caller-identity（実 STS へ無効なキー）',
    exitCode: 254,
    stderr: '\naws: [ERROR]: An error occurred (InvalidClientTokenId) when calling the '
      + 'GetCallerIdentity operation: The security token included in the request is invalid.\n',
    expected: 'auth-expired',
  },
]

function signals(overrides: Partial<FailureSignals> = {}): FailureSignals {
  return { exitCode: 254, stderr: '', timedOut: false, ...overrides }
}

describe('classifyFailure', () => {
  it('spawn の ENOENT を awscli-missing にする', () => {
    expect(classifyFailure(signals({ exitCode: null, spawnErrorCode: 'ENOENT' }))).toBe('awscli-missing')
  })

  it('時間切れを timeout にする', () => {
    expect(classifyFailure(signals({ exitCode: null, timedOut: true }))).toBe('timeout')
  })

  it('終了コード 252 を invalid-input にする', () => {
    expect(classifyFailure(signals({ exitCode: 252 }))).toBe('invalid-input')
  })

  // research R4 の表からの転記（実 awscli の採取ではない）。実出力での判定は
  // 「実採取した awscli の失敗」の describe を見る。
  it.each([
    ['Error loading SSO Token: ...', 'auth-expired'],
    ['The SSO session associated with this profile has expired.', 'auth-expired'],
    ['An error occurred (ExpiredToken) when calling the ListFunctions operation', 'auth-expired'],
    ['An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation', 'auth-expired'],
    ['The security token included in the request is expired: Token has expired', 'auth-expired'],
    ['Unable to locate credentials. You can configure credentials by running "aws configure".', 'auth-missing'],
    ['The config profile (dev) could not be found', 'auth-missing'],
    ['Missing the following required SSO configuration values: sso_start_url', 'auth-missing'],
    ['An error occurred (AccessDenied) when calling the ListObjectsV2 operation', 'permission-denied'],
    ['An error occurred (AccessDeniedException) when calling the FilterLogEvents operation', 'permission-denied'],
    ['An error occurred (UnauthorizedOperation) when calling the DescribeInstances operation', 'permission-denied'],
    ['is not authorized to perform: lambda:ListFunctions', 'permission-denied'],
    ['An error occurred (ResourceNotFoundException) when calling the GetFunctionConfiguration operation', 'resource-not-found'],
    ['An error occurred (NoSuchBucket) when calling the ListObjectsV2 operation', 'resource-not-found'],
    ['An error occurred (NoSuchKey) when calling the GetObject operation', 'resource-not-found'],
    ['An error occurred (QueueDoesNotExist) when calling the GetQueueAttributes operation', 'resource-not-found'],
    ['An error occurred (AWS.SimpleQueueService.NonExistentQueue) when calling the GetQueueUrl operation', 'resource-not-found'],
    ['An error occurred (404) when calling the HeadObject operation: Not Found', 'resource-not-found'],
    [
      'An error occurred (ResourceNotFoundException) when calling the FilterLogEvents operation: '
      + 'The specified log group could not be found',
      'resource-not-found',
    ],
    ['Unknown options: --recursive', 'invalid-input'],
    ['Invalid choice: \'list-function\', maybe you meant: list-functions', 'invalid-input'],
    ['aws: error: the following arguments are required: --function-name', 'invalid-input'],
    ['aws: error: argument --function-name is required', 'invalid-input'],
    ['An error occurred (ThrottlingException) when calling the ListFunctions operation', 'other'],
  ])('stderr %j を %s と判定する', (stderr, expected) => {
    expect(classifyFailure(signals({ stderr }))).toBe(expected)
  })

  it('ENOENT は stderr の内容より優先する', () => {
    // awscli 未導入なら、stderr に何が出ていても打つ手は「awscli を入れる」しかない。
    expect(classifyFailure(signals({
      exitCode: null,
      spawnErrorCode: 'ENOENT',
      stderr: 'An error occurred (AccessDenied) when calling the ListFunctions operation',
    }))).toBe('awscli-missing')
  })

  it('auth-expired は permission-denied より優先する', () => {
    expect(classifyFailure(signals({
      stderr: 'An error occurred (ExpiredToken) ... An error occurred (AccessDenied) ...',
    }))).toBe('auth-expired')
  })

  it('どれにも当てはまらない失敗は other にする', () => {
    expect(classifyFailure(signals({ exitCode: 1, stderr: '' }))).toBe('other')
  })
})

describe('実採取した awscli の失敗', () => {
  it.each(CAPTURED_FAILURES)('$label を $expected と判定する', (captured) => {
    expect(classifyFailure(signals({ exitCode: captured.exitCode, stderr: captured.stderr })))
      .toBe(captured.expected)
  })

  it('構文不正の stderr は終了コード 252 以外で届いても invalid-input にする', () => {
    // 実採取の構文不正は 252 で先に確定するため、stderr 断片 `Found invalid choice` が
    // 使われるのは終了コードが違う場合だけになる。R4 転記の `Invalid choice` とは大小文字が違い、
    // 断片を足していないとここで other になる。
    expect(classifyFailure(signals({
      exitCode: 1,
      stderr: '\naws: [ERROR]: An error occurred (ParamValidation): '
        + 'argument operation: Found invalid choice \'bogus-op\'\n',
    }))).toBe('invalid-input')
  })
})

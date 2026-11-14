// 実 awscli を PATH に持つ環境でだけ実行する統合テスト。
//
// 単体テストは偽 awscli（tests/_fixtures/fake-aws）を使う。
// そのため fixture の文言が実物とずれても緑のままになる。
// ここは実 awscli を起動して runAwscli / ensureAwscli / classifyFailure を通す。
// 終了コードと stderr の実文言に対して、種別判定が成立することを確かめる。
//
// 実行条件は採取時（awscli 2.36.40 / 2026-09-07）と揃える。HOME と config / credentials の
// パスを空の一時ディレクトリへ向け、AWS_* を全て落とし、IMDS を無効にする。これで
// 実行環境の資格情報・プロファイル・SSO キャッシュのいずれにも到達しない。
//
// ネットワークへ出るケース（実 STS 呼び出し等）は入れない。ここに並ぶ 4 つの失敗は
// いずれも awscli がリクエスト送信前にローカルで確定させるものだけにしてある。

/* eslint-disable security/detect-non-literal-fs-filename -- 扱うのは PATH の要素と mkdtemp の戻り値のみ */

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FailureKind } from '../../src/domain/allowlist.js'
import { ALLOWLIST, findAllowlistEntry } from '../../src/domain/allowlist.js'
import { buildArguments } from '../../src/domain/arguments.js'
import { classifyFailure } from '../../src/domain/failure.js'
import type { SpawnResult } from '../../src/infra/awscli.js'
import { ensureAwscli, resetAwscliProbe, runAwscli } from '../../src/infra/awscli.js'

/**
実 awscli の待ち時間。資格情報の解決だけで終わるので短くてよい。
*/
const AWSCLI_TIMEOUT_MS = 30_000

/**
引数の受理を見るためのリージョン。未指定だと NoRegion で別の失敗になる。
*/
const REGION = 'ap-northeast-1'

/**
awscli v2 の「構文不正」終了コード。引数並びが受理されればここには落ちない。
*/
const SYNTAX_ERROR_EXIT_CODE = 252

/**
PATH 上の `aws` を探す（`which aws` 相当）。無ければ undefined。
*/
function findAwscli(): string | undefined {
  const pathEntries = (process.env['PATH'] ?? '').split(path.delimiter)
  for (const entry of pathEntries) {
    if (entry === '') continue
    const candidate = path.join(entry, 'aws')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
awscli の有無。import 時ではなく beforeAll で判定する。

import 時に決めると、収集後・実行前に awscli が PATH から消えた場合、skip ではなく fail になる。
*/
const awscli: { path: string | undefined } = { path: undefined }

/**
awscli が無い環境ではそのケースを skip する（it の第 1 引数の TestContext を使う）。
*/
function skipWithoutAwscli(context: Readonly<{ skip: () => void }>): void {
  if (awscli.path === undefined) context.skip()
}

/**
SpawnResult を FailureSignals へ移して種別を得る（executeAllowlisted と同じ組み立て）。
*/
function categorize(result: Readonly<SpawnResult>): FailureKind {
  return classifyFailure({
    exitCode: result.exitCode,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ...(result.spawnErrorCode !== undefined && { spawnErrorCode: result.spawnErrorCode }),
  })
}

const isolatedHome = useTemporaryDirectory('pecot-tools-real-aws-')

/**
書き出し先を持つツールが実際にファイルを作らないことを見るためのパス。
*/
function outputPath(name: string): string {
  return isolatedHome(name)
}

/**
24 ツールぶんの代表引数。任意入力も含め、契約で公開している引数の並びを実 awscli に通す。

値は実在しない名前でよい。ここで見たいのは「構文として受理されるか」だけで、
資格情報が無い以上リクエストは送られない。
*/
function representativeArguments(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return {
    aws_sts_get_caller_identity: {},
    aws_lambda_list_functions: { max_items: 1, starting_token: 'token-1' },
    aws_lambda_get_function_configuration: { function_name: 'no-such-function', qualifier: '1' },
    aws_lambda_list_event_source_mappings: {
      event_source_arn: 'arn:aws:sqs:ap-northeast-1:123456789012:no-such-queue',
      function_name: 'no-such-function',
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_logs_describe_log_groups: {
      log_group_name_prefix: '/aws/lambda/',
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_logs_describe_log_streams: {
      log_group_name: 'no-such-group',
      log_stream_name_prefix: '2026/09',
      order_by: 'LastEventTime',
      descending: true,
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_logs_get_log_events: {
      log_group_name: 'no-such-group',
      log_stream_name: 'no-such-stream',
      start_time: 1_756_684_800_000,
      end_time: 1_756_688_400_000,
      limit: 1,
      next_token: 'f/00000000000000000000000000000000000000000000000000000000',
      start_from_head: true,
    },
    aws_logs_filter_log_events: {
      log_group_name: 'no-such-group',
      log_stream_names: ['a', 'b'],
      filter_pattern: 'ERROR',
      start_time: 1_756_684_800_000,
      end_time: 1_756_688_400_000,
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_cloudwatch_get_metric_statistics: {
      namespace: 'AWS/SQS',
      metric_name: 'NumberOfMessagesSent',
      dimensions: [{ name: 'QueueName', value: 'no-such-queue' }],
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-01T01:00:00Z',
      period: 300,
      statistics: ['Sum', 'Average'],
      unit: 'Count',
    },
    aws_sqs_list_queues: { queue_name_prefix: 'no-such', max_items: 1, starting_token: 'token-1' },
    aws_sqs_get_queue_attributes: {
      queue_url: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/no-such-queue',
      attribute_names: ['All'],
    },
    aws_athena_start_query_execution: {
      query_string: 'SELECT 1',
      work_group: 'primary',
      database: 'analytics',
      catalog: 'awsdatacatalog',
      output_location: 's3://no-such-bucket/results/',
    },
    aws_athena_get_query_execution: { query_execution_id: 'b1c2d3e4' },
    aws_athena_get_query_results: {
      query_execution_id: 'b1c2d3e4',
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_s3_ls: { s3_uri: 's3://no-such-bucket/prefix/' },
    aws_s3_cp: { s3_uri: 's3://no-such-bucket/report.json', local_path: outputPath('cp.json') },
    aws_s3api_get_object: {
      bucket: 'no-such-bucket',
      key: 'report.json',
      outfile: outputPath('get-object.json'),
      version_id: '3sL4kqtJ',
      range: 'bytes=0-1023',
    },
    aws_rds_describe_events: {
      // duration は start_time / end_time と排他なので、期間指定の側だけを通す。
      source_identifier: 'no-such-instance',
      source_type: 'db-instance',
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-01T01:00:00Z',
      event_categories: ['availability'],
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_rds_describe_db_clusters: {
      db_cluster_identifier: 'no-such-cluster',
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_rds_describe_db_instances: {
      db_instance_identifier: 'no-such-instance',
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_scheduler_list_schedules: {
      group_name: 'default',
      name_prefix: 'no-such',
      state: 'ENABLED',
      max_items: 1,
      starting_token: 'token-1',
    },
    aws_scheduler_get_schedule: { name: 'no-such-schedule', group_name: 'default' },
    aws_ecr_describe_images: {
      // image_ids は starting_token と排他（ECR の API が nextToken を受け付けない）。
      repository_name: 'no-such-repository',
      registry_id: '123456789012',
      image_ids: [{ image_tag: 'latest' }],
      tag_status: 'TAGGED',
      max_items: 1,
    },
    aws_ec2_describe_instances: {
      instance_ids: ['i-0a1b2c3d4e5f60718'],
      filters: [{ name: 'instance-state-name', values: ['running', 'stopped'] }],
      max_items: 1,
      starting_token: 'token-1',
    },
  }
}

/**
書き出し先を持つツールと、その入力名。
*/
const OUTPUT_TOOLS: readonly { readonly name: string, readonly input: string }[] = [
  { name: 'aws_s3_cp', input: 'local_path' },
  { name: 'aws_s3api_get_object', input: 'outfile' },
]

describe('実 awscli', () => {
  beforeAll(() => {
    awscli.path = findAwscli()
  })

  beforeEach(() => {
    resetAwscliProbe()

    // 先に AWS_* を全て落としてから、このテストが使う分だけ置き直す。
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('AWS_')) vi.stubEnv(name, undefined)
    }

    vi.stubEnv('HOME', isolatedHome())
    vi.stubEnv('AWS_CONFIG_FILE', isolatedHome('config'))
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', isolatedHome('credentials'))
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(isolatedHome(), { recursive: true, force: true })
  })

  it('ensureAwscli が実 awscli の版を ok で返す', async (context) => {
    skipWithoutAwscli(context)

    const probe = await ensureAwscli()

    expect(probe).toMatchObject({ ok: true })
    expect(probe.ok ? probe.version : '').toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('必須オプションを欠いた呼び出しを exit 252 の invalid-input にする', async (context) => {
    skipWithoutAwscli(context)

    const result = await runAwscli(
      ['lambda', 'get-function-configuration', '--output', 'json', '--no-cli-pager'],
      { timeoutMs: AWSCLI_TIMEOUT_MS },
    )

    expect(result.exitCode).toBe(252)
    expect(result.stderr).toContain('the following arguments are required: --function-name')
    expect(categorize(result)).toBe('invalid-input')
  })

  it('資格情報が無い呼び出しを exit 253 の auth-missing にする', async (context) => {
    skipWithoutAwscli(context)

    const result = await runAwscli(
      ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager'],
      { timeoutMs: AWSCLI_TIMEOUT_MS },
    )

    expect(result.exitCode).toBe(253)
    expect(result.stderr).toContain('Unable to locate credentials')
    expect(categorize(result)).toBe('auth-missing')
  })

  it('存在しないプロファイル指定を exit 255 の auth-missing にする', async (context) => {
    skipWithoutAwscli(context)

    const result = await runAwscli(
      ['sts', 'get-caller-identity', '--output', 'json', '--no-cli-pager', '--profile', 'nosuch'],
      { timeoutMs: AWSCLI_TIMEOUT_MS },
    )

    expect(result.exitCode).toBe(255)
    expect(result.stderr).toContain('The config profile (nosuch) could not be found')
    expect(categorize(result)).toBe('auth-missing')
  })

  it('logs describe-log-streams の並び替え・ページング指定を構文エラーにしない', async (context) => {
    skipWithoutAwscli(context)

    // 許可リストが組み立てる引数の並び（フラグ + 共通オプション）を実 awscli が受け取るか。
    // 構文が通らなければ 252 で止まり、資格情報の解決（253）まで進まない。
    const result = await runAwscli(
      [
        'logs', 'describe-log-streams',
        '--log-group-name', 'g',
        '--no-descending',
        '--max-items', '1',
        '--output', 'json',
        '--no-cli-pager',
        '--region', REGION,
      ],
      { timeoutMs: AWSCLI_TIMEOUT_MS },
    )

    expect(result.exitCode).not.toBe(SYNTAX_ERROR_EXIT_CODE)
    expect(result.exitCode).toBe(253)
    expect(categorize(result)).toBe('auth-missing')
  })

  it('`-` で始まる値の --flag=value 形を構文エラーにしない', async (context) => {
    skipWithoutAwscli(context)

    // CloudWatch Logs の除外パターン。`--filter-pattern -INFO` は 252 になるが、
    // `--filter-pattern=-INFO` は受理されて資格情報の解決（253）まで進む。
    const result = await runAwscli(
      [
        'logs', 'filter-log-events',
        '--log-group-name', 'no-such-group',
        '--filter-pattern=-INFO',
        '--output', 'json',
        '--no-cli-pager',
        '--region', REGION,
      ],
      { timeoutMs: AWSCLI_TIMEOUT_MS },
    )

    expect(result.exitCode, `stderr: ${result.stderr}`).not.toBe(SYNTAX_ERROR_EXIT_CODE)
    expect(categorize(result), `stderr: ${result.stderr}`).toBe('auth-missing')
  })

  it('代表引数の表が許可リストと 1:1 で対応する', () => {
    expect(Object.keys(representativeArguments()).toSorted(compareStrings))
      .toEqual(ALLOWLIST.map(entry => entry.toolName).toSorted(compareStrings))
  })

  // it.each のコールバックには TestContext が渡らない（vitest 4 で確認）。skip を呼ぶには
  // 各ケースを独立した it として登録する必要があるため、ループで展開する。
  const toolNames = ALLOWLIST.map(entry => entry.toolName)
  for (const toolName of toolNames) {
    it(`${toolName} の引数並びを実 awscli が構文として受理する`, async (context) => {
      skipWithoutAwscli(context)

      // 終了コードは 253（低レベル API）と 1（高レベル s3 コマンド）が混在する。値では固定せず、
      // 「構文不正の 252 ではない」ことだけを見る。252 で止まるなら引数解析まで到達していない。
      const entry = findAllowlistEntry(toolName)
      if (entry === undefined) throw new Error(`許可リストに ${toolName} がありません`)
      // eslint-disable-next-line security/detect-object-injection -- toolName は ALLOWLIST 由来
      const input = representativeArguments()[toolName] ?? {}

      const result = await runAwscli(
        buildArguments(entry, input, { region: REGION }),
        { timeoutMs: AWSCLI_TIMEOUT_MS },
      )

      expect(result.exitCode, `stderr: ${result.stderr}`).not.toBe(SYNTAX_ERROR_EXIT_CODE)
      expect(categorize(result), `stderr: ${result.stderr}`).not.toBe('invalid-input')
    })
  }

  for (const target of OUTPUT_TOOLS) {
    it(`${target.name} は認証に失敗した時点で書き出し先を作らない`, async (context) => {
      skipWithoutAwscli(context)

      const entry = findAllowlistEntry(target.name)
      if (entry === undefined) throw new Error(`許可リストに ${target.name} がありません`)

      const input = representativeArguments()[target.name] ?? {}

      const destination = String(input[target.input])

      const result = await runAwscli(
        buildArguments(entry, input, { region: REGION }),
        { timeoutMs: AWSCLI_TIMEOUT_MS },
      )

      expect(result.exitCode).not.toBe(0)
      expect(existsSync(destination), `${destination} が作られた`).toBe(false)
    })
  }
})

import { useTemporaryDirectory } from '../_helpers/temporary-directory.js'
import { compareStrings } from '../_helpers/compare-strings.js'

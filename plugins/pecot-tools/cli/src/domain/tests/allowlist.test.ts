import { describe, expect, it } from 'vitest'

import {
  ALLOWLIST,
  findAllowlistEntry,
  PROFILE_INPUT,
  REGION_INPUT,
  type AllowlistEntry,
} from '../allowlist.js'
import { explains } from '../../../tests/_helpers/explains.js'

const ENTRY: AllowlistEntry = {
  toolName: 'aws_sts_get_caller_identity',
  service: 'sts',
  subcommand: 'get-caller-identity',
  kind: 'read',
  jsonOutput: true,
  pagination: 'none',
  inputs: [],
}

/**
contracts/mcp-tools.md の表のうち、awscli コマンドを包む 22 件を表の順で並べたもの。

契約表の先頭にある SSO の 2 件は許可リストに入れない。
awscli を 1 回起動して出力を返す形ではなく、tests/integration/real-awscli.test.ts が全件を実 awscli へ通すため。
tools/list の並びは「SSO 2 件 + この 24 件」になる。
*/
const CONTRACT_ORDER: readonly string[] = [
  'aws_sts_get_caller_identity',
  'aws_lambda_list_functions',
  'aws_lambda_get_function_configuration',
  'aws_lambda_list_event_source_mappings',
  'aws_logs_describe_log_groups',
  'aws_logs_describe_log_streams',
  'aws_logs_get_log_events',
  'aws_logs_filter_log_events',
  'aws_cloudwatch_get_metric_statistics',
  'aws_sqs_list_queues',
  'aws_sqs_get_queue_attributes',
  'aws_athena_start_query_execution',
  'aws_athena_get_query_execution',
  'aws_athena_get_query_results',
  'aws_s3_ls',
  'aws_rds_describe_events',
  'aws_rds_describe_db_clusters',
  'aws_rds_describe_db_instances',
  'aws_scheduler_list_schedules',
  'aws_scheduler_get_schedule',
  'aws_ecr_describe_images',
  'aws_ec2_describe_instances',
]

describe('findAllowlistEntry', () => {
  it('許可リストとして渡したエントリを、ツール名で検索できる', async () => {
    await explains('許可リストからツール名でエントリを検索する `findAllowlistEntry` のテストです。第 2 引数としてエントリの一覧を渡した場合は、`aws_sts_get_caller_identity` のエントリが返されることを確認します。')
    expect(findAllowlistEntry('aws_sts_get_caller_identity', [ENTRY])).toBe(ENTRY)
  })

  it('渡した許可リストに存在しないツール名を検索すると、undefined を返す', async () => {
    await explains('許可リストからツール名でエントリを検索する `findAllowlistEntry` のテストです。渡したエントリの一覧に存在しないツール名を指定した場合に、`undefined` を返すことを確認します。')
    expect(findAllowlistEntry('aws_lambda_list_functions', [ENTRY])).toBeUndefined()
  })

  it('ツール名だけを渡して検索すると、組み込みの許可リスト ALLOWLIST から検索する', async () => {
    await explains('許可リストからツール名でエントリを検索する `findAllowlistEntry` のテストです。ツール名だけを渡した場合に、`aws_sts_get_caller_identity` のエントリが返り、存在しない `aws_sso_login` では `undefined` が返ることを確認します。')
    expect(findAllowlistEntry('aws_sts_get_caller_identity')?.service).toBe('sts')
    expect(findAllowlistEntry('aws_sso_login')).toBeUndefined()
  })
})

describe('ALLOWLIST', () => {
  it('ALLOWLIST は、awscli コマンドの 24 件を契約表の順に並べ、SSO のツールを含めない', async () => {
    await explains('許可するツールの一覧 `ALLOWLIST` のテストです。ツール名の並びが、契約表（`contracts/mcp-tools.md`）の awscli コマンドの 24 件と同じ順序で一致することを確認します。')
    expect(ALLOWLIST.map(entry => entry.toolName)).toEqual(CONTRACT_ORDER)
  })

  it('ALLOWLIST のツール名は、重複しない', async () => {
    await explains('許可するツールの一覧 `ALLOWLIST` のテストです。すべてのエントリのツール名が重複せず、ツール名の種類の数がエントリの数と一致することを確認します。')
    expect(new Set(ALLOWLIST.map(entry => entry.toolName)).size).toBe(ALLOWLIST.length)
  })

  it('ALLOWLIST のツール名は aws_<service>_<subcommand> の形で、入力名に aws を含まない', async () => {
    await explains('許可するツールの一覧 `ALLOWLIST` のテストです。すべてのエントリで、ツール名が `aws_<service>_<subcommand>`（サブコマンドのハイフンはアンダースコア）と一致し、入力名に `aws` が含まれないことを確認します。')
    // 接頭辞 aws_ は「どの CLI を包んだツールか」を名前で示す。aws 以外の CLI を足すときは
    // 別の接頭辞で同居させる。入力名は AWS API のパラメータ名を写すので aws は現れない。
    for (const entry of ALLOWLIST) {
      const subcommand = entry.subcommand.replaceAll('-', '_')
      expect(entry.toolName).toBe(`aws_${entry.service}_${subcommand}`)
      for (const input of entry.inputs) expect(input.name).not.toContain('aws')
    }
  })

  it('ALLOWLIST の位置引数は、0 から始まる連番で宣言する', async () => {
    await explains('許可するツールの一覧 `ALLOWLIST` のテストです。すべてのエントリで、位置引数の位置が 0 から始まる連番になっていることを確認します。')
    for (const entry of ALLOWLIST) {
      const positions = entry.inputs
        .map(input => input.positional)
        .filter(position => position !== undefined)
      // 位置は 0 始まりの連番でなければ argv の並びが決まらない。
      expect(positions.toSorted((left, right) => left - right))
        .toEqual(Array.from({ length: positions.length }, (_, index) => index))
    }
  })

  it('shorthand の入力は、同じエントリに存在する入力だけを構成要素として参照する', async () => {
    await explains('許可するツールの一覧 `ALLOWLIST` のテストです。種類が `shorthand` の入力のすべてで、構成要素が空でなく、参照先の入力名が同じエントリに存在することを確認します。')
    for (const entry of ALLOWLIST) {
      const names = new Set(entry.inputs.map(input => input.name))
      const shorthandInputs = entry.inputs.filter(candidate => candidate.kind === 'shorthand')
      for (const input of shorthandInputs) {
        expect(input.parts ?? []).not.toEqual([])
        const shorthandInputParts = input.parts ?? []
        for (const part of shorthandInputParts) {
          expect(names, `${entry.toolName}.${input.name}`).toContain(part.from)
        }
      }
    }
  })

  it('shorthand-list の入力は、elements と awsFlag を持ち、parts を持たない', async () => {
    await explains('許可するツールの一覧 `ALLOWLIST` のテストです。種類が `shorthand-list` の入力のすべてで、`elements` と `awsFlag` が定義され、`parts` が定義されていないことを確認します。')
    // shorthand（合成項目）と違い、利用者がオブジェクトの配列で直接指定する入力。
    // 項目の宣言先が parts のままだと組み立てが空振りする。
    for (const entry of ALLOWLIST) {
      const shorthandListInputs = entry.inputs.filter(candidate => candidate.kind === 'shorthand-list')
      for (const input of shorthandListInputs) {
        expect(input.parts, `${entry.toolName}.${input.name}`).toBeUndefined()
        expect(input.awsFlag, `${entry.toolName}.${input.name}`).toBeDefined()
        expect(input.elements ?? [], `${entry.toolName}.${input.name}`).not.toEqual([])
      }
    }
  })

  it('exclusive に指定した入力名は、同じエントリに存在する', async () => {
    await explains('許可するツールの一覧 `ALLOWLIST` のテストです。すべてのエントリで、`exclusive` のグループに挙げた入力名が、同じエントリの入力に存在することを確認します。')
    for (const entry of ALLOWLIST) {
      const names = new Set(entry.inputs.map(input => input.name))
      const exclusiveGroups = entry.exclusive ?? []
      for (const group of exclusiveGroups) {
        for (const name of group) expect(names, `${entry.toolName} の exclusive`).toContain(name)
      }
    }
  })

  it('JSON 出力を持たないツールは、高レベル s3 コマンドの aws_s3_ls だけになる', async () => {
    await explains('許可するツールの一覧 `ALLOWLIST` のテストです。`jsonOutput` が偽のエントリが、`aws_s3_ls` だけであることを確認します。')
    const withoutJson = ALLOWLIST.filter(entry => !entry.jsonOutput).map(entry => entry.toolName)

    expect(withoutJson).toEqual(['aws_s3_ls'])
  })
})

describe('共通入力', () => {
  it('profile の入力は、英数字と _ . - を受け付け、それ以外の文字を拒否する', async () => {
    await explains('全ツールに共通の入力 `PROFILE_INPUT` のテストです。`dev-account.1` は受け付け、空白を含む `dev account` は拒否し、フラグが `--profile` で必須でないことを確認します。')
    expect(PROFILE_INPUT.pattern?.test('dev-account.1')).toBe(true)
    expect(PROFILE_INPUT.pattern?.test('dev account')).toBe(false)
    expect(PROFILE_INPUT.awsFlag).toBe('--profile')
    expect(PROFILE_INPUT.required).toBe(false)
  })

  it('region の入力は、AWS のリージョン表記だけを受け付ける', async () => {
    await explains('全ツールに共通の入力 `REGION_INPUT` のテストです。`ap-northeast-1` や先頭が 4 文字の `eusc-de-east-1` は受け付け、`tokyo` のような不正な表記は拒否し、フラグが `--region` であることを確認します。')
    expect(REGION_INPUT.pattern?.test('ap-northeast-1')).toBe(true)
    expect(REGION_INPUT.pattern?.test('us-gov-west-1')).toBe(true)
    // European Sovereign Cloud は先頭が 4 文字。2 文字固定だと入力検証エラーで弾かれる。
    expect(REGION_INPUT.pattern?.test('eusc-de-east-1')).toBe(true)
    expect(REGION_INPUT.pattern?.test('tokyo')).toBe(false)
    expect(REGION_INPUT.pattern?.test('ap-northeast-')).toBe(false)
    expect(REGION_INPUT.awsFlag).toBe('--region')
  })
})

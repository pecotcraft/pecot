import { describe, expect, it } from 'vitest'

import {
  ALLOWLIST,
  findAllowlistEntry,
  PROFILE_INPUT,
  REGION_INPUT,
  type AllowlistEntry,
} from '../allowlist.js'

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
contracts/mcp-tools.md の表のうち、awscli コマンドを包む 24 件を表の順で並べたもの。

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
  'aws_s3_cp',
  'aws_s3api_get_object',
  'aws_rds_describe_events',
  'aws_rds_describe_db_clusters',
  'aws_rds_describe_db_instances',
  'aws_scheduler_list_schedules',
  'aws_scheduler_get_schedule',
  'aws_ecr_describe_images',
  'aws_ec2_describe_instances',
]

describe('findAllowlistEntry', () => {
  it('注入したエントリからツール名で引ける', () => {
    expect(findAllowlistEntry('aws_sts_get_caller_identity', [ENTRY])).toBe(ENTRY)
  })

  it('注入したエントリに無いツール名は undefined', () => {
    expect(findAllowlistEntry('aws_lambda_list_functions', [ENTRY])).toBeUndefined()
  })

  it('引数 1 つの呼び出しは ALLOWLIST を参照する', () => {
    expect(findAllowlistEntry('aws_sts_get_caller_identity')?.service).toBe('sts')
    expect(findAllowlistEntry('aws_sso_login')).toBeUndefined()
  })
})

describe('ALLOWLIST', () => {
  it('awscli コマンドの 24 件を契約表の順で並べる（SSO は許可リスト外）', () => {
    expect(ALLOWLIST.map(entry => entry.toolName)).toEqual(CONTRACT_ORDER)
  })

  it('ツール名が一意', () => {
    expect(new Set(ALLOWLIST.map(entry => entry.toolName)).size).toBe(ALLOWLIST.length)
  })

  it('ツール名は aws_<service>_<subcommand> で、入力名に aws を含めない', () => {
    // 接頭辞 aws_ は「どの CLI を包んだツールか」を名前で示す。aws 以外の CLI を足すときは
    // 別の接頭辞で同居させる。入力名は AWS API のパラメータ名を写すので aws は現れない。
    for (const entry of ALLOWLIST) {
      const subcommand = entry.subcommand.replaceAll('-', '_')
      expect(entry.toolName).toBe(`aws_${entry.service}_${subcommand}`)
      for (const input of entry.inputs) expect(input.name).not.toContain('aws')
    }
  })

  it('必須入力と位置引数の宣言が矛盾しない', () => {
    for (const entry of ALLOWLIST) {
      const positions = entry.inputs
        .map(input => input.positional)
        .filter(position => position !== undefined)
      // 位置は 0 始まりの連番でなければ argv の並びが決まらない。
      expect(positions.toSorted((left, right) => left - right))
        .toEqual(Array.from({ length: positions.length }, (_, index) => index))
    }
  })

  it('shorthand の項目は同じエントリの入力を指す', () => {
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

  it('shorthand-list は elements と awsFlag を持ち parts を持たない', () => {
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

  it('exclusive に挙げた入力名が実在する', () => {
    for (const entry of ALLOWLIST) {
      const names = new Set(entry.inputs.map(input => input.name))
      const exclusiveGroups = entry.exclusive ?? []
      for (const group of exclusiveGroups) {
        for (const name of group) expect(names, `${entry.toolName} の exclusive`).toContain(name)
      }
    }
  })

  it('高レベル s3 コマンドだけが JSON 出力を持たない', () => {
    const withoutJson = ALLOWLIST.filter(entry => !entry.jsonOutput).map(entry => entry.toolName)

    expect(withoutJson).toEqual(['aws_s3_ls', 'aws_s3_cp'])
  })
})

describe('共通入力', () => {
  it('profile は英数字と _ . - を受け、それ以外を弾く', () => {
    expect(PROFILE_INPUT.pattern?.test('dev-account.1')).toBe(true)
    expect(PROFILE_INPUT.pattern?.test('dev account')).toBe(false)
    expect(PROFILE_INPUT.awsFlag).toBe('--profile')
    expect(PROFILE_INPUT.required).toBe(false)
  })

  it('region は AWS のリージョン表記だけを受ける', () => {
    expect(REGION_INPUT.pattern?.test('ap-northeast-1')).toBe(true)
    expect(REGION_INPUT.pattern?.test('us-gov-west-1')).toBe(true)
    // European Sovereign Cloud は先頭が 4 文字。2 文字固定だと入力検証エラーで弾かれる。
    expect(REGION_INPUT.pattern?.test('eusc-de-east-1')).toBe(true)
    expect(REGION_INPUT.pattern?.test('tokyo')).toBe(false)
    expect(REGION_INPUT.pattern?.test('ap-northeast-')).toBe(false)
    expect(REGION_INPUT.awsFlag).toBe('--region')
  })
})

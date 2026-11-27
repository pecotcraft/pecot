// tests/interface/github-ops/ が共有する準備。operation と params を inputs に置いて action を呼び、PECOT_RESULT の行を読む。
import { expect } from 'vitest'

import { main } from '../../src/github-ops.js'
import { setEnvironment } from '../../../libs/workflow-core/tests/_helpers/environment.js'
import type { RecordedRequest, ResponseRule } from '../../../libs/workflow-core/tests/_helpers/fake-github/server.js'
import { runActionCase, startGithub } from './action-case.js'
import type { ActionResult, RunningGithub } from './action-case.js'

export const REPOSITORY = 'acme/demo'
export const SHA = 'a'.repeat(40)

export interface OpsResult extends ActionResult {
  /**
  stdout の PECOT_RESULT の行の JSON
  */
  readonly line: Record<string, unknown>
  /**
  結果の行の result。無ければ空のオブジェクト
  */
  readonly result: Record<string, unknown>
  /**
  結果の行の error の message。無ければ空の文字列
  */
  readonly message: string
  readonly github: RunningGithub
}

export interface OpsSetup {
  readonly requestId?: string
  /**
  params の文字列。省くと parametersValue を JSON にする
  */
  readonly rawParams?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
stdout から PECOT_RESULT の行を 1 つだけ取り出して読む
*/
export function resultLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter(line => line.startsWith('PECOT_RESULT '))
  expect(lines).toHaveLength(1)
  const parsed: unknown = JSON.parse((lines[0] ?? '').slice('PECOT_RESULT '.length))
  return isRecord(parsed) ? parsed : {}
}

/**
偽の GitHub を rules で始め、operation を 1 つ呼ぶ
*/
export async function runOperation(operation: string, parametersValue: unknown, rules: readonly ResponseRule[], setup: Readonly<OpsSetup> = {}): Promise<OpsResult> {
  setEnvironment({ GITHUB_REPOSITORY: REPOSITORY, GITHUB_SERVER_URL: 'https://github.com', ...setup.environment })
  const github = await startGithub(rules)
  const result = await runActionCase(main, {
    'token': 'dummy-token',
    operation,
    'request-id': setup.requestId ?? 'req-1',
    'params': setup.rawParams ?? JSON.stringify(parametersValue),
  })
  const line = resultLine(result.stdout)
  const error = line['error']
  const message = isRecord(error) && typeof error['message'] === 'string' ? error['message'] : ''
  return { ...result, line, result: isRecord(line['result']) ? line['result'] : {}, message, github }
}

/**
受けた要求のうち、書き込み（GraphQL の mutation の operation 名と、GET 以外の REST）だけを受けた順に並べる
*/
export function writesOf(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter(request => request.type === 'graphql' ? /^(?:Create|Update|Rename|Delete|Link)/u.test(request.operation) : request.method !== 'GET')
    .map(request => request.type === 'graphql' ? request.operation : `${request.method} ${request.path}`)
}

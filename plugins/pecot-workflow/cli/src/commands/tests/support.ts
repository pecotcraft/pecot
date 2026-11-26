// コマンドのテストの補助。出力を集める io（@pecot/workflow-core のテストと共有する）と、await を含む非同期の終了コード。
import { z } from 'zod'

import { CommandExit } from '@pecot/workflow-core/commands-shared/command-definition.js'
import type { FailureKind } from '@pecot/workflow-core/commands-shared/failure-kind.js'

export { capture } from '../../../../../../libs/workflow-core/tests/_helpers/captured-io.js'

/**
run の本体に使う。lint の規則（async は await を含む）を満たしつつ、0 を返すか、0 以外の終了コードで止める
*/
export async function exitWith(code: number, kind: FailureKind = 'other'): Promise<0> {
  await Promise.resolve()
  if (code !== 0) throw new CommandExit(code, kind)
  return 0
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Error は変えられない
export async function throwFailure(failure: Error): Promise<never> {
  await Promise.resolve()
  throw failure
}

/**
issue_create・issue_edit の attributes と同じ形の入力。オブジェクトの配列を CLI・定義書・help で扱うテストに使う
*/
const ATTRIBUTE_VALUE = z.union([z.string(), z.number(), z.array(z.string()), z.null()])

const ATTRIBUTE_INPUT = z.strictObject({
  name: z.string().describe('Attribute name'),
  value: ATTRIBUTE_VALUE.describe('Value to write'),
  source: z.enum(['project', 'issue_field', 'issue']).optional().describe('Where the attribute lives'),
})

export const ATTRIBUTES_INPUT = z.array(ATTRIBUTE_INPUT).optional().describe('Attributes to write')

export async function failWith(message: string): Promise<never> {
  await Promise.resolve()
  throw new Error(message)
}

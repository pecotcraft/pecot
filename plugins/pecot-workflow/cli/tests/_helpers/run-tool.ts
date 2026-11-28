// ツールの本体をプロセス内で呼び、終了コードと出力を返す。interface-case と command-harness が共有する。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- 定義の型は readonly にできない */
import { exitCodeOfFailure } from '@pecot/workflow-core/commands-shared/failure.js'
import type { ToolDefinition } from '../../src/commands/registry.js'
import { capture } from '../../src/commands/tests/support.js'
import { attachOutput } from '../../../../../libs/interface-spec/src/vitest/attach.js'
import { step } from './step.js'

export interface ToolRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
name のツールを tools から探して呼ぶ。入力の検証の誤り（ZodError）は例外のまま投げる。検証の誤りは MCP のクライアント（callToolOnce）で確かめる
*/
export async function runToolInProcess(tools: readonly ToolDefinition[], name: string, arguments_: Readonly<Record<string, unknown>>): Promise<ToolRunResult> {
  const definition = tools.find(tool => tool.name === name)
  if (definition === undefined) throw new TypeError(`${name} は渡したツールの一覧に無い`)
  const io = capture({ attach: false })
  const prepared = definition.parse(arguments_)
  // 検証の ZodError は step の外で投げる。中で投げると、拒否を確かめる通ったテストに broken の step が残る
  return await step(`${name} を呼ぶ`, async () => {
    let code: number
    try {
      code = await prepared.run(io)
    }
    catch (error: unknown) {
      code = exitCodeOfFailure(error, io)
    }
    const stdout = io.out.join('')
    const stderr = io.err.join('')
    attachOutput(`${name} ${JSON.stringify(arguments_)}`, code, stdout, stderr)
    return { code, stdout, stderr }
  })
}

// コマンドのテストの補助。出力を集める io と、await を含む非同期の終了コード。
import { CommandExit } from '../command-definition.js'
import type { FailureKind } from '../failure-kind.js'
import type { CommandIo } from '../registry.js'

export interface CapturedIo extends CommandIo {
  readonly out: string[]
  readonly err: string[]
}

export function capture(): CapturedIo {
  const out: string[] = []
  const error: string[] = []
  return {
    out,
    err: error,
    stdout: (text) => {
      out.push(text)
    },
    stderr: (text) => {
      error.push(text)
    },
  }
}

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

export async function failWith(message: string): Promise<never> {
  await Promise.resolve()
  throw new Error(message)
}

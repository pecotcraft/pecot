// コマンドのテストの補助。出力を集める io と、await を含む非同期の終了コード。
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
run の本体に使う。lint の規則（async は await を含む）を満たしつつ、終了コードを返す
*/
export async function exitWith(code: number): Promise<number> {
  await Promise.resolve()
  return code
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

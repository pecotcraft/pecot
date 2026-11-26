// コマンドのテストの補助。出力を集める io と、await を含む非同期の終了コード。
import { CommandExit } from '../../src/commands-shared/command-definition.js'
import type { CommandIo } from '../../src/commands-shared/command-definition.js'
import type { FailureKind } from '../../src/commands-shared/failure-kind.js'

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
run の本体に使う。async は await を含む、という lint の規則を満たし、0 を返すか、0 以外の終了コードで止める
*/
export async function exitWith(code: number, kind: FailureKind = 'other'): Promise<0> {
  await Promise.resolve()
  if (code !== 0) throw new CommandExit(code, kind)
  return 0
}

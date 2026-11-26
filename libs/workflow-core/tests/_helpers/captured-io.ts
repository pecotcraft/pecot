// コマンドのテストの補助。出力を集める io と、await を含む非同期の終了コード。
import { onTestFinished, TestRunner } from 'vitest'

import { attachOutput } from '../../../interface-spec/src/vitest/attach.js'
import { CommandExit } from '../../src/commands-shared/command-definition.js'
import type { CommandIo } from '../../src/commands-shared/command-definition.js'
import type { FailureKind } from '../../src/commands-shared/failure-kind.js'

export interface CapturedIo extends CommandIo {
  readonly out: string[]
  readonly err: string[]
}

export interface CaptureOptions {
  /**
  テストの終わりの out・err を添付する。argv と終了コードの名前で自ら添付する補助は false にする
  */
  readonly attach?: boolean
}

export function capture(options: Readonly<CaptureOptions> = {}): CapturedIo {
  const out: string[] = []
  const error: string[] = []
  // テストの外で onTestFinished を呼ぶと vitest が throw する。
  if (options.attach !== false && TestRunner.getCurrentTest() !== undefined) {
    onTestFinished(() => {
      attachOutput('capture', undefined, out.join(''), error.join(''))
    })
  }
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

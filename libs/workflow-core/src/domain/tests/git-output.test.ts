import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { formatHinted } from '../command-hint.js'
import { gitFailureText, gitReasonOf, logOf } from '../git-output.js'

const ADD_FAILURE = 'Preparing worktree (new branch \'wt1\')\nfatal: \'/w/occupied\' already exists\n'

describe('gitReasonOf', () => {
  it('fatal の行がある場合は、その行より前の進捗の行を除く', async () => {
    await explains('git コマンドの失敗の出力から理由を取り出す、`gitReasonOf` のテストです。`fatal:` の行より前に進捗の行がある場合に、`fatal:` の行だけを返すことを確認します。')
    stepSync('gitReasonOf を呼び、結果を比べる', () => {
      expect(gitReasonOf(ADD_FAILURE)).toBe('fatal: \'/w/occupied\' already exists')
    })
  })

  it('error の行がある場合は、その行以降を続く行も含めて返す', async () => {
    await explains('git コマンドの失敗の出力から理由を取り出す、`gitReasonOf` のテストです。`error:` の行の後に `hint:` などの行が続く場合に、`error:` の行から最後までを返すことを確認します。')
    stepSync('gitReasonOf を呼び、結果を比べる', () => {
      expect(gitReasonOf('remote: counting\nerror: cannot lock ref\nhint: try again\n')).toBe('error: cannot lock ref\nhint: try again')
    })
  })

  it('fatal と error の行が存在しない場合は、前後の空白を除いた全文を返す', async () => {
    await explains('git コマンドの失敗の出力から理由を取り出す、`gitReasonOf` のテストです。`fatal:` と `error:` のどちらの行も存在しない場合に、前後の空白を除いた出力の全文を返すことを確認します。')
    stepSync('gitReasonOf を呼び、結果を比べる', () => {
      expect(gitReasonOf(' ! [rejected] a -> a (fetch first)\n')).toBe('! [rejected] a -> a (fetch first)')
    })
  })
})

describe('gitFailureText', () => {
  it('前置きの後に、git の出力の理由の行だけを続ける', async () => {
    await explains('git コマンドの失敗を表す文を作成する、`gitFailureText` のテストです。進捗の行を含む出力を渡した場合に、前置きの後に `fatal:` の理由の行だけが続くことを確認します。')
    const text = stepSync('gitFailureText を呼ぶ', () => gitFailureText('failed to create the worktree: ', ADD_FAILURE))
    stepSync('結果を比べる', () => {
      expect(formatHinted(text)).toBe('failed to create the worktree: fatal: \'/w/occupied\' already exists')
    })
  })
})

function withLog(log: unknown): Error {
  return Object.assign(new Error('x'), { log })
}

describe('logOf', () => {
  it('例外が文字列の log を持つ場合は、それを返す', async () => {
    await explains('例外から git の出力（`log`）を取り出す、`logOf` のテストです。例外が文字列の `log` を持つ場合に、その文字列を返すことを確認します。')
    stepSync('logOf を呼び、結果を比べる', () => {
      expect(logOf(withLog(ADD_FAILURE))).toBe(ADD_FAILURE)
    })
  })

  it('log が存在しない・空白だけ・文字列でない場合は、undefined を返す', async () => {
    await explains('例外から git の出力（`log`）を取り出す、`logOf` のテストです。`log` が存在しない場合、空白だけの場合、文字列でない場合、例外でない値を渡した場合のいずれも、`undefined` を返すことを確認します。')
    stepSync('logOf を呼び、結果を比べる', () => {
      expect(logOf(new Error('x'))).toBeUndefined()
      expect(logOf(withLog(' \n'))).toBeUndefined()
      expect(logOf(withLog(1))).toBeUndefined()
      expect(logOf('x')).toBeUndefined()
    })
  })
})

// issue 系のコマンドの共有関数のテスト
import { describe, expect, it } from 'vitest'
import { step, stepSync } from '../../../tests/_helpers/step.js'
import { explains } from '../../../tests/_helpers/explains.js'

import '../../../tests/_helpers/hint-commands.js'
import { hasReportedTemplateTextViolations, parseIssueReferenceOrExit, runWithExit } from '../issue-shared.js'
import { CommandExit } from '../command-definition.js'
import { createOutput } from '../output.js'
import { capture } from '../../../tests/_helpers/captured-io.js'
import type { CapturedIo } from '../../../tests/_helpers/captured-io.js'

function started(): { readonly io: CapturedIo, readonly output: ReturnType<typeof createOutput> } {
  const io = capture()
  return { io, output: createOutput(false, io) }
}

async function succeed(): Promise<void> {
  await Promise.resolve()
}

async function exitWith3(): Promise<void> {
  await Promise.resolve()
  throw new CommandExit(3, 'content-invalid')
}

async function boom(): Promise<void> {
  await Promise.resolve()
  throw new TypeError('boom')
}

describe('runWithExit', () => {
  it('処理が正常に終了した場合は、終了コード 0 を返す', async () => {
    await explains('処理を実行して終了コードへ変換する関数（`runWithExit`）のテストです。例外が発生せず終了した場合は、終了コード 0 を返すことを確認します。')
    await step('結果を確認する', async () => {
      expect(await runWithExit(succeed)).toBe(0)
    })
  })

  it('CommandExit が発生した場合は、終了コードを保ったまま再度発生させる', async () => {
    await explains('`runWithExit` が実行する処理で、`CommandExit`（終了コード 3）が発生した場合のテストです。変換せず、終了コード 3 を持つ例外が発生することを確認します。')
    await step('結果を確認する', async () => {
      await expect(runWithExit(exitWith3)).rejects.toMatchObject({ exitCode: 3 })
    })
  })

  it('それ以外の例外は、変換せずにそのまま発生させる', async () => {
    await explains('`TypeError` など、想定していない例外が発生した場合のテストです。変換せず、元のメッセージのまま例外が発生することを確認します。')
    await step('結果を確認する', async () => {
      await expect(runWithExit(boom)).rejects.toThrow('boom')
      expect(new CommandExit(2, 'invalid-input').exitCode).toBe(2)
    })
  })
})

describe('hasReportedTemplateTextViolations', () => {
  const TEMPLATE = '---\ntemplate: note\n---\n\n## Note — <要約>\n\n- 中身 — <中身>\n'

  it('文字列のテンプレートの見出しを持つ本文は、何も出さずに false を返す', async () => {
    await explains('本文がテンプレートに沿うかを確認する `hasReportedTemplateTextViolations` のテストです。文字列のテンプレートの見出しをすべて持つ本文の場合に、何も出力せず `false` を返すことを確認します。')
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(hasReportedTemplateTextViolations(output, '## Note — 要約\n\n- 中身 — 本文\n', 'note', TEMPLATE)).toBe(false)
      expect(io.err).toEqual([])
    })
  })

  it('見出しが無い本文は、テンプレートの名前と不足を出して true を返す', async () => {
    await explains('本文がテンプレートに沿うかを確認する `hasReportedTemplateTextViolations` のテストです。見出しの無い本文の場合に、テンプレートの名前と不足している見出しを出力し、`true` を返すことを確認します。')
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(hasReportedTemplateTextViolations(output, 'ただの本文', 'note', TEMPLATE)).toBe(true)
      expect(io.err[0]).toMatch(/^error: the body does not follow the template note\n {2}missing sections: /u)
    })
  })
})

describe('Issue 参照と設定', () => {
  it('repo を基準にして、短縮形と owner/repo/N の形を区別して解釈する', async () => {
    await explains('Issue の参照を解釈する関数（`parseIssueReferenceOrExit`）のテストです。番号だけの短縮形は `repo` のリポジトリの Issue になり、`owner/repo/N` の形は指定したリポジトリの Issue になることを確認します。')
    const { output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(parseIssueReferenceOrExit(output, 'o/r', '5')).toEqual({ owner: 'o', repository: 'r', number: 5 })
      expect(parseIssueReferenceOrExit(output, 'o/r', 'x/y/7')).toEqual({ owner: 'x', repository: 'y', number: 7 })
    })
  })

  it('不正な参照を指定した場合は、エラーの行を表示して終了コード 2 で止める', async () => {
    await explains('解釈できない参照（`zzz`）を指定した場合のテストです。`error:` で始まる行を表示し、終了コード 2 の `CommandExit` が発生することを確認します。')
    const { io, output } = stepSync('出力の捕捉を用意する', () => started())
    stepSync('結果を確認する', () => {
      expect(() => parseIssueReferenceOrExit(output, 'o/r', 'zzz')).toThrow(expect.objectContaining({ exitCode: 2 }))
      expect(io.err[0]).toMatch(/^error: /u)
    })
  })
})

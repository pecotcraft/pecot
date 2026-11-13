// スキル・エージェント・hooks のテンプレートの本文が、Node だけで動く手順であることを確かめる。
import { describe, expect, it } from 'vitest'

import { readDocuments } from './_helpers/documents.js'

const PYTHON = /\bpython3?\b/u

describe('本文が呼ぶ実行環境', () => {
  it('スキル・エージェント・hooks のテンプレートの本文に、python の呼び出しを置かない', () => {
    const offenders: string[] = []
    for (const { file, text } of readDocuments()) {
      for (const [index, line] of text.split('\n').entries()) {
        if (PYTHON.test(line)) offenders.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

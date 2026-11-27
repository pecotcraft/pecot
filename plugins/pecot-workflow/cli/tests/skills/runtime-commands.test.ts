// スキル・エージェント・hooks のテンプレートの本文が、Node だけで動く手順であることを確かめる。
import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { readDocuments } from './_helpers/documents.js'

const PYTHON = /\bpython[23]?\b/iu

describe('本文が呼ぶ実行環境', () => {
  it('スキル・エージェント・hooks のテンプレートの本文に python の語が含まれない', async () => {
    await explains('スキル・エージェント・hooks のテンプレートの本文のテストです。どの文書にも `python`・`python2`・`python3` の語が含まれず、Node だけで動く手順であることを確認します。')
    const offenders: string[] = []
    for (const { file, text } of readDocuments()) {
      for (const [index, line] of text.split('\n').entries()) {
        if (PYTHON.test(line)) offenders.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

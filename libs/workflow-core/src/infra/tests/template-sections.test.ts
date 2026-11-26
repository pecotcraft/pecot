/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractSectionsFromTemplate } from '../../domain/sections.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { readTemplateSections } from '../template-sections.js'
import { explains } from '../../../tests/_helpers/explains.js'

function writeTemplate(content: string): string {
  const file = path.join(makeTemporaryDirectory(), 'test.md')
  writeFileSync(file, content, 'utf8')
  return file
}

describe('readTemplateSections', () => {
  it('ファイルから見出しレベルを抽出する', async () => {
    await explains('テンプレートファイルから見出しを抽出する `readTemplateSections` のテストです。`###` と `####` の見出しを含むファイルの場合に、見出しのレベルと名前の一覧を返すことを確認します。')
    const file = writeTemplate('---\nissue_ref: ""\n---\n\n### 完了した作業\n- 内容\n\n#### 残タスク\n- なし\n')
    expect(readTemplateSections(file)).toEqual([{ level: 3, name: '完了した作業' }, { level: 4, name: '残タスク' }])
  })

  it('ファイルが存在しない場合は、空の一覧を返す', async () => {
    await explains('`readTemplateSections` のテストです。存在しないファイルを指定した場合に、例外を発生させず、空の配列を返すことを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'nonexistent.md')
    expect(readTemplateSections(file)).toEqual([])
  })

  it('ファイルとして読めないパス（ディレクトリ）を指定した場合は、空の一覧を返す', async () => {
    await explains('`readTemplateSections` のテストです。ディレクトリを指定した場合に、例外を発生させず、空の配列を返すことを確認します。')
    const directory = path.join(makeTemporaryDirectory(), 'dir.md')
    mkdirSync(directory)
    expect(readTemplateSections(directory)).toEqual([])
  })

  it('ファイルの内容を domain 層の抽出関数に渡した結果と、同じ一覧を返す', async () => {
    await explains('`readTemplateSections` のテストです。ファイルの内容を `extractSectionsFromTemplate` へ直接渡した結果と、返す一覧が一致することを確認します。')
    const file = writeTemplate('## A — <a>\n### B\n')
    expect(readTemplateSections(file)).toEqual(extractSectionsFromTemplate('## A — <a>\n### B\n'))
  })
})

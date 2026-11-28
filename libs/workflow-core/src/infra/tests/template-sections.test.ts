/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractSectionsFromTemplate } from '../../domain/sections.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { readTemplateSections } from '../template-sections.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

function writeTemplate(content: string): string {
  const file = path.join(makeTemporaryDirectory(), 'test.md')
  writeFileSync(file, content, 'utf8')
  return file
}

describe('readTemplateSections', () => {
  it('ファイルから見出しレベルを抽出する', async () => {
    await explains('テンプレートファイルから見出しを抽出する `readTemplateSections` のテストです。`###` と `####` の見出しを含むファイルの場合に、見出しのレベルと名前の一覧を返すことを確認します。')
    const file = stepSync('見出しを含むテンプレートを置く', () => writeTemplate('---\nissue_ref: ""\n---\n\n### 完了した作業\n- 内容\n\n#### 残タスク\n- なし\n'))
    const sections = stepSync('見出しを抽出する', () => readTemplateSections(file))
    stepSync('見出しの一覧を比べる', () => {
      expect(sections).toEqual([{ level: 3, name: '完了した作業' }, { level: 4, name: '残タスク' }])
    })
  })

  it('ファイルが存在しない場合は、空の一覧を返す', async () => {
    await explains('`readTemplateSections` のテストです。存在しないファイルを指定した場合に、例外を発生させず、空の配列を返すことを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'nonexistent.md')
    const sections = stepSync('存在しないファイルから見出しを抽出する', () => readTemplateSections(file))
    stepSync('一覧が空であることを確かめる', () => {
      expect(sections).toEqual([])
    })
  })

  it('ファイルとして読めないパス（ディレクトリ）を指定した場合は、空の一覧を返す', async () => {
    await explains('`readTemplateSections` のテストです。ディレクトリを指定した場合に、例外を発生させず、空の配列を返すことを確認します。')
    const directory = stepSync('ディレクトリを作る', () => {
      const created = path.join(makeTemporaryDirectory(), 'dir.md')
      mkdirSync(created)
      return created
    })
    const sections = stepSync('ディレクトリから見出しを抽出する', () => readTemplateSections(directory))
    stepSync('一覧が空であることを確かめる', () => {
      expect(sections).toEqual([])
    })
  })

  it('ファイルの内容を domain 層の抽出関数に渡した結果と、同じ一覧を返す', async () => {
    await explains('`readTemplateSections` のテストです。ファイルの内容を `extractSectionsFromTemplate` へ直接渡した結果と、返す一覧が一致することを確認します。')
    const file = stepSync('テンプレートを置く', () => writeTemplate('## A — <a>\n### B\n'))
    const sections = stepSync('ファイルから見出しを抽出する', () => readTemplateSections(file))
    stepSync('内容を直接渡した結果と比べる', () => {
      expect(sections).toEqual(extractSectionsFromTemplate('## A — <a>\n### B\n'))
    })
  })
})

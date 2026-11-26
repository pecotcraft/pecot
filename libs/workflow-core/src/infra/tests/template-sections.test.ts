/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractSectionsFromTemplate } from '../../domain/sections.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import { readTemplateSections } from '../template-sections.js'

function writeTemplate(content: string): string {
  const file = path.join(makeTemporaryDirectory(), 'test.md')
  writeFileSync(file, content, 'utf8')
  return file
}

describe('readTemplateSections', () => {
  it('ファイルから見出しレベルを抽出する', () => {
    const file = writeTemplate('---\nissue_ref: ""\n---\n\n### 完了した作業\n- 内容\n\n#### 残タスク\n- なし\n')
    expect(readTemplateSections(file)).toEqual([{ level: 3, name: '完了した作業' }, { level: 4, name: '残タスク' }])
  })

  it('ファイルが存在しない場合は空リスト', () => {
    const file = path.join(makeTemporaryDirectory(), 'nonexistent.md')
    expect(readTemplateSections(file)).toEqual([])
  })

  it('読めないファイル（ディレクトリ）は空リスト', () => {
    const directory = path.join(makeTemporaryDirectory(), 'dir.md')
    mkdirSync(directory)
    expect(readTemplateSections(directory)).toEqual([])
  })

  it('テンプレートファイルの内容を domain の抽出関数に渡した結果と同じ', () => {
    const file = writeTemplate('## A — <a>\n### B\n')
    expect(readTemplateSections(file)).toEqual(extractSectionsFromTemplate('## A — <a>\n### B\n'))
  })
})

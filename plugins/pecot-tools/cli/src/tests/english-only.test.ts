// src の実行コード（tests を除く）の文字列に日本語が無いことを確かめる。利用者に見える文言は英語にそろえるため。
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { explains } from '../../tests/_helpers/explains.js'

const SRC_DIR = path.resolve(import.meta.dirname, '..')

// かな・漢字（拡張を含む）・CJK の句読点・全角形。pecot-workflow の test_english_only.py と同じ範囲。
// eslint-disable-next-line security/detect-unsafe-regex -- 文字クラスだけで繰り返しが無い
const JAPANESE = /[\u{3040}-\u{30FF}\u{31F0}-\u{31FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{3000}-\u{303F}\u{FF00}-\u{FFEF}]/u

function listSourceFiles(directory: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- import.meta.dirname 相対で組んだパス
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : listSourceFiles(full)
    return entry.name.endsWith('.ts') ? full : []
  })
}

/**
文字列リテラルとテンプレートの固定部分のうち、日本語を含むものを `<行>: <先頭 40 文字>` で返す
*/
function findJapaneseStrings(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const isText = ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
    if (isText && JAPANESE.test(node.text)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      found.push(`${String(line + 1)}: ${node.text.trim().slice(0, 40)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

const files = listSourceFiles(SRC_DIR)

describe('実行コードの文言を英語にそろえる', () => {
  it('確認の対象となる実行コードのファイルが存在する', async () => {
    await explains('利用者に見える文言を英語にそろえるための、日本語の文字列を検出するテストです。`src` 配下の `tests` を除く実行コードのファイルが、1 件以上見つかることを確認します。')
    expect(files.length).toBeGreaterThan(0)
  })

  it('実行コードの文字列リテラルに、日本語を含まない', async () => {
    await explains('利用者に見える文言を英語にそろえるための、日本語の文字列を検出するテストです。`src` 配下の実行コードの文字列リテラルとテンプレートの固定部分に、かな、漢字、全角の文字が 1 件も含まれないことを確認します。')
    const found = files.flatMap((file) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- listSourceFiles が返した src 配下のパス
      const text = readFileSync(file, 'utf8')
      return findJapaneseStrings(file, text).map(line => `${path.relative(SRC_DIR, file)}:${line}`)
    })
    expect(found).toEqual([])
  })
})

describe('findJapaneseStrings', () => {
  it.each([
    ['かな', 'const a = \'こんにちは\''],
    ['漢字', 'const a = \'失敗\''],
    ['全角', 'const a = \'ＡＢＣ\''],
    ['テンプレートの固定部分', 'const a = `失敗: ${String(1)}`'],
  ])('文字列に %s が含まれているとき、日本語として 1 件検出する', async (_name, source) => {
    await explains('日本語の文字列を検出する `findJapaneseStrings` のテストです。かな、漢字、全角の文字、テンプレートリテラルの固定部分を含む文字列を渡した場合に、いずれも 1 件検出することを確認します。')
    expect(findJapaneseStrings('a.ts', source)).toHaveLength(1)
  })

  it('英語だけの文字列は、日本語として検出しない', async () => {
    await explains('日本語の文字列を検出する `findJapaneseStrings` のテストです。英語だけの文字列とテンプレートを渡した場合に、検出結果が空であることを確認します。')
    expect(findJapaneseStrings('a.ts', 'const a = \'failed\'\nconst b = `x ${a}`')).toEqual([])
  })

  it('コメントに含まれる日本語は、検出しない', async () => {
    await explains('日本語の文字列を検出する `findJapaneseStrings` のテストです。コメントにだけ日本語がある場合に、検出結果が空であることを確認します。')
    expect(findJapaneseStrings('a.ts', '// 日本語\nconst a = 1')).toEqual([])
  })
})

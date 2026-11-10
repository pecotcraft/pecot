// src の実行コード（tests を除く）の文字列に日本語が無いことを確かめる。利用者に見える文言は英語にそろえるため。
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

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
  it('対象のファイルがある', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('日本語の文字列が無い', () => {
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
  ])('%s を 1 件見つける', (_name, source) => {
    expect(findJapaneseStrings('a.ts', source)).toHaveLength(1)
  })

  it('英語は 0 件', () => {
    expect(findJapaneseStrings('a.ts', 'const a = \'failed\'\nconst b = `x ${a}`')).toEqual([])
  })

  it('コメントの日本語は数えない', () => {
    expect(findJapaneseStrings('a.ts', '// 日本語\nconst a = 1')).toEqual([])
  })
})

// src/ の固定の文言が英語であることを確かめる（spec 021 FR-015 / SC-007）。
// 文字列リテラルと、テンプレートリテラルの固定部分を調べる。コメントと、`${}` の中の式は対象外。
// src/**/tests/ と *.test.ts は外す。

/* eslint-disable security/detect-non-literal-fs-filename -- src ツリーの走査と読み込みのみ */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// tests/unit → cli/src
const SOURCE_ROOT = path.resolve(import.meta.dirname, '..', '..', 'src')

// かな・CJK 漢字（拡張を含む）・CJK の句読点・全角形。pecot-workflow の test_english_only.py と同じ範囲。
// eslint-disable-next-line security/detect-unsafe-regex -- 文字クラス 1 つだけで量指定子が無く、後戻りしない
const JAPANESE = /[\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{31F0}-\u{31FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}]/u

interface Allowed {
  readonly file: string
  readonly text: string
}

// 例外: エージェントへの文言でなく、利用者に渡す帳票（evidence の xlsx）の見出しのセルに入る中身。
const ALLOWED: readonly Allowed[] = [{ file: 'domain/evidence-xlsx/layout.ts', text: '作成日' }]

interface Finding {
  readonly file: string
  readonly line: number
  readonly text: string
}

function sourceFiles(): readonly string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map(entry => path.relative(SOURCE_ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter(file => !file.split('/').includes('tests'))
    .toSorted((left, right) => left.localeCompare(right))
}

function japaneseLiterals(file: string, source: string): readonly Finding[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: Finding[] = []
  ts.forEachChild(sourceFile, function visit(node) {
    if (
      (ts.isStringLiteral(node)
        || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node)
        || ts.isTemplateTail(node))
      && JAPANESE.test(node.text)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      found.push({ file, line: line + 1, text: node.text })
    }
    ts.forEachChild(node, visit)
  })
  return found
}

function isAllowed(finding: Finding): boolean {
  return ALLOWED.some(allowed => allowed.file === finding.file && allowed.text === finding.text)
}

const FILES = sourceFiles()
const FINDINGS = FILES.flatMap(file => japaneseLiterals(file, readFileSync(path.join(SOURCE_ROOT, file), 'utf8')))

describe('src/ の固定の文言が英語', () => {
  it('調べる .ts を 1 件以上見つける', () => {
    expect(FILES.length).toBeGreaterThan(0)
  })

  it('文字列リテラルに日本語の文字が無い', () => {
    const report = FINDINGS.filter(finding => !isAllowed(finding)).map(
      finding => `${finding.file}:${String(finding.line)}: ${finding.text.trim().slice(0, 40)}`,
    )
    expect(report, `Japanese text in string literals:\n${report.join('\n')}`).toEqual([])
  })

  it('例外はすべて使われている', () => {
    const unused = ALLOWED.filter(
      allowed => FINDINGS.every(finding => !(finding.file === allowed.file && finding.text === allowed.text)),
    )
    expect(unused).toEqual([])
  })
})

describe('判定器', () => {
  it.each([
    ['const a = \'日本語\'', 1],
    ['const a = "カタカナ"', 1],
    ['const a = `ひらがな ${x}`', 1],
    ['const a = `${x} 漢字 ${y} 終わり`', 2],
    ['const a = \'full-width （）\'', 1],
    ['const a = \'English only — ok → §\'', 0],
    ['const a = `${日本}`', 0],
    ['const a = /[\\u3040-\\u30FF]|あ/u', 0],
    ['// コメント\nconst a = 1', 0],
  ])('%s → %i 件', (source, expected) => {
    expect(japaneseLiterals('sample.ts', source)).toHaveLength(expected)
  })
})

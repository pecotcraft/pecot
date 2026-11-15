// スキルが MCP ツールの結果を、文や行ではなく data の項目で読ませていることを確かめる。
// 結果に stdout・stderr は無く、結果の行（created: など）も data の項目に移った。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { readDocuments } from './_helpers/documents.js'

/**
結果の文や行を読ませる書き方。stdout・stderr の名前、結果の行の前置き、CLI の表示の節と行、表示や返り値を文で読ませる言い方
*/
const RESULT_TEXT_PATTERNS: readonly RegExp[] = [
  /\bstdout\b/u,
  /\bstderr\b/u,
  /`(?:created|closed|added|moved|set|skipped|landed|warning|error):/u,
  /`=== /u,
  /Registered repositories|Roadmap repo:|`Parent:`|`Sub-issues:`|Current directory name/u,
  /`## (?:Active Issue|Stack)`/u,
  /\(stacked on/u,
  /`release_type: (?:<|\w+`\s*→)/u,
  /`(?:develop|release):`|`develop: /u,
  /が返(?:る|って|れば)/u,
  /が表示され/u,
  /出力された/u,
]

// 本文の写しは 1 行が長く文面の規則に当たるので、規則の対象外の .txt・.tsv に置く
function fixtureLines(name: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- このテストの隣の fixtures の固定のファイル
  return readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8').split('\n').filter(line => line !== '')
}

/**
MCP ツールの結果ではない出力を読ませる行。ファイル・理由と、前後の空白を除いた行の全文をタブで区切る
*/
const ALLOWED: readonly { readonly file: string, readonly reason: string, readonly line: string }[] = fixtureLines('result-text-allowed.tsv').map((row) => {
  const [file = '', reason = '', line = ''] = row.split('\t', 3)
  return { file, reason, line }
})

/**
#433 で skills・agents・hooks/templates から消した、結果の文を読ませていた行。パターンが弱くなると、どれかが当たらなくなる
*/
const RESULT_TEXT_BEFORE: readonly string[] = fixtureLines('result-text-before.txt')

function isAllowed(file: string, line: string): boolean {
  return ALLOWED.some(entry => entry.file === file && line.trim() === entry.line)
}

function isResultText(line: string): boolean {
  return RESULT_TEXT_PATTERNS.some(pattern => pattern.test(line))
}

describe('ツールの結果の読み方', () => {
  it('スキルが MCP ツールの結果を読ませるときは、stdout・stderr や結果の行ではなく data の項目で読ませる', () => {
    const found = readDocuments().flatMap(({ file, text }) => text.split('\n')
      .map((line, index) => ({ file, number: index + 1, line }))
      .filter(({ line }) => isResultText(line) && !isAllowed(file, line))
      .map(({ number, line }) => `${file}:${String(number)}: ${line.trim()}`))
    expect(found).toEqual([])
  })

  it('結果の文を読ませていた変更前の行は、どれもパターンに当たる', () => {
    expect(RESULT_TEXT_BEFORE).toHaveLength(74)
    expect(RESULT_TEXT_BEFORE.filter(line => !isResultText(line))).toEqual([])
  })

  it('許可の一覧の行は、どれも理由を持ち、今も本文にあり、パターンに当たる', () => {
    const lines = new Map(readDocuments().map(({ file, text }) => [file, new Set(text.split('\n').map(line => line.trim()))]))
    const invalid = ALLOWED.filter(entry => entry.reason === '' || lines.get(entry.file)?.has(entry.line) !== true || !isResultText(entry.line))
    expect(ALLOWED).toHaveLength(8)
    expect(invalid.map(entry => `${entry.file}: ${entry.line}`)).toEqual([])
  })
})

// スキルが MCP ツールの結果を、文や行ではなく項目で読ませていることを確かめる。
// 結果に stdout・stderr は無く、結果の行（created: など）も項目に移った。#436 で、項目は data の下から最上位に上がった。
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

/**
#436 で結果から外した入れ物の読み方。項目は `data.` を付けずに読み、失敗の原因は `kind` で読む
*/
const CONTAINER_PATTERNS: readonly RegExp[] = [
  /`data\.[A-Za-z_]/u,
  /`data`/u,
  /`ok`/u,
  /`exitCode`/u,
  /`artifacts`/u,
  /`data\.reason`/u,
  /結果の `message`/u,
]

describe('ツールの結果の入れ物', () => {
  it('スキルは、結果の項目を data. 付きで読ませず、ok・exitCode・artifacts で分岐させない', () => {
    const found = readDocuments().flatMap(({ file, text }) => text.split('\n')
      .map((line, index) => ({ file, number: index + 1, line }))
      .filter(({ line }) => CONTAINER_PATTERNS.some(pattern => pattern.test(line)))
      .map(({ file: name, number, line }) => `${name}:${String(number)}: ${line.trim()}`))
    expect(found).toEqual([])
  })

  it('パターンは、変更前の読み方に当たる', () => {
    const before = ['結果の `data.branch` を読む', '結果の `ok` が `false` なら止まる', '`kind` が `x`（`exitCode` は 2）', '結果の `artifacts` にある', '結果の `data` を見る']
    expect(before.filter(line => CONTAINER_PATTERNS.every(pattern => !pattern.test(line)))).toEqual([])
  })

  it('失敗の原因は kind で読ませる', () => {
    const text = readDocuments().find(({ file }) => file === 'skills/w-active/SKILL.md')?.text ?? ''
    expect(text).toContain('`kind` が `guard-blocked`')
  })

  it('スキルは、MCP の仕様が決める結果の項目（isError・structuredContent）を説明しない', () => {
    const found = readDocuments().flatMap(({ file, text }) => text.split('\n')
      .map((line, index) => ({ file, number: index + 1, line }))
      .filter(({ line }) => /isError|structuredContent/u.test(line))
      .map(({ file: name, number, line }) => `${name}:${String(number)}: ${line.trim()}`))
    expect(found).toEqual([])
  })
})

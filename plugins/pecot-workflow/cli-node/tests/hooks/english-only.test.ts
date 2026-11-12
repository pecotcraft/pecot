/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下のみ */
// hooks がエージェントへ返す文言に日本語が無いことの静的な確認（spec 021 FR-014・SC-007）。
// 範囲は hooks/**/*.sh・hooks/hooks*.json・hooks/templates/*.md。テストは hooks/ の外にあるので範囲に入らない。
//
// コメントの判定は次のとおり。
// - .sh は、先頭の空白を除いて # で始まる行をコメントとして外す。heredoc の中と、複数行の引用符の文字列の中は外さない。
// - .md は <!-- ... --> だけを外す。# の見出しは本文として扱う。
// - .json は全行を調べる。
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings } from '../parity/baseline.js'
import { hooksDirectory } from './_helpers/paths.js'
import { splitLines } from './_helpers/text.js'

// 日本語の区間（コードポイントの範囲）。
const JAPANESE_RANGES: readonly (readonly [number, number])[] = [
  [0x30_00, 0x30_FF],
  [0x34_00, 0x9F_FF],
  [0xF9_00, 0xFA_FF],
  [0xFF_00, 0xFF_EF],
]

function hasJapanese(line: string): boolean {
  // 区間はすべて BMP に収まる。コードポイントの範囲で比べる。
  for (let index = 0; index < line.length; index += 1) {
    const unit = line.codePointAt(index) ?? 0
    if (JAPANESE_RANGES.some(([low, high]) => unit >= low && unit <= high)) return true
  }
  return false
}

const HEREDOC_START = /(?:^|\s)<<(?<dash>-?)\s*(?<quote>['"]?)(?<terminator>[A-Za-z_]\w*)\k<quote>/u

// 例外は、.gitignore を書き出す heredoc の日本語のコメント行。ファイルと行の内容で名指しして外す。
const EXEMPT: readonly (readonly [string, string])[] = [
  ['lib/core/pecot-gitignore-ensure.sh', '# pecot の設定だけを追跡し、生成物は管理外にする許可の一覧。'],
]

type NumberedLine = readonly [number, string]

// Python のパスの並びに合わせる。パスを構成要素ごとに比べる。
function comparePathParts(left: string, right: string): number {
  const leftParts = left.split('/')
  const rightParts = right.split('/')
  const firstDifference = leftParts.map((part, index) => compareStrings(part, rightParts.at(index) ?? '')).find(order => order !== 0)
  return firstDifference ?? leftParts.length - rightParts.length
}

// 1 行を走査して、行末で開いている引用符の種類を返す。閉じていれば undefined。
function scanQuotes(line: string, initial: string | undefined): string | undefined {
  let state = initial
  let index = 0
  while (index < line.length) {
    const char = line.charAt(index)
    if (state === undefined) {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '\'' || char === '"') state = char
      else if (char === '#' && (index === 0 || ' \t'.includes(line.charAt(index - 1)))) break
    }
    else if (state === '\'') {
      if (char === '\'') state = undefined
    }
    else {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '"') state = undefined
    }
    index += 1
  }
  return state
}

// コメントでない行を、行番号つきで返す。
function shLines(text: string): NumberedLine[] {
  const result: NumberedLine[] = []
  let quote: string | undefined
  let heredocEnd: string | undefined
  let isHeredocDash = false
  for (const [offset, line] of splitLines(text).entries()) {
    const lineNumber = offset + 1
    if (heredocEnd !== undefined) {
      result.push([lineNumber, line])
      const check = isHeredocDash ? line.replace(/^\t+/u, '') : line
      if (check === heredocEnd) heredocEnd = undefined
      continue
    }
    if (quote !== undefined) {
      result.push([lineNumber, line])
      quote = scanQuotes(line, quote)
      continue
    }
    if (line.trimStart().startsWith('#')) continue
    result.push([lineNumber, line])
    const groups = HEREDOC_START.exec(line)?.groups
    if (groups === undefined) {
      quote = scanQuotes(line, undefined)
      continue
    }
    isHeredocDash = groups['dash'] === '-'
    heredocEnd = groups['terminator']
  }
  return result
}

function mdLines(text: string): NumberedLine[] {
  const result: NumberedLine[] = []
  let isInComment = false
  for (const [offset, line] of splitLines(text).entries()) {
    let rest = line
    let kept = ''
    while (rest !== '') {
      if (isInComment) {
        const end = rest.indexOf('-->')
        if (end === -1) {
          rest = ''
        }
        else {
          isInComment = false
          rest = rest.slice(end + 3)
        }
      }
      else {
        const start = rest.indexOf('<!--')
        if (start === -1) {
          kept += rest
          rest = ''
        }
        else {
          kept += rest.slice(0, start)
          isInComment = true
          rest = rest.slice(start + 4)
        }
      }
    }
    if (kept.trim() !== '') result.push([offset + 1, kept])
  }
  return result
}

function targets(): string[] {
  const scripts = globSync('**/*.sh', { cwd: hooksDirectory })
    .filter((relative) => {
      const parts = relative.split('/')
      return parts[0] !== 'tests' && !(parts[0] === 'lib' && parts[1] === 'tests')
    })
    .toSorted(comparePathParts)
  const configs = globSync('hooks*.json', { cwd: hooksDirectory }).toSorted(compareStrings)
  const templates = globSync('templates/*.md', { cwd: hooksDirectory }).toSorted(compareStrings)
  return [...scripts, ...configs, ...templates]
}

function violations(): string[] {
  const found: string[] = []
  for (const relative of targets()) {
    const text = readFileSync(path.join(hooksDirectory, relative), 'utf8')
    let lines: readonly NumberedLine[]
    if (relative.endsWith('.sh')) lines = shLines(text)
    else if (relative.endsWith('.md')) lines = mdLines(text)
    else lines = splitLines(text).map((line, offset): NumberedLine => [offset + 1, line])
    for (const [lineNumber, line] of lines) {
      const isExempt = EXEMPT.some(([file, content]) => file === relative && content === line.trim())
      if (!isExempt && hasJapanese(line)) found.push(`${relative}:${String(lineNumber)}: ${line.trim()}`)
    }
  }
  return found
}

describe('hooks がエージェントへ返す文言', () => {
  it('走査の対象に、代表的なスクリプト・設定・テンプレが含まれる', () => {
    const names = new Set(targets().map(relative => path.basename(relative)))
    expect(names.has('gh-command-check.sh')).toBe(true)
    expect(names.has('hooks.json')).toBe(true)
    expect(names.has('exit-plan-comment-update.md')).toBe(true)
  })

  it('コメントの判定は、heredoc と複数行の引用符の中を本文として扱う', () => {
    const sh = '# 日本語\necho a # 日本語\ncat <<EOF\n# 日本語\nEOF\nx="a\n# 日本語"\n'
    expect(shLines(sh).map(([lineNumber]) => lineNumber)).toEqual([2, 3, 4, 5, 6, 7])
    expect(mdLines('<!-- 日本語 -->\n# 見出し\n')).toEqual([[2, '# 見出し']])
  })

  it('日本語を含む行が無い', () => {
    const found = violations()
    expect(found, `${String(found.length)} lines contain Japanese:\n${found.join('\n')}`).toEqual([])
  })
})

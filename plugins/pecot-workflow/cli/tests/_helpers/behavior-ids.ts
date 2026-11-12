/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは呼び出し側が渡す root の配下だけ */
// 振る舞いの項目の ID を、vitest の verifies の呼び出しの引数から集める。コメントの中の ID は数えない。
import { globSync, readFileSync } from 'node:fs'

import { compareText } from '../../../../../libs/interface-spec/src/domain/utility.js'

const ID = /(?<![\w\-])PW-[A-Z0-9\-]+-\d{2}(?![\w\-])/gv
// 2 つ目の引数が文字列のリテラルでない verifies の呼び出し
const DYNAMIC_CALL = /verifies\([^,\(\)]+,(?!\s*['"`])/v
const LITERAL_CALL = /verifies\([^,\(\)]+,\s*['"`](?<id>[^'"`]+)['"`]/gv

export const TEST_GLOBS = ['tests/**/*.ts', 'src/**/tests/**/*.ts']

const QUOTES = new Set(['\'', '"', '`'])

// 文字列の外の // と /* */ を消す。文字列の中の // と /* はそのまま残す
export function stripComments(text: string): string {
  let result = ''
  let quote = ''
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    const pair = text.slice(index, index + 2)
    if (quote !== '') {
      const step = char === '\\' ? 2 : 1
      result += text.slice(index, index + step)
      index += step
      if (char === quote) quote = ''
    }
    else if (pair === '//') {
      index = text.indexOf('\n', index)
      if (index === -1) index = text.length
    }
    else if (pair === '/*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
    }
    else {
      if (QUOTES.has(char)) quote = char
      result += char
      index += 1
    }
  }
  return result
}

/**
root の配下で、include のどれかに当たるテストのファイルから、数える ID を集める。tests/parity は数えない
*/
export function collectVerifiedIds(root: string, include: readonly string[]): Set<string> {
  const included = new Set(globSync([...include], { cwd: root }))
  const ids = new Set<string>()
  const candidates = globSync(TEST_GLOBS, { cwd: root })
  for (const file of candidates) {
    if (file.startsWith('tests/parity/') || !included.has(file)) continue
    const code = stripComments(readFileSync(`${root}/${file}`, 'utf8'))
    const pattern = DYNAMIC_CALL.test(code) ? ID : LITERAL_CALL
    const matches = code.matchAll(pattern)
    for (const match of matches) ids.add(match.groups?.['id'] ?? match[0])
  }
  return ids
}

export function missingIds(expected: Iterable<string>, verified: ReadonlySet<string>): string[] {
  return [...new Set(expected)].filter(id => !verified.has(id)).toSorted(compareText)
}

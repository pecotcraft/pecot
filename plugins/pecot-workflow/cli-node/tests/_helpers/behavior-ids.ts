/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは呼び出し側が渡す root の配下だけ */
// 振る舞いの項目の ID を、vitest の verifies の呼び出しの引数から集める。コメントの中の ID は数えない。
import { globSync, readFileSync } from 'node:fs'

import { compareText } from '../../../../../libs/interface-spec/src/domain/utility.js'

const ID = /PW-[A-Z0-9\-]+-\d{2}/gv
// 2 つ目の引数が文字列のリテラルでない verifies の呼び出し
const DYNAMIC_CALL = /verifies\([^,\(\)]+,\s*(?!['"`])/v
const LITERAL_CALL = /verifies\([^,\(\)]+,\s*['"`](?<id>[^'"`]+)['"`]/gv

export const TEST_GLOBS = ['tests/**/*.ts', 'src/**/tests/**/*.ts']

export function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//gv, '').replaceAll(/(?:^|\s)\/\/.*$/gmv, '')
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

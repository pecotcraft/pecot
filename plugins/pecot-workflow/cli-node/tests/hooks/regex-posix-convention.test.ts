/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下のみ */
// hooks の `[[ =~ ]]` 用 ERE で、glibc 拡張の \s・\S を使っていないことの静的な確認。
// 例外は grep の -P（PCRE）と jq の test 関数（Oniguruma）の行だけ。走査はコメントを除いたコード行に対して行う。
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { hooksDirectory } from './_helpers/paths.js'
import { codeLines } from './_helpers/script-references.js'
import { comparePathParts } from './_helpers/text.js'

const scripts = [...globSync('*.sh', { cwd: hooksDirectory }), ...globSync('lib/**/*.sh', { cwd: hooksDirectory })]
  .filter(relative => !relative.split('/').includes('tests'))
  .toSorted(comparePathParts)

const GNU_CLASS = /\\[sS]/u
const PCRE_GREP = /\bgrep\b[^|]*\s-[A-Za-z]*P/u
const JQ_TEST = /\btest\(/u

function isExempt(line: string): boolean {
  return PCRE_GREP.test(line) || JQ_TEST.test(line)
}

function offending(lines: readonly string[]): string[] {
  return lines.filter(line => GNU_CLASS.test(line) && !isExempt(line)).map(line => line.trim())
}

describe('hooks の ERE の記法の規約', () => {
  it('走査するスクリプトを下限以上の数で列挙できる', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(57)
  })

  it.for(scripts.map(label => ({ label })))('$label のコード行に glibc 拡張の \\s・\\S は無い', (row) => {
    const text = readFileSync(path.join(hooksDirectory, row.label), 'utf8')
    const found = offending(codeLines(text))
    expect(found, `${row.label}: glibc 拡張の空白クラスがあります。[[ =~ ]] の ERE には POSIX の [[:space:]]・[^[:space:]] を使ってください`).toEqual([])
  })

  it('検出は glibc 拡張を拾い、POSIX の記法と PCRE・jq の行は拾わない', () => {
    expect(offending([String.raw`P='git\s+commit'`])).toEqual([String.raw`P='git\s+commit'`])
    expect(offending([String.raw`P='-C\s+\S+'`])).toEqual([String.raw`P='-C\s+\S+'`])
    expect(offending(['P=\'git[[:space:]]+commit\''])).toEqual([])
    expect(offending([String.raw`S=$(grep -m1 -oP '"slug":\s*"\K[^"]+' "$F")`])).toEqual([])
    expect(offending([String.raw`| select(test("^\\s*Implement"))`])).toEqual([])
  })
})

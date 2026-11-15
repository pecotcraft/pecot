/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはリポ内の固定のパスのみ */
// 視点の印の集合が、review-findings テンプレ・w-reviewer.md・w-revise の 3 箇所で一致することの固定。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { projectRoot } from './_helpers/paths.js'
import { compareStrings } from '../parity/baseline.js'

const SOURCES: readonly string[] = [
  'plugins/pecot-workflow/cli/templates/comment/review-findings.md',
  'plugins/pecot-workflow/agents/w-reviewer.md',
  'plugins/pecot-workflow/skills/w-revise/SKILL.md',
]
const EXPECTED = '[cuj] [quality] [tech]'

// バッククォートで囲んだ `[小文字]` の印を、重複を除いて並べる。
function marksOf(text: string): string {
  const marks = new Set(Array.from(text.matchAll(/`(\[[a-z]+\])`/gu), match => match[1] ?? ''))
  return [...marks].toSorted(compareStrings).join(' ')
}

describe('視点の印', () => {
  it('配布物の 3 箇所で、印の集合が一致する', () => {
    const found = new Map<string, string>()
    for (const relative of SOURCES) {
      const file = path.join(projectRoot, relative)
      expect(existsSync(file), `印の複製先が移動している: ${relative}`).toBe(true)
      found.set(relative, marksOf(readFileSync(file, 'utf8')))
    }
    const joined = [...found].map(([relative, marks]) => `${relative}: ${marks}`).join('\n')
    for (const marks of found.values()) expect(marks, `視点の印が 3 箇所で一致していない:\n${joined}`).toBe(EXPECTED)
  })

  it('w-reviewer.md の視点の節の見出しは、印の集合と一致する', () => {
    const text = readFileSync(path.join(projectRoot, 'plugins/pecot-workflow/agents/w-reviewer.md'), 'utf8')
    const headings = Array.from(text.matchAll(/^## (\[[a-z]+\]) /gmu), match => match[1] ?? '')
    expect(headings.toSorted(compareStrings).join(' ')).toBe(EXPECTED)
  })
})

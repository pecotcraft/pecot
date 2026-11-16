/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはリポジトリ内の定義ファイルのみ */
// SKILL.md・agents/*.md の frontmatter を読む補助。frontmatter は YAML 1.1 で読む。
import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { expect } from 'vitest'

import { splitLines } from '../../hooks/_helpers/text.js'

export function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('マッピングではありません')
  return Object.fromEntries(Object.entries(value))
}

// 先頭の ---〜--- を YAML 1.1 で読む。重複キーは許す。
export function frontmatter(file: string): Readonly<Record<string, unknown>> {
  const lines = splitLines(readFileSync(file, 'utf8'))
  expect(lines.at(0), `${file}: frontmatter が無い`).toBe('---')
  const end = lines.indexOf('---', 1)
  expect(end, `${file}: frontmatter の閉じの --- が無い`).toBeGreaterThan(0)
  const data: unknown = parse(lines.slice(1, end).join('\n'), { version: '1.1', uniqueKeys: false })
  return asRecord(data)
}

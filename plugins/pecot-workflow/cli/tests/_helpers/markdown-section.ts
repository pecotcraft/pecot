// 説明の Markdown から、見出し 1 つの節を切り出す。
import { expect } from 'vitest'

/**
`heading`（`## 名前` などの見出しの行）の次の行から、次の `## `・`### ` の見出しの手前までを返す。見出しが無ければテストを落とす
*/
export function markdownSection(document: string, heading: string): string {
  const start = document.indexOf(`\n${heading}\n`)
  expect(start, `${heading} が文書に無い`).toBeGreaterThanOrEqual(0)
  const rest = document.slice(start + heading.length + 2)
  const next = rest.search(/^#{2,3} /m)
  return next === -1 ? rest : rest.slice(0, next)
}

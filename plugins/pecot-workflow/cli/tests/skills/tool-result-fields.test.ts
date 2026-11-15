// スキルが MCP ツールの結果を、文や行ではなく data の項目で読ませていることを確かめる。
// 結果に stdout・stderr は無く、結果の行（created: など）も data の項目に移った。
import { describe, expect, it } from 'vitest'

import { readDocuments } from './_helpers/documents.js'

/**
結果の文や行を読ませる書き方。stdout・stderr の名前、結果の行の前置き、CLI の表示の節の見出し
*/
const RESULT_TEXT_PATTERNS: readonly RegExp[] = [
  /\bstdout\b/u,
  /\bstderr\b/u,
  /`(?:created|closed|added|moved|set|skipped|landed|warning|error):/u,
  /`=== /u,
  /Registered repositories|Roadmap repo:|`Parent:`|`Sub-issues:`|Current directory name:/u,
  /出力されたファイル/u,
]

/**
MCP ツールの結果ではない出力を読ませる行。ファイルと、行が含む語で指す
*/
const ALLOWED: readonly { readonly file: string, readonly marker: string, readonly reason: string }[] = [
  { file: 'skills/w-help/references/board-sync-workflow.md', marker: 'ログの `moved:`・`set:`', reason: 'GitHub Actions の実行のログ' },
  { file: 'skills/w-release/references/release-nx.md', marker: '`preflight.log` に `warning:`', reason: 'release.yml の artifact のログ' },
  { file: 'skills/w-release/references/release-nx.md', marker: '`warning: could not check Dependabot alerts` が出たとき', reason: 'release.yml の artifact のログ' },
  { file: 'skills/w-release/references/release-nx.md', marker: '`landed: ... (merged <SHA>)`', reason: 'release.yml の artifact の summary.md' },
  { file: 'skills/w-release/references/release-nx-recovery.md', marker: 'land のログに `landed:` の行', reason: 'release.yml の実行のログ' },
  { file: 'skills/w-release/references/release-nx-recovery.md', marker: 'ログに `error:` の行がある', reason: 'release.yml の実行のログ' },
  { file: 'skills/w-release/references/release-nx-recovery.md', marker: '`error:` の行と一時ブランチの名前', reason: 'release.yml の実行のログ' },
]

function isAllowed(file: string, line: string): boolean {
  return ALLOWED.some(entry => entry.file === file && line.includes(entry.marker))
}

describe('ツールの結果の読み方', () => {
  it('スキルが MCP ツールの結果を読ませるときは、stdout・stderr や結果の行ではなく data の項目で読ませる', () => {
    const found = readDocuments().flatMap(({ file, text }) => text.split('\n')
      .map((line, index) => ({ file, number: index + 1, line }))
      .filter(({ line }) => RESULT_TEXT_PATTERNS.some(pattern => pattern.test(line)) && !isAllowed(file, line))
      .map(({ number, line }) => `${file}:${String(number)}: ${line.trim()}`))
    expect(found).toEqual([])
  })

  it('許可の一覧の行は、今も本文にある', () => {
    const texts = new Map(readDocuments().map(({ file, text }) => [file, text]))
    const stale = ALLOWED.filter(entry => texts.get(entry.file)?.includes(entry.marker) !== true).map(entry => `${entry.file}: ${entry.marker}`)
    expect(stale).toEqual([])
  })
})

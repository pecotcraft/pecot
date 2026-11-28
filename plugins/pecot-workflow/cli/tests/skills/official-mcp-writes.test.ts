// スキルが GitHub の公式の MCP で書くとき、先に通すチェックのツールを名指しし、
// 公式のツールの基本の使い方を書かないことを確かめる（FR-015）。
import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { readDocuments } from './_helpers/documents.js'

// 書く公式のツールと、その前に通すチェックのツール。前提は、作成と一緒なら issue_check が見る
const WRITE_CHECKS: readonly (readonly [string, readonly string[]])[] = [
  ['issue_write', ['issue_check']],
  ['issue_dependency_write', ['issue_dependency_check', 'issue_check']],
  ['add_issue_comment', ['issue_comment_check']],
  ['update_issue_comment', ['issue_comment_check']],
]

// Issue を作るスキル。手順は w-help の github-write.md に置き、そこへつなぐ
const ISSUE_SKILLS = ['w-ready', 'w-quick', 'w-backlog', 'w-issueize', 'w-breakdown']

// 公式のツールの基本の使い方（ページ送り・出力の絞り）を表す語
const BASIC_USAGE = /\b(?:per_page|perPage|pageInfo|minimal_output|hasNextPage)\b/u

const documents = readDocuments().filter(document => document.file.startsWith('skills/'))

describe('公式の MCP で書く手順', () => {
  it.each(documents.map(document => [document.file, document.text]))('%s が書く公式のツールごとに、先に通すチェックのツールを名指しする', async (_file, text) => {
    await explains('スキルの本文のテストです。公式の MCP の書き込みのツールを名指しする文書が、その前に通す pecot-workflow のチェックのツールも名指ししていることを確認します。')
    const missing = WRITE_CHECKS
      .filter(([write, checks]) => text.includes(`\`${write}\``) && checks.every(check => !text.includes(`\`${check}\``)))
      .map(([write, checks]) => `${write} needs ${checks.join(' or ')}`)
    expect(missing).toEqual([])
  })

  it.each(ISSUE_SKILLS)('%s が、Issue を書く手順として github-write.md を参照する', async (skill) => {
    await explains('Issue を作るスキルのテストです。`SKILL.md` が、公式の MCP で書く手順をまとめた `github-write.md` を参照していることを確認します。')
    const document = documents.find(entry => entry.file === `skills/${skill}/SKILL.md`)
    expect(document?.text).toContain('../w-help/references/github-write.md')
  })

  it.each(documents.map(document => [document.file, document.text]))('%s が、公式のツールのページ送りや出力の絞りを書かない', async (_file, text) => {
    await explains('スキルの本文のテストです。公式の MCP のツールの基本の使い方（ページ送り・出力の絞り）を書いていないことを確認します。使い方はツールの定義が示します。')
    expect(text).not.toMatch(BASIC_USAGE)
  })
})

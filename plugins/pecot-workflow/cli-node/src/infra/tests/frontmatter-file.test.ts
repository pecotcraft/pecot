/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { FrontmatterError } from '../../domain/frontmatter.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { parseCommentFile, parseIssueFile, parsePullRequestFile } from '../frontmatter-file.js'
import { OsError } from '../os-error.js'

function writeFile(name: string, content: string): string {
  const file = path.join(makeTemporaryDirectory(), name)
  writeFileSync(file, content, 'utf8')
  return file
}

describe('parseIssueFile', () => {
  it('ファイルからパース', () => {
    const file = writeFile('issue.md', `---
title: ファイルからのテスト
type: task
repository: owner/repo
status: ready
---

## タスク概要

ファイルから読み込んだ本文。
`)
    const result = parseIssueFile(file)
    expect(result.frontmatter.title).toBe('ファイルからのテスト')
    expect(result.frontmatter.type).toBe('task')
    expect(result.frontmatter.status).toBe('ready')
    expect(result.body).toContain('## タスク概要')
  })

  it('CRLF のファイルも読める', () => {
    const file = writeFile('issue.md', '---\r\ntitle: T\r\ntype: task\r\nrepository: o/r\r\nstatus: ready\r\n---\r\n\r\n本文\r\n')
    expect(parseIssueFile(file).body).toBe('本文')
  })

  it('存在しないファイルはエラー', () => {
    const file = path.join(makeTemporaryDirectory(), 'nonexistent.md')
    expect(() => parseIssueFile(file)).toThrow(FrontmatterError)
    expect(() => parseIssueFile(file)).toThrow(`ファイルが見つかりません: ${file}`)
  })

  it('エラー文のパスは Python の Path と同じ書き方（重複した / と . を畳む）', () => {
    expect(() => parseIssueFile('./no-such//dir/./x.md')).toThrow('ファイルが見つかりません: no-such/dir/x.md')
    expect(() => parseIssueFile('/no-such-pecot//x.md')).toThrow('ファイルが見つかりません: /no-such-pecot/x.md')
    expect(() => parseIssueFile('.')).toThrow(OsError)
  })

  it('ディレクトリは読めないので OsError', () => {
    const directory = path.join(makeTemporaryDirectory(), 'dir')
    mkdirSync(directory)
    expect(() => parseIssueFile(directory)).toThrow(OsError)
  })
})

describe('parseCommentFile', () => {
  it('ファイルからパース', () => {
    const file = writeFile('comment.md', `---
issue_ref: "owner/repo/123"
template: merge-diff
---

## 進捗報告

ファイルから読み込んだ本文。
`)
    const result = parseCommentFile(file)
    expect(result.frontmatter.issue_ref).toBe('owner/repo/123')
    expect(result.frontmatter.template).toBe('merge-diff')
    expect(result.body).toContain('## 進捗報告')
  })

  it('存在しないファイルはエラー', () => {
    expect(() => parseCommentFile(path.join(makeTemporaryDirectory(), 'nonexistent.md'))).toThrow('ファイルが見つかりません')
  })
})

describe('parsePullRequestFile', () => {
  it('ファイルからパース', () => {
    const file = writeFile('pr.md', `---
title: "ファイルからのPR"
repository: "owner/repo"
base: "develop-aist"
head: "feat/test"
---

## Changed — テスト用本文

ファイルから読み込んだ本文。

Refs #42
`)
    const result = parsePullRequestFile(file)
    expect(result.frontmatter.title).toBe('ファイルからのPR')
    expect(result.frontmatter.repository).toBe('owner/repo')
    expect(result.frontmatter.base).toBe('develop-aist')
    expect(result.frontmatter.head).toBe('feat/test')
    expect(result.body).toContain('## Changed — テスト用本文')
    expect(result.body).toContain('Refs #42')
  })

  it('存在しないファイルはエラー', () => {
    expect(() => parsePullRequestFile(path.join(makeTemporaryDirectory(), 'nonexistent.md'))).toThrow('ファイルが見つかりません')
  })
})

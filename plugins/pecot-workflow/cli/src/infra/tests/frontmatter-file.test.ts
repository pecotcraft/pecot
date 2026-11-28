/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { FrontmatterError } from '@pecot/workflow-core/domain/frontmatter.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { parseIssueFile, parsePullRequestFile } from '../frontmatter-file.js'
import { OsError } from '@pecot/workflow-core/infra/os-error.js'

function writeFile(name: string, content: string): string {
  const file = path.join(makeTemporaryDirectory(), name)
  writeFileSync(file, content, 'utf8')
  return file
}

describe('parseIssueFile', () => {
  it('Issue のファイルを読むと、frontmatter と本文を返す', async () => {
    await explains('Issue のファイルを読み込む `parseIssueFile` のテストです。`title`・`type`・`status` を持つ frontmatter と、`## タスク概要` を含む本文を、分けて返すことを確認します。')
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

  it('CRLF の改行のファイルも読み込める', async () => {
    await explains('Issue のファイルを読み込む `parseIssueFile` のテストです。改行が CRLF のファイルでも、本文を `本文` として返すことを確認します。')
    const file = writeFile('issue.md', '---\r\ntitle: T\r\ntype: task\r\nrepository: o/r\r\nstatus: ready\r\n---\r\n\r\n本文\r\n')
    expect(parseIssueFile(file).body).toBe('本文')
  })

  it('Issue のファイルが存在しない場合は、FrontmatterError を送出する', async () => {
    await explains('存在しないパスを渡した場合の `parseIssueFile` のテストです。`FrontmatterError` が、`file not found: <パス>` のメッセージで発生することを確認します。')
    const file = path.join(makeTemporaryDirectory(), 'nonexistent.md')
    expect(() => parseIssueFile(file)).toThrow(FrontmatterError)
    expect(() => parseIssueFile(file)).toThrow(`file not found: ${file}`)
  })

  it('エラーメッセージのパスは、重複した / と . をまとめた形で表示する', async () => {
    await explains('存在しないパスを渡した場合の `parseIssueFile` のテストです。`./no-such//dir/./x.md` を渡した場合に、メッセージのパスが `no-such/dir/x.md` の形にまとめられ、`.` を渡した場合は `OsError` になることを確認します。')
    expect(() => parseIssueFile('./no-such//dir/./x.md')).toThrow('file not found: no-such/dir/x.md')
    expect(() => parseIssueFile('/no-such-pecot//x.md')).toThrow('file not found: /no-such-pecot/x.md')
    expect(() => parseIssueFile('.')).toThrow(OsError)
  })

  it('ディレクトリを渡した場合は、読み込めないため OsError を送出する', async () => {
    await explains('ディレクトリを渡した場合の `parseIssueFile` のテストです。ファイルとして読み込めないため、`OsError` が発生することを確認します。')
    const directory = path.join(makeTemporaryDirectory(), 'dir')
    mkdirSync(directory)
    expect(() => parseIssueFile(directory)).toThrow(OsError)
  })
})

describe('parsePullRequestFile', () => {
  it('PR のファイルを読むと、frontmatter と本文を返す', async () => {
    await explains('PR のファイルを読み込む `parsePullRequestFile` のテストです。`owner`・`repo`・`title`・`base`・`head` を持つ frontmatter と、`Refs #42` を含む本文を、分けて返すことを確認します。')
    const file = writeFile('pr.md', `---
title: "ファイルからのPR"
owner: "owner"
repo: "repo"
base: "develop-aist"
head: "feat/test"
---

## Changed — テスト用本文

ファイルから読み込んだ本文。

Refs #42
`)
    const result = parsePullRequestFile(file)
    expect(result.frontmatter.title).toBe('ファイルからのPR')
    expect(result.frontmatter.owner).toBe('owner')
    expect(result.frontmatter.repo).toBe('repo')
    expect(result.frontmatter.base).toBe('develop-aist')
    expect(result.frontmatter.head).toBe('feat/test')
    expect(result.body).toContain('## Changed — テスト用本文')
    expect(result.body).toContain('Refs #42')
  })

  it('PR のファイルが存在しない場合は、file not found のエラーにする', async () => {
    await explains('存在しないパスを渡した場合の `parsePullRequestFile` のテストです。`file not found` を含むメッセージで例外が発生することを確認します。')
    expect(() => parsePullRequestFile(path.join(makeTemporaryDirectory(), 'nonexistent.md'))).toThrow('file not found')
  })
})

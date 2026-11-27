// infra/slidev-theme/fs.ts の unit test。
// 「無い」と見なすのは ENOENT と ENOTDIR だけで、それ以外の失敗は呼び出し元へ投げ直す。

/* eslint-disable security/detect-non-literal-fs-filename -- 一時ディレクトリの組み立てのみ */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NodeThemeFiles } from '../fs.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const state = { root: '' }

beforeEach(() => {
  state.root = mkdtempSync(path.join(tmpdir(), 'pecotv-theme-fs-'))
})

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
})

describe('NodeThemeFiles', () => {
  it('readText は、存在しないファイルと、ファイルを親に持つパスの場合に undefined を返す', async () => {
    await explains('`NodeThemeFiles.readText` のテストです。存在しないファイルと、通常のファイルの配下を指すパスの場合に、例外ではなく `undefined` を返すことを確認します。')
    const files = new NodeThemeFiles()
    writeFileSync(path.join(state.root, 'file.txt'), 'x')
    expect(await files.readText(path.join(state.root, 'none.txt'))).toBeUndefined()
    expect(await files.readText(path.join(state.root, 'file.txt', 'child'))).toBeUndefined()
  })

  it('readText は、ENOENT と ENOTDIR 以外の失敗の場合に例外を発生させる', async () => {
    await explains('`NodeThemeFiles.readText` にディレクトリを渡した場合のテストです。`EISDIR` のエラーは握りつぶされず、例外が発生することを確認します。')
    // ディレクトリを読むと EISDIR になる
    mkdirSync(path.join(state.root, 'dir'))
    await expect(new NodeThemeFiles().readText(path.join(state.root, 'dir'))).rejects.toThrow()
  })

  it('listFiles は、ディレクトリを除いたファイル名を名前順で返し、存在しない場合は空の一覧を返す', async () => {
    await explains('`NodeThemeFiles.listFiles` のテストです。サブディレクトリを除いたファイル名が名前順に並び、存在しないパスとファイルを指すパスの場合は空の一覧を返すことを確認します。')
    const files = new NodeThemeFiles()
    mkdirSync(path.join(state.root, 'sub'))
    writeFileSync(path.join(state.root, 'b.txt'), '')
    writeFileSync(path.join(state.root, 'a.txt'), '')
    expect(await files.listFiles(state.root)).toEqual(['a.txt', 'b.txt'])
    expect(await files.listFiles(path.join(state.root, 'none'))).toEqual([])
    expect(await files.listFiles(path.join(state.root, 'a.txt'))).toEqual([])
  })

  it('listFiles は、ENOENT と ENOTDIR 以外の失敗の場合に例外を発生させる', async () => {
    await explains('`NodeThemeFiles.listFiles` に NUL 文字を含むパスを渡した場合のテストです。引数のエラーは握りつぶされず、例外が発生することを確認します。')
    // NUL を含むパスは、OS へ渡る前に引数エラーで弾かれる
    await expect(new NodeThemeFiles().listFiles('bad\0path')).rejects.toThrow()
  })
})

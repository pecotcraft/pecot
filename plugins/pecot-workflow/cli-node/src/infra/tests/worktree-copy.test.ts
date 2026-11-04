/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, lstatSync, readFileSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory, writeTree } from '../../tests/_helpers/temporary.js'
import { copyFiles } from '../worktree-copy.js'

useIsolatedEnvironment()

describe('copyFiles', () => {
  it('ファイルをコピーする。親ディレクトリも作る', () => {
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    writeTree(source, { 'a.txt': 'hello', 'sub/b.txt': 'world' })
    const results = copyFiles(source, destination, ['a.txt', 'sub/b.txt'])
    expect(results.map(result => result.action)).toEqual(['copied', 'copied'])
    expect(results[0]).toEqual({ source: path.join(source, 'a.txt'), dest: path.join(destination, 'a.txt'), action: 'copied', message: '' })
    expect(readFileSync(path.join(destination, 'a.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(path.join(destination, 'sub', 'b.txt'), 'utf8')).toBe('world')
  })

  it('ソースが無ければ skipped', () => {
    const results = copyFiles(makeTemporaryDirectory(), makeTemporaryDirectory(), ['missing.txt'])
    expect(results[0]).toMatchObject({ action: 'skipped', message: 'ソースファイルが存在しません' })
  })

  it('更新時刻と実行権限を保つ（shutil.copy2 と同じ）', () => {
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    writeTree(source, { 'run.sh': '#!/bin/sh\n' })
    chmodSync(path.join(source, 'run.sh'), 0o755)
    const past = new Date('2020-01-02T03:04:05Z')
    utimesSync(path.join(source, 'run.sh'), past, past)
    copyFiles(source, destination, ['run.sh'])
    const stat = statSync(path.join(destination, 'run.sh'))
    expect(stat.mtime.getTime()).toBe(past.getTime())
    expect(stat.mode & 0o777).toBe(0o755)
  })

  it('シンボリックリンクはリンク先の中身をコピーする', () => {
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    writeTree(source, { 'real.txt': 'content' })
    symlinkSync('real.txt', path.join(source, 'link.txt'))
    copyFiles(source, destination, ['link.txt'])
    expect(lstatSync(path.join(destination, 'link.txt')).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(destination, 'link.txt'), 'utf8')).toBe('content')
  })

  it('ディレクトリは中身ごとコピーする。既存のコピー先にも重ねる', () => {
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    writeTree(source, { 'dir/a.txt': 'new', 'dir/deep/b.txt': 'deep' })
    writeTree(destination, { 'dir/a.txt': 'old', 'dir/keep.txt': 'keep' })
    const results = copyFiles(source, destination, ['dir'])
    expect(results[0]?.action).toBe('copied')
    expect(readFileSync(path.join(destination, 'dir', 'a.txt'), 'utf8')).toBe('new')
    expect(readFileSync(path.join(destination, 'dir', 'deep', 'b.txt'), 'utf8')).toBe('deep')
    expect(readFileSync(path.join(destination, 'dir', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('OS のエラーは error として結果に載せ、続きをコピーする。message は Python の OSError と同じ文', () => {
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    writeTree(source, { 'blocked/a.txt': 'a', 'ok.txt': 'ok' })
    writeTree(destination, { blocked: 'i am a file' })
    const results = copyFiles(source, destination, ['blocked/a.txt', 'ok.txt'])
    expect(results[0]).toMatchObject({ action: 'error', message: `[Errno 17] File exists: '${path.join(destination, 'blocked')}'` })
    expect(results[1]?.action).toBe('copied')
  })

  it('更新時刻はミリ秒でなく、Python の copy2 に近い精度で写す', () => {
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    writeTree(source, { 'f.txt': 'x', 'dir/g.txt': 'y' })
    utimesSync(path.join(source, 'f.txt'), 1_600_000_000.123456, 1_600_000_000.987654)
    utimesSync(path.join(source, 'dir', 'g.txt'), 1_600_000_000.123456, 1_600_000_000.987654)
    copyFiles(source, destination, ['f.txt', 'dir'])
    for (const relative of ['f.txt', path.join('dir', 'g.txt')]) {
      const from = statSync(path.join(source, relative), { bigint: true })
      const to = statSync(path.join(destination, relative), { bigint: true })
      // 秒の小数で渡すため、最大でも 1 マイクロ秒の差に収まる
      expect(to.mtimeNs - from.mtimeNs).toBeLessThan(1000n)
      expect(from.mtimeNs - to.mtimeNs).toBeLessThan(1000n)
    }
  })

  it('ディレクトリの中にリンク切れの symlink があっても、残りを写し終えてからまとめてエラーにする', () => {
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    writeTree(source, { 'dir/a.txt': 'a', 'dir/z.txt': 'z' })
    symlinkSync('/nonexistent/target', path.join(source, 'dir', 'broken'))
    const results = copyFiles(source, destination, ['dir', 'dir/a.txt'])
    const broken = path.join(source, 'dir', 'broken')
    const target = path.join(destination, 'dir', 'broken')
    const reason = `"[Errno 2] No such file or directory: '${broken}'"`
    expect(results[0]).toMatchObject({ action: 'error', message: `[('${broken}', '${target}', ${reason})]` })
    expect(readFileSync(path.join(destination, 'dir', 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(path.join(destination, 'dir', 'z.txt'), 'utf8')).toBe('z')
    expect(results[1]?.action).toBe('copied')
  })

  it('入れ子のディレクトリのエラーも、1 つの一覧にまとまる', () => {
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    writeTree(source, { 'dir/sub/ok.txt': 'ok' })
    symlinkSync('/nonexistent/one', path.join(source, 'dir', 'one'))
    symlinkSync('/nonexistent/two', path.join(source, 'dir', 'sub', 'two'))
    const [result] = copyFiles(source, destination, ['dir'])
    expect(result?.action).toBe('error')
    expect(result?.message.startsWith('[(')).toBe(true)
    expect(result?.message).toContain(path.join(source, 'dir', 'one'))
    expect(result?.message).toContain(path.join(source, 'dir', 'sub', 'two'))
    expect(readFileSync(path.join(destination, 'dir', 'sub', 'ok.txt'), 'utf8')).toBe('ok')
  })
})

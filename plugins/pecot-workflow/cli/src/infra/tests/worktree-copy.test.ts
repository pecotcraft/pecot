/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { chmodSync, lstatSync, readFileSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory, writeTree } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { copyFiles } from '../worktree-copy.js'

useIsolatedEnvironment()

describe('copyFiles', () => {
  it('ファイルをコピーし、コピー先の親ディレクトリも作成する', async () => {
    await explains('ファイルをコピーする `copyFiles` のテストです。`a.txt` と `sub/b.txt` を指定した場合に、どちらも `copied` として結果に含まれ、コピー先に同じ内容のファイルが作成されることを確認します。')
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    stepSync('コピー元にファイルを置く', () => {
      writeTree(source, { 'a.txt': 'hello', 'sub/b.txt': 'world' })
    })
    const results = stepSync('ファイルをコピーする', () => copyFiles(source, destination, ['a.txt', 'sub/b.txt']))
    stepSync('結果とコピー先の内容を比べる', () => {
      expect(results.map(result => result.action)).toEqual(['copied', 'copied'])
      expect(results[0]).toEqual({ source: path.join(source, 'a.txt'), dest: path.join(destination, 'a.txt'), action: 'copied', message: '' })
      expect(readFileSync(path.join(destination, 'a.txt'), 'utf8')).toBe('hello')
      expect(readFileSync(path.join(destination, 'sub', 'b.txt'), 'utf8')).toBe('world')
    })
  })

  it('コピー元のファイルが存在しない場合は、skipped として結果に含める', async () => {
    await explains('ファイルをコピーする `copyFiles` のテストです。コピー元に存在しない `missing.txt` を指定した場合に、`skipped` と `source file does not exist` のメッセージを返すことを確認します。')
    const results = stepSync('存在しないファイルをコピーする', () => copyFiles(makeTemporaryDirectory(), makeTemporaryDirectory(), ['missing.txt']))
    stepSync('結果を比べる', () => {
      expect(results[0]).toMatchObject({ action: 'skipped', message: 'source file does not exist' })
    })
  })

  it('コピー先でも、更新時刻と実行権限を維持する（shutil.copy2 と同じ）', async () => {
    await explains('ファイルをコピーする `copyFiles` のテストです。更新時刻を過去に変え、実行権限（`755`）を付けたファイルをコピーした場合に、コピー先でも同じ更新時刻と権限になることを確認します。')
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    const past = new Date('2020-01-02T03:04:05Z')
    stepSync('実行権限と過去の更新時刻を持つファイルを置く', () => {
      writeTree(source, { 'run.sh': '#!/bin/sh\n' })
      chmodSync(path.join(source, 'run.sh'), 0o755)
      utimesSync(path.join(source, 'run.sh'), past, past)
    })
    stepSync('ファイルをコピーする', () => copyFiles(source, destination, ['run.sh']))
    stepSync('コピー先の更新時刻と権限を比べる', () => {
      const stat = statSync(path.join(destination, 'run.sh'))
      expect(stat.mtime.getTime()).toBe(past.getTime())
      expect(stat.mode & 0o777).toBe(0o755)
    })
  })

  it('シンボリックリンクは、リンク先の内容をコピーする', async () => {
    await explains('ファイルをコピーする `copyFiles` のテストです。シンボリックリンクを指定した場合に、コピー先はシンボリックリンクではなく通常のファイルとなり、リンク先と同じ内容になることを確認します。')
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    stepSync('ファイルとそのシンボリックリンクを置く', () => {
      writeTree(source, { 'real.txt': 'content' })
      symlinkSync('real.txt', path.join(source, 'link.txt'))
    })
    stepSync('シンボリックリンクをコピーする', () => copyFiles(source, destination, ['link.txt']))
    stepSync('コピー先が通常のファイルで内容が同じことを比べる', () => {
      expect(lstatSync(path.join(destination, 'link.txt')).isSymbolicLink()).toBe(false)
      expect(readFileSync(path.join(destination, 'link.txt'), 'utf8')).toBe('content')
    })
  })

  it('ディレクトリは中身ごとコピーし、コピー先に既存のディレクトリがある場合は上書きして統合する', async () => {
    await explains('ディレクトリをコピーする `copyFiles` のテストです。コピー先に同名のディレクトリが存在する場合に、同名のファイルは上書きし、コピー元に存在しない既存のファイルは残すことを確認します。')
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    stepSync('コピー元とコピー先にディレクトリを置く', () => {
      writeTree(source, { 'dir/a.txt': 'new', 'dir/deep/b.txt': 'deep' })
      writeTree(destination, { 'dir/a.txt': 'old', 'dir/keep.txt': 'keep' })
    })
    const results = stepSync('ディレクトリをコピーする', () => copyFiles(source, destination, ['dir']))
    stepSync('結果とコピー先の内容を比べる', () => {
      expect(results[0]?.action).toBe('copied')
      expect(readFileSync(path.join(destination, 'dir', 'a.txt'), 'utf8')).toBe('new')
      expect(readFileSync(path.join(destination, 'dir', 'deep', 'b.txt'), 'utf8')).toBe('deep')
      expect(readFileSync(path.join(destination, 'dir', 'keep.txt'), 'utf8')).toBe('keep')
    })
  })

  it('OS のエラーは error として結果に含め、残りのファイルのコピーを続ける。メッセージは Python の OSError と同じ文にする', async () => {
    await explains('ファイルをコピーする `copyFiles` のテストです。コピー先の親がファイルでコピーできない場合は、`error` と `[Errno 17] File exists` のメッセージを返し、後続の `ok.txt` は `copied` になることを確認します。')
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    stepSync('コピー先の親がファイルになる状態を作る', () => {
      writeTree(source, { 'blocked/a.txt': 'a', 'ok.txt': 'ok' })
      writeTree(destination, { blocked: 'i am a file' })
    })
    const results = stepSync('2 つのファイルをコピーする', () => copyFiles(source, destination, ['blocked/a.txt', 'ok.txt']))
    stepSync('結果を比べる', () => {
      expect(results[0]).toMatchObject({ action: 'error', message: `[Errno 17] File exists: '${path.join(destination, 'blocked')}'` })
      expect(results[1]?.action).toBe('copied')
    })
  })

  it('更新時刻はミリ秒ではなく、Python の copy2 に近い精度でコピーする', async () => {
    await explains('ファイルとディレクトリをコピーする `copyFiles` のテストです。小数秒の更新時刻を持つファイルをコピーした場合に、コピー先との更新時刻の差が 1 マイクロ秒未満になることを確認します。')
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    stepSync('小数秒の更新時刻を持つファイルを置く', () => {
      writeTree(source, { 'f.txt': 'x', 'dir/g.txt': 'y' })
      utimesSync(path.join(source, 'f.txt'), 1_600_000_000.123456, 1_600_000_000.987654)
      utimesSync(path.join(source, 'dir', 'g.txt'), 1_600_000_000.123456, 1_600_000_000.987654)
    })
    stepSync('ファイルとディレクトリをコピーする', () => copyFiles(source, destination, ['f.txt', 'dir']))
    stepSync('更新時刻の差を比べる', () => {
      for (const relative of ['f.txt', path.join('dir', 'g.txt')]) {
        const from = statSync(path.join(source, relative), { bigint: true })
        const to = statSync(path.join(destination, relative), { bigint: true })
        // 秒の小数で渡すため、最大でも 1 マイクロ秒の差に収まる
        expect(to.mtimeNs - from.mtimeNs).toBeLessThan(1000n)
        expect(from.mtimeNs - to.mtimeNs).toBeLessThan(1000n)
      }
    })
  })

  it('ディレクトリ内にリンク切れのシンボリックリンクがある場合は、残りをコピーしてから、まとめてエラーにする', async () => {
    await explains('ディレクトリをコピーする `copyFiles` のテストです。リンク切れのシンボリックリンクを含む場合に、ほかのファイルはコピーされ、結果は `error` と Python 形式のエラーの一覧になることを確認します。')
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    stepSync('リンク切れのシンボリックリンクを含むディレクトリを置く', () => {
      writeTree(source, { 'dir/a.txt': 'a', 'dir/z.txt': 'z' })
      symlinkSync('/nonexistent/target', path.join(source, 'dir', 'broken'))
    })
    const results = stepSync('ディレクトリとファイルをコピーする', () => copyFiles(source, destination, ['dir', 'dir/a.txt']))
    const broken = path.join(source, 'dir', 'broken')
    const target = path.join(destination, 'dir', 'broken')
    const reason = `"[Errno 2] No such file or directory: '${broken}'"`
    stepSync('結果とコピー先の内容を比べる', () => {
      expect(results[0]).toMatchObject({ action: 'error', message: `[('${broken}', '${target}', ${reason})]` })
      expect(readFileSync(path.join(destination, 'dir', 'a.txt'), 'utf8')).toBe('a')
      expect(readFileSync(path.join(destination, 'dir', 'z.txt'), 'utf8')).toBe('z')
      expect(results[1]?.action).toBe('copied')
    })
  })

  it('入れ子のディレクトリで発生したエラーも、1 つの一覧にまとめる', async () => {
    await explains('ディレクトリをコピーする `copyFiles` のテストです。`dir` と `dir/sub` の両方にリンク切れのシンボリックリンクがある場合に、2 件のエラーが 1 つのメッセージに含まれ、正常なファイルはコピーされることを確認します。')
    const source = makeTemporaryDirectory()
    const destination = makeTemporaryDirectory()
    stepSync('入れ子の 2 か所にリンク切れのシンボリックリンクを置く', () => {
      writeTree(source, { 'dir/sub/ok.txt': 'ok' })
      symlinkSync('/nonexistent/one', path.join(source, 'dir', 'one'))
      symlinkSync('/nonexistent/two', path.join(source, 'dir', 'sub', 'two'))
    })
    const [result] = stepSync('ディレクトリをコピーする', () => copyFiles(source, destination, ['dir']))
    stepSync('結果とコピー先の内容を比べる', () => {
      expect(result?.action).toBe('error')
      expect(result?.message.startsWith('[(')).toBe(true)
      expect(result?.message).toContain(path.join(source, 'dir', 'one'))
      expect(result?.message).toContain(path.join(source, 'dir', 'sub', 'two'))
      expect(readFileSync(path.join(destination, 'dir', 'sub', 'ok.txt'), 'utf8')).toBe('ok')
    })
  })
})

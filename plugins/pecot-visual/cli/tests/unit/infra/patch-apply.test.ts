// infra/_shared/patch-apply.ts の unit test。
// 実 patch-package で当てる場合は runtime-install と store の test が見る。
// ここは、読み取りと解決の失敗、パッチ名の読み方といった、実プロセスを起こさない分岐を固定する。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp の一時ディレクトリ配下だけ */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { applyPatches, scanPatchDigests } from '../../../src/infra/_shared/patch-apply.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

const temporaryRoot = useTemporaryDirectory('pecotv-patch-apply-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('scanPatchDigests', () => {
  it('サブディレクトリのパッチも相対パス順に拾う', () => {
    mkdirSync(temporaryRoot('patches', 'nested'), { recursive: true })
    writeFileSync(temporaryRoot('patches', 'b+1.0.0.patch'), 'b', 'utf8')
    writeFileSync(temporaryRoot('patches', 'nested', 'a+1.0.0.patch'), 'a', 'utf8')
    writeFileSync(temporaryRoot('patches', 'note.txt'), 'x', 'utf8')

    expect(scanPatchDigests(temporaryRoot('patches')).digests.map(digest => digest.file)).toEqual(['b+1.0.0.patch', 'nested/a+1.0.0.patch'])
  })

  it('patches が無ければ空で、エラーにしない', () => {
    expect(scanPatchDigests(temporaryRoot('missing'))).toEqual({ digests: [], error: undefined })
  })

  it.skipIf(process.getuid?.() === 0)('パッチファイルを読めなければ、理由を返して空にする', () => {
    mkdirSync(temporaryRoot('patches'), { recursive: true })
    writeFileSync(temporaryRoot('patches', 'a+1.0.0.patch'), 'a', { mode: 0o000 })

    const scan = scanPatchDigests(temporaryRoot('patches'))
    expect(scan.digests).toEqual([])
    expect(scan.error).toContain('cannot read the patch file')
  })
})

describe('applyPatches', () => {
  it('当てるパッチが無ければ何もしない', async () => {
    await expect(applyPatches({
      root: temporaryRoot(),
      patchesDirectory: temporaryRoot('patches'),
      patches: [],
      patchPackageEntry: 'unused',
      lockPath: undefined,
    })).resolves.toBeUndefined()
  })

  it('基準パスを解決できなければ、起動せずに失敗を返す', async () => {
    const result = await applyPatches({
      root: temporaryRoot(),
      patchesDirectory: temporaryRoot('missing-patches'),
      patches: [{ file: 'a+1.0.0.patch', hash: 'h' }],
      patchPackageEntry: 'unused',
      lockPath: undefined,
    })
    expect(result).toMatchObject({ timedOut: false, stdout: '' })
    expect(result?.exitCode).toBeNull()
    expect(result?.stderr).toContain('cannot resolve the base path for applying patches')
    expect(result?.stderr).toContain('missing-patches')
  })

  it('root が無いときも、root を名指しして失敗する', async () => {
    mkdirSync(temporaryRoot('patches'), { recursive: true })
    const result = await applyPatches({
      root: temporaryRoot('missing-root'),
      patchesDirectory: temporaryRoot('patches'),
      patches: [{ file: 'a+1.0.0.patch', hash: 'h' }],
      patchPackageEntry: 'unused',
      lockPath: undefined,
    })
    expect(result?.stderr).toContain('missing-root')
  })
})

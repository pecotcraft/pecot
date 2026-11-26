// infra/_shared/patch-apply.ts の unit test。
// 実 patch-package で当てる場合は runtime-install と store の test が見る。
// ここは、読み取りと解決の失敗、パッチ名の読み方といった、実プロセスを起こさない分岐を固定する。

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは mkdtemp の一時ディレクトリ配下だけ */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { applyPatches, scanPatchDigests } from '../../../src/infra/_shared/patch-apply.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

const temporaryRoot = useTemporaryDirectory('pecotv-patch-apply-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

describe('scanPatchDigests', () => {
  it('サブディレクトリの中のパッチも、相対パスの順に集める', async () => {
    await explains('パッチのハッシュを集める `scanPatchDigests` のテストです。`patches/` の直下とサブディレクトリにある `.patch` ファイルを、相対パスの順に返し、`.patch` ではないファイルは含めないことを確認します。')
    mkdirSync(temporaryRoot('patches', 'nested'), { recursive: true })
    writeFileSync(temporaryRoot('patches', 'b+1.0.0.patch'), 'b', 'utf8')
    writeFileSync(temporaryRoot('patches', 'nested', 'a+1.0.0.patch'), 'a', 'utf8')
    writeFileSync(temporaryRoot('patches', 'note.txt'), 'x', 'utf8')

    expect(scanPatchDigests(temporaryRoot('patches')).digests.map(digest => digest.file)).toEqual(['b+1.0.0.patch', 'nested/a+1.0.0.patch'])
  })

  it('patches ディレクトリが存在しなければ、空の結果を返し、エラーにしない', async () => {
    await explains('`scanPatchDigests` のテストです。存在しない `patches` を渡した場合に、`digests` が空で `error` が `undefined` の結果を返すことを確認します。')
    expect(scanPatchDigests(temporaryRoot('missing'))).toEqual({ digests: [], error: undefined })
  })

  it.skipIf(process.getuid?.() === 0)('パッチファイルを読み取れなければ、理由を返して、結果を空にする', async () => {
    await explains('`scanPatchDigests` のテストです。読み取り権限のないパッチファイルがある場合に、`digests` が空になり、`error` に `cannot read the patch file` が含まれることを確認します。')
    mkdirSync(temporaryRoot('patches'), { recursive: true })
    writeFileSync(temporaryRoot('patches', 'a+1.0.0.patch'), 'a', { mode: 0o000 })

    const scan = scanPatchDigests(temporaryRoot('patches'))
    expect(scan.digests).toEqual([])
    expect(scan.error).toContain('cannot read the patch file')
  })
})

describe('applyPatches', () => {
  it('適用するパッチがなければ、何もしない', async () => {
    await explains('パッチを適用する `applyPatches` のテストです。パッチの一覧が空の場合に、何も実行せず `undefined` で完了することを確認します。')
    await expect(applyPatches({
      root: temporaryRoot(),
      patchesDirectory: temporaryRoot('patches'),
      patches: [],
      patchPackageEntry: 'unused',
      lockPath: undefined,
    })).resolves.toBeUndefined()
  })

  it('基準のパスを解決できなければ、パッチの適用を起動せずに、失敗の結果を返す', async () => {
    await explains('`applyPatches` のテストです。パッチの置き場が存在しない場合に、終了コードは `null` になり、標準エラーに置き場のパスが含まれる結果を返すことを確認します。')
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

  it('root が存在しない場合も、root のパスを示して失敗する', async () => {
    await explains('`applyPatches` のテストです。`root` が存在しない場合に、標準エラーに `root` のパスが含まれる結果を返すことを確認します。')
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

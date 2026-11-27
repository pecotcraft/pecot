import { describe, expect, it } from 'vitest'

import { digestPatch, sortPatchDigests } from '../patch-digest.js'
import { explains } from '../../../../tests/_helpers/explains.js'

describe('digestPatch', () => {
  it('パッチの内容の SHA-256 を、hash として返す', async () => {
    await explains('パッチファイルのダイジェストを作成する `digestPatch` のテストです。ファイル名と内容を渡した場合に、内容の SHA-256 を `hash` に持つ、ファイル名とのペアを返すことを確認します。')
    expect(digestPatch('a+1.0.0.patch', new TextEncoder().encode('abc'))).toEqual({
      file: 'a+1.0.0.patch',
      hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    })
  })
})

describe('sortPatchDigests', () => {
  it('ダイジェストを file の昇順に並べ、元の配列は変更しない', async () => {
    await explains('パッチのダイジェストを並べ替える `sortPatchDigests` のテストです。`file` の昇順に並べ替えた配列を返し、渡した元の配列は変更しないことを確認します。')
    const input = [{ file: 'b', hash: '2' }, { file: 'a', hash: '1' }]
    expect(sortPatchDigests(input).map(digest => digest.file)).toEqual(['a', 'b'])
    expect(input.map(digest => digest.file)).toEqual(['b', 'a'])
  })
})

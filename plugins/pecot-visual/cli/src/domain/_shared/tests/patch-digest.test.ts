import { describe, expect, it } from 'vitest'

import { digestPatch, sortPatchDigests } from '../patch-digest.js'

describe('digestPatch', () => {
  it('内容の sha256 を hash に入れる', () => {
    expect(digestPatch('a+1.0.0.patch', new TextEncoder().encode('abc'))).toEqual({
      file: 'a+1.0.0.patch',
      hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    })
  })
})

describe('sortPatchDigests', () => {
  it('file の昇順に並べ、元の配列は変えない', () => {
    const input = [{ file: 'b', hash: '2' }, { file: 'a', hash: '1' }]
    expect(sortPatchDigests(input).map(digest => digest.file)).toEqual(['a', 'b'])
    expect(input.map(digest => digest.file)).toEqual(['b', 'a'])
  })
})

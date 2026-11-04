// patches/ 配下の 1 ファイルを表す PatchDigest と、それに紐づく純粋な計算。
//
// 使うのは 2 か所。
// - テーマの置き場の再利用判定。domain/slidev-theme/store-layout.ts。
// - patch の走査と適用。infra/_shared/patch-apply.ts。

import { createHash } from 'node:crypto'

import { compareStrings } from './compare-strings.js'

/**
patches/ 配下の 1 ファイルと、その内容ハッシュ。file は patches/ 起点の相対パス。
*/
export interface PatchDigest {
  readonly file: string
  readonly hash: string
}

/**
パッチの内容から PatchDigest を作る。hash は内容の sha256。
*/
// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Buffer を受ける
export function digestPatch(file: string, contents: Uint8Array): PatchDigest {
  return { file, hash: createHash('sha256').update(contents).digest('hex') }
}

/**
file の昇順に並べる。並び順を固定して、ハッシュを走査順に依存させない。
*/
export function sortPatchDigests(patches: readonly PatchDigest[]): readonly PatchDigest[] {
  return patches.toSorted((left, right) => compareStrings(left.file, right.file))
}

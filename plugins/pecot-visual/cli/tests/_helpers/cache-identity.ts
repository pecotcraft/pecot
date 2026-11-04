// cache-identity 系 CUJ（#897 US2 / T011-b、#898 US3）が共有するデッキと入力解決。
//
// 2 つの CUJ は別ファイルで並列に動くが、同じ 3 枚デッキを対象にすることで
// 「全変換 vs 差分変換」と「--no-cache」の観測が同一構成の上で読める。

/* eslint-disable security/detect-non-literal-fs-filename -- 環境変数で渡された pptx の存在確認 */
import { existsSync } from 'node:fs'
import path from 'node:path'

import { FIXTURE_THEME_NAME } from './pecotv-e2e-run.js'

export const SLIDE_COUNT = 3

// 1 枚目と 3 枚目に置くテーマの画像（出力に ppt/media/ ができる）。
// src は動的な式にする。静的な /theme/... は build が解決しようとして失敗する。
const THEME_IMAGE = '<img :src="\'/theme/sample.png\'" width="120" height="80">'

/**
3 枚の inline デッキ。中央 1 枚だけを差し替えて hit / miss / hit を作るため、
各スライドの本文は互いに独立させる。
*/
export function deckMarkdown(middleBody: string): string {
  return [
    '---',
    `theme: "${FIXTURE_THEME_NAME}"`,
    'title: Cache Identity E2E',
    'canvasWidth: 960',
    'aspectRatio: \'16/9\'',
    '---',
    '',
    '# キャッシュ同一性 1 枚目',
    '',
    '先頭スライドの本文。',
    '',
    THEME_IMAGE,
    '',
    '---',
    '',
    middleBody,
    '',
    '---',
    '',
    '# キャッシュ同一性 3 枚目',
    '',
    '末尾スライドの本文。',
    '',
    THEME_IMAGE,
    '',
  ].join('\n')
}

/**
外部 pptx モードの入力を解決する。
片方だけ指定されたとき、通知なしに通常モードへ戻ると、実機検証で「比較したつもりが合成デッキを回していた」ことに気付けない。
そのため失敗させる。
*/
export function resolveExternalPair(): { readonly a: string, readonly b: string } | undefined {
  const rawA = process.env['PECOTV_CACHE_IDENTITY_A']
  const rawB = process.env['PECOTV_CACHE_IDENTITY_B']
  if (rawA === undefined && rawB === undefined) return undefined
  if (rawA === undefined || rawB === undefined) {
    throw new Error('外部 pptx モードは PECOTV_CACHE_IDENTITY_A と PECOTV_CACHE_IDENTITY_B の両方を指定してください')
  }
  const a = path.resolve(rawA)
  const b = path.resolve(rawB)
  if (a === b) {
    throw new Error(`外部 pptx モードの A と B が同一ファイルです（比較が恒真になります）: ${a}`)
  }
  if (!existsSync(a)) throw new Error(`PECOTV_CACHE_IDENTITY_A のファイルが存在しません: ${a}`)
  if (!existsSync(b)) throw new Error(`PECOTV_CACHE_IDENTITY_B のファイルが存在しません: ${b}`)
  return { a, b }
}
/* eslint-enable security/detect-non-literal-fs-filename */

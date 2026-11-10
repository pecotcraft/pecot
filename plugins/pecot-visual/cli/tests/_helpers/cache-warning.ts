// #931: キャッシュ系警告 CUJ（CUJ-A / B / C）が共有するデッキと警告接頭辞。
//
// 3 CUJ は fs の状態だけで別々の警告ルートを作るため、注入手順は各ファイルが持つ。
// ここに置くのは 3 ファイルで一致していないと観測がずれるもの（デッキ・接頭辞・cache パス）に限る。

import path from 'node:path'

import { FIXTURE_THEME_NAME } from './pecotv-e2e-run.js'

export const SLIDE_COUNT = 2

export const MANIFEST_INVALID_PREFIX = 'cannot read the cache manifest'
export const CACHE_UNUSABLE_PREFIX = 'cannot use the cache, so converting everything'
export const SAVE_FAILED_PREFIX = 'cache save failed'
export const UPDATE_FAILED_PREFIX = 'cache update failed'

export function cacheDirectoryOf(project: string): string {
  return path.join(project, 'pptx', 'cache')
}

export function deckMarkdown(): string {
  return [
    '---',
    `theme: "${FIXTURE_THEME_NAME}"`,
    'title: Cache Warning Observability E2E',
    'canvasWidth: 960',
    'aspectRatio: \'16/9\'',
    '---',
    '',
    '# キャッシュ警告 1 枚目',
    '',
    '先頭スライドの本文。',
    '',
    '---',
    '',
    '# キャッシュ警告 2 枚目',
    '',
    '末尾スライドの本文。',
    '',
  ].join('\n')
}

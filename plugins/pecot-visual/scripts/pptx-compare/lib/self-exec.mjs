// 自己実行（`node <this-file>` で直接起動されたか）の判定 (#1073)。
//
// scripts/release/self-exec.mjs と同じ判定。
// release レーンと pptx-compare レーンは、互いを import しない方針。
// そのため、同内容をこちらにも置く。
//
// import.meta.url は Node が realpath を解決済みの URL なので、argv[1] も realpath へ正規化してから比較する。
// 正規化しないと、symlink 経由の起動で比較が外れる。
// その結果、出力 0 バイト・rc 0 で何も起きない no-op になる。
//
//   import { isSelfExecuted } from './self-exec.mjs'
//   if (isSelfExecuted(import.meta.url)) { ... }

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function isSelfExecuted(importMetaUrl) {
  if (process.argv[1] === undefined) return false
  let selfUrl = null
  try {
    selfUrl = pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    // argv[1] が実ファイルでない起動形態（-e 等）。自己実行ではない。
    return false
  }
  return importMetaUrl === selfUrl
}

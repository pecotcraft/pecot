// ローカルファイルの実在確認。
//
// 上書き規則（research R7）の判定は、「既にある書き出し先には overwrite を要する」の 1 点だけ。
// ただしディレクトリは、overwrite を付けても救えない。
// `aws s3 cp s3://b/k /dir` は `/dir/k` を書くので、artifacts に載せる書き出し先（`/dir`）と実体がずれる。
// 呼び出し側が種別で分岐できるよう、存在確認とディレクトリ判定を別に公開する。

/* eslint-disable security/detect-non-literal-fs-filename -- 引数は許可リストの abs-path 検証を通った書き出し先のみ */

import { existsSync, statSync } from 'node:fs'

/**
絶対パスが既に存在するか（ファイル・ディレクトリのどちらでも true）。
*/
export function doesFileExist(absolutePath: string): boolean {
  return existsSync(absolutePath)
}

/**
絶対パスがディレクトリか。存在しなければ false。
*/
export function isDirectory(absolutePath: string): boolean {
  return statSync(absolutePath, { throwIfNoEntry: false })?.isDirectory() ?? false
}

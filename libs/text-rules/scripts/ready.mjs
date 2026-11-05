// root フックが dist を使えるかの判定。
// 終了コード 0 は使える、20 は依存が未導入、30 は dist が無いかソースと一致しない、40 は判定そのものの失敗。
// 40 のときは、原因の例外メッセージを stderr に 1 行出す。
/* eslint-disable security/detect-non-literal-fs-filename -- root はこのファイルの位置から決まるパッケージルートで、利用者入力ではない。 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { packageRoot as root, sourceHash, STAMP } from './source-hash.mjs'

function dependenciesResolve() {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  try {
    const names = Object.keys(manifest.dependencies ?? {})
    for (const name of names) void import.meta.resolve(name)
    return true
  }
  catch {
    return false
  }
}

function distributionFresh() {
  const entry = path.join(root, 'dist/bin/pecot-text-lint.js')
  const stamp = path.join(root, STAMP)
  const present = existsSync(entry) && existsSync(stamp)
  return present && readFileSync(stamp, 'utf8').trim() === sourceHash(root)
}

function exitCodeFor() {
  try {
    if (!dependenciesResolve()) return 20
    return distributionFresh() ? 0 : 30
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`ready: ${message.split('\n', 1)[0]}\n`)
    return 40
  }
}

process.exitCode = exitCodeFor()

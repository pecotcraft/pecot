// text-rules の build の実体。distribution の削除、tsc、dist/package.json と dist/source-hash の書き出しをここに 1 本化する。
// libs/text-rules/package.json の build と、pecot-visual の build.mjs（ミラーの bootstrap を含む）が起動する。
// package manager を介さず node だけで完結させるので、cwd に依存せず、このファイルの位置から text-rules を解決する。
/* eslint-disable security/detect-non-literal-fs-filename -- パスはこのファイルの位置から決まるパッケージルート配下で、利用者入力ではない。 */
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { packageRoot as root, sourceHash, STAMP } from './source-hash.mjs'

const distribution = path.join(root, 'dist')

// tsc の前に入力のハッシュを取る。build 中にソースが変わっても、記録は build を始めた時点の入力を指す。
const hash = sourceHash(root)
rmSync(distribution, { recursive: true, force: true })
const result = spawnSync(process.execPath, [path.join(root, 'scripts/tsc.mjs'), '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status === 0) {
  writeFileSync(path.join(distribution, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(path.join(root, STAMP), `${hash}\n`)
}
else {
  process.exitCode = result.status ?? 1
}

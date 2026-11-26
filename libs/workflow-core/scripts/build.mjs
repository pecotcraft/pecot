// dist を消してから tsc で作り直し、dist/package.json に type: module を書く。
// pecot-workflow の build とミラーと配布の作成が起動するので、cwd に依存せず、このファイルの位置から lib を解決する。
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const distribution = path.join(root, 'dist')

rmSync(distribution, { recursive: true, force: true })
const result = spawnSync(process.execPath, [path.join(root, 'scripts/tsc.mjs'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status === 0) writeFileSync(path.join(distribution, 'package.json'), JSON.stringify({ type: 'module' }))
else process.exitCode = result.status ?? 1

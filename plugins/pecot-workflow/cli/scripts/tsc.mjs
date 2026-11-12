// hoist 先が開発とミラーで違うため、Node の解決で typescript7 の tsc を探す。.bin/tsc 経由にはしない。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const packageJson = createRequire(import.meta.url).resolve('typescript7/package.json')
const tscPath = path.join(path.dirname(packageJson), 'bin', 'tsc')
const result = spawnSync(process.execPath, [tscPath, ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1

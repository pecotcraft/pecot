// build の前に <処理>/dist を消す。rollup は dist を空にしないので、消した action の古い dist が残ると lint-dist が見逃す。
/* eslint-disable security/detect-non-literal-fs-filename -- 消すのは root の直下の <処理>/dist だけ */
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
root の直下のディレクトリ（node_modules を除く）が持つ dist を消し、消した dist の root からのパスを返す
*/
export function cleanDistribution(root: string = ROOT): string[] {
  const removed = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && existsSync(path.join(root, entry.name, 'dist')))
    .map(entry => path.join(entry.name, 'dist'))
    .toSorted((a, b) => a.localeCompare(b))
  for (const relative of removed) rmSync(path.join(root, relative), { recursive: true, force: true })
  return removed
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) cleanDistribution()

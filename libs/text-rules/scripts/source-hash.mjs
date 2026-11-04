// dist の入力（ソース）のハッシュ。build.mjs が dist/source-hash に書き、ready.mjs が現在のソースと比べる。
// root は引数で受け、cwd に依存しない。
/* eslint-disable security/detect-non-literal-fs-filename -- root は呼び出し側が決めるパッケージルートで、利用者入力ではない。 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const STAMP = 'dist/source-hash'

// このファイルの位置から決まるパッケージルート。build.mjs と ready.mjs はこれを使う。
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SINGLE_FILES = ['index.ts', 'package.json', 'tsconfig.json', 'tsconfig.build.json']
const DIRECTORIES = ['bin', 'lib', 'scripts']

// 存在しない、またはディレクトリでないパスは「無い」とみなす。権限エラーなどは握りつぶさず投げる。
function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

function isFile(file) {
  try {
    return statSync(file).isFile()
  }
  catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function walk(root, relative) {
  let entries
  try {
    entries = readdirSync(path.join(root, relative), { withFileTypes: true })
  }
  catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return entries.flatMap((entry) => {
    const child = `${relative}/${entry.name}`
    // symlink は実体の種別で判定する。先の無いリンクは飛ばす。
    if (entry.isSymbolicLink()) return resolveLink(root, child)
    if (entry.isDirectory()) return walk(root, child)
    return entry.isFile() ? child : []
  })
}

function resolveLink(root, child) {
  let stats
  try {
    stats = statSync(path.join(root, child))
  }
  catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  if (stats.isDirectory()) return walk(root, child)
  return stats.isFile() ? child : []
}

// root からの相対パス（POSIX 区切り）を、コード単位順で返す。入力は ASCII のパスだけなので既定の並びで足りる。
export function sourceFiles(root) {
  const singles = SINGLE_FILES.filter(name => isFile(path.join(root, name)))
  const nested = DIRECTORIES.flatMap(name => walk(root, name))
  // eslint-disable-next-line unicorn/require-array-sort-compare -- 入力は ASCII のパスだけで、既定のコード単位順が意図した並びになる。
  return [...singles, ...nested].toSorted()
}

export function sourceHash(root) {
  const hash = createHash('sha256')
  for (const file of sourceFiles(root)) {
    const content = readFileSync(path.join(root, file))
    // パスと長さを前置する。隣り合うファイル間でバイトが移った入力を、同じ値にしないため。
    hash.update(`${file}\0${content.length}\0`)
    hash.update(content)
  }
  return hash.digest('hex')
}

// 直接実行のときだけ出力する。symlink 経由の起動も同じファイルとして扱う。
// import する側の argv[1] はパスとは限らない（`node -e ... 引数` など）ので、解決できなければ直接実行ではない。
function isMainModule() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url)
  }
  catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

if (isMainModule()) {
  process.stdout.write(`${sourceHash(packageRoot)}\n`)
}

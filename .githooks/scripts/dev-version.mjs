// 開発版の版を標準出力へ書く。argv[2] = plugin.json のパス、argv[3] = GitHub Actions の run_number。
// patch を 1 つ上げた prerelease にし、出ている正式版より上、次の正式版より下に並べる。
import { readFileSync } from 'node:fs'

const [manifestPath, runNumber] = process.argv.slice(2)
const fail = (message) => {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

if (!manifestPath || !runNumber) fail('usage: dev-version.mjs <plugin.json> <run_number>')
if (!/^[1-9]\d*$/.test(runNumber)) fail(`run_number は 1 以上の整数で渡してください: ${runNumber}`)

const { version } = JSON.parse(readFileSync(manifestPath, 'utf8'))
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(typeof version === 'string' ? version : '')
if (!match) fail(`${manifestPath} の version が x.y.z の形ではありません: ${version}`)

const [, major, minor, patch] = match
process.stdout.write(`${major}.${minor}.${Number(patch) + 1}-dev.${runNumber}\n`)

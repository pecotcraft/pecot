// actions/templates/ の雛形を、pecot-workflow が配る写し（cli/templates/workflow/）に書き写す。
// マーケットプレイスはプラグインのディレクトリだけを配るので、写しを commit する。
/* eslint-disable security/detect-non-literal-fs-filename -- 読み書きするのは 2 つの固定のディレクトリだけ */
import { copyFileSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const SOURCE = path.join(ROOT, 'actions', 'templates')
export const COPY = path.join(ROOT, 'plugins', 'pecot-workflow', 'cli', 'templates', 'workflow')
const WRITE_COMMAND = 'pnpm --dir actions run sync-templates --write'

function names(directory: string): string[] {
  return readdirSync(directory).filter(name => name.endsWith('.yml')).toSorted((a, b) => a.localeCompare(b))
}

/**
写しが正と違うファイルの名前。写しにだけあるファイルも数える
*/
export function staleCopies(source: string = SOURCE, copy: string = COPY): string[] {
  const copies = new Set(names(copy))
  const sources = names(source)
  const stale = sources.filter(name => !copies.has(name) || readFileSync(path.join(source, name), 'utf8') !== readFileSync(path.join(copy, name), 'utf8'))
  const extra = [...copies].filter(name => !sources.includes(name))
  return [...stale, ...extra].toSorted((a, b) => a.localeCompare(b))
}

function writeCopies(source: string = SOURCE, copy: string = COPY): void {
  for (const name of names(source)) copyFileSync(path.join(source, name), path.join(copy, name))
}

function main(mode: string | undefined): number {
  if (mode === '--write') {
    writeCopies()
    return 0
  }
  if (mode === '--check') {
    const stale = staleCopies()
    if (stale.length === 0) return 0
    process.stderr.write(`error: the plugin copies differ from actions/templates: ${stale.join(', ')}\n  run: ${WRITE_COMMAND}\n`)
    return 1
  }
  process.stderr.write('error: usage: pnpm run sync-templates --check | --write\n')
  return 2
}

const entryPoint = process.argv[1]
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv[2])
}

import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { validateRepository } from './validate-repository.js'

export interface Output {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const USAGE = 'usage: interface-spec validate [--root <dir>]'

function defaultRoot(): string {
  return path.resolve(import.meta.dirname, '../../..')
}

export async function run(argv: readonly string[], output: Output): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'validate') {
    output.stderr(`${USAGE}\n`)
    return 2
  }
  let root = defaultRoot()
  if (rest.length > 0) {
    if (rest[0] !== '--root' || rest.length !== 2 || rest[1] === undefined) {
      output.stderr(`${USAGE}\n`)
      return 2
    }
    root = path.resolve(rest[1])
  }
  const lines = await validateRepository(root)
  for (const line of lines) output.stderr(`${line}\n`)
  return lines.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  })
}

import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { LoadError } from './infra/load.js'
import { validateRepository } from './validate-repository.js'

export interface Output {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const USAGE = 'usage: interface-spec validate [--root <dir>]'

export function defaultRoot(): string {
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
  try {
    const lines = await validateRepository(root)
    for (const line of lines) output.stderr(`${line}\n`)
    return lines.length === 0 ? 0 : 1
  }
  catch (error) {
    output.stderr(`error: ${describeFailure(error)}\n`)
    return 2
  }
}

// 読み込みの失敗は LoadError が `<path>: <code>` を持つ。終了コード 1（指摘あり）と見分けるため 2 で終わる。
function describeFailure(error: unknown): string {
  if (error instanceof LoadError) return error.message
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? (error.message.split('\n', 1)[0] ?? 'unknown') : 'unknown'
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  })
}

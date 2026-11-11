import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checkCommandsMd, writeCommandsMd } from './commands-md.js'
import { LoadError } from './infra/load.js'
import { validateRepository } from './validate-repository.js'

export interface Output {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const USAGE = 'usage: interface-spec validate [--root <dir>]\n       interface-spec commands-md (--check | --write) [--root <dir>]'

export function defaultRoot(): string {
  return path.resolve(import.meta.dirname, '../../..')
}

function parseArguments(rest: readonly string[], flags: readonly string[]): { root: string, flag?: string } | undefined {
  let root = defaultRoot()
  const found: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index] ?? ''
    if (argument === '--root') {
      const value = rest[index + 1]
      if (value === undefined) return undefined
      root = path.resolve(value)
      index++
    }
    else if (flags.includes(argument)) found.push(argument)
    else return undefined
  }
  if (flags.length === 0) return found.length === 0 ? { root } : undefined
  const [flag] = found
  return flag !== undefined && found.length === 1 ? { root, flag } : undefined
}

export async function run(argv: readonly string[], output: Output): Promise<number> {
  const [command, ...rest] = argv
  const parsed = command === 'validate' || command === 'commands-md'
    ? parseArguments(rest, command === 'validate' ? [] : ['--check', '--write'])
    : undefined
  if (parsed === undefined) {
    output.stderr(`${USAGE}\n`)
    return 2
  }
  try {
    if (command === 'commands-md' && parsed.flag === '--write') {
      const written = await writeCommandsMd(parsed.root)
      for (const line of written) output.stdout(`${line}\n`)
      return 0
    }
    const lines = command === 'validate' ? await validateRepository(parsed.root) : await checkCommandsMd(parsed.root)
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

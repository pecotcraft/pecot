// GitHub の Issue の機能の写し（interface/github-issue-surface.json）を作り直す。
// 使い方: tsx scripts/github-surface/extract.ts --out <ファイル> [--api-version <版>]
import { realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import type { CommandIo } from '../../src/commands/registry.js'
import { extractIssueSurface } from '../../src/domain/issue-surface.js'
import type { IssueSurface } from '../../src/domain/issue-surface.js'
import { DEFAULT_API_VERSION } from '@pecot/workflow-core/infra/github/client.js'
import { fetchIssueSurfaceSources } from '../../src/infra/github/issue-surface.js'

const USAGE = 'usage: extract.ts --out <file> [--api-version <version>]'

const STANDARD_IO: CommandIo = {
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
}

function optionsOf(argv: readonly string[]): { out: string, apiVersion: string } | undefined {
  try {
    const { values } = parseArgs({ args: [...argv], options: { 'out': { type: 'string' }, 'api-version': { type: 'string' } }, strict: true })
    return values.out === undefined ? undefined : { out: values.out, apiVersion: values['api-version'] ?? DEFAULT_API_VERSION }
  }
  catch {
    return undefined
  }
}

/**
SDL と OpenAPI を取り、写しを --out に書く。引数の誤りは 2
*/
export async function run(argv: readonly string[], io: CommandIo = STANDARD_IO): Promise<number> {
  const output = createOutput(false, io)
  const options = optionsOf(argv)
  if (options === undefined) {
    output.error(USAGE)
    return 2
  }
  const { sdl, openapi, sources } = await fetchIssueSurfaceSources(options.apiVersion)
  const surface: IssueSurface = { sources, items: extractIssueSurface(sdl, openapi) }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 書く先は引数で渡されたファイル
  writeFileSync(options.out, `${JSON.stringify(surface, undefined, 2)}\n`)
  io.stdout(`wrote: ${options.out} (${String(surface.items.length)} items)\n`)
  return 0
}

// 起動したファイルかどうかを realpath で比べる（export-interface.ts と同じ）
const entryPoint = process.argv[1]
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 利用者の入力ではないパス
if (entryPoint !== undefined && realpathSync(entryPoint) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await run(process.argv.slice(2))
}

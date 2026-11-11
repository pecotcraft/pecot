import path from 'node:path'
import { renderCommandsMd } from './domain/commands-md.js'
import { formatStale } from './domain/diff.js'
import { generatedFileSchema } from './domain/schema.js'
import { LoadError, loadJson, readText, writeText } from './infra/load.js'

const GENERATED_PATH = 'plugins/pecot-workflow/interface/generated.json'
export const COMMANDS_MD_PATH = 'plugins/pecot-workflow/skills/w-help/references/commands.md'
export const REGENERATE_COMMAND = 'pnpm -C libs/interface-spec exec tsx src/cli.ts commands-md --write'

async function render(root: string): Promise<string> {
  const state = await loadJson(path.join(root, GENERATED_PATH))
  if (state.kind === 'missing') throw new LoadError(`${GENERATED_PATH}: ENOENT`)
  if (state.kind === 'syntax') throw new LoadError(`${GENERATED_PATH}: is not valid JSON`)
  const parsed = generatedFileSchema.safeParse(state.data)
  if (!parsed.success) throw new LoadError(`${GENERATED_PATH}: does not match the generated file format`)
  return renderCommandsMd(parsed.data, REGENERATE_COMMAND)
}

// 作り直したものとリポジトリの commands.md が食い違うと、stale の行を返す。ファイルが無いときも同じ。
export async function checkCommandsMd(root: string): Promise<string[]> {
  const expected = await render(root)
  const actual = await readText(path.join(root, COMMANDS_MD_PATH))
  return actual === expected ? [] : formatStale(COMMANDS_MD_PATH, [], REGENERATE_COMMAND)
}

// 書き換えたときだけ `updated: <path>` を返す。
export async function writeCommandsMd(root: string): Promise<string[]> {
  const expected = await render(root)
  if (await readText(path.join(root, COMMANDS_MD_PATH)) === expected) return []
  await writeText(path.join(root, COMMANDS_MD_PATH), expected)
  return [`updated: ${COMMANDS_MD_PATH}`]
}

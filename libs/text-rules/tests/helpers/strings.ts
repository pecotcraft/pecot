import { TextlintKernel } from '@textlint/kernel'
import { SUMMARY_PREFIX } from '../../lib/findings.js'
import strings from '../../lib/plugins/strings.js'
import { buildRules } from '../../lib/rules.js'
import { pickWord } from './dictionary.js'

export const word = pickWord()
// no-ai-words が 1 件返す違反文。語は辞書から組み立てる。
export const sentence = `${word}を使う。`

export interface Hit {
  readonly ruleId: string
  readonly line: number
  readonly column: number
}

const kernel = new TextlintKernel()

// kernel は実物で、strings だけを plugin に渡す。comments は strings が内包する。
export async function lintAll(text: string, extension: string): Promise<Hit[]> {
  const result = await kernel.lintText(text, {
    ext: extension,
    filePath: `sample${extension}`,
    plugins: [{ pluginId: 'strings', plugin: strings }],
    rules: buildRules(),
  })
  const failure = result.messages.find(message => message.ruleId === 'plugin-error')
  if (failure !== undefined) {
    throw new Error(failure.message)
  }
  return result.messages
    .filter(message => !message.message.startsWith(SUMMARY_PREFIX))
    .map(message => ({ ruleId: message.ruleId, line: message.loc.start.line, column: message.loc.start.column }))
}

export async function lint(text: string, extension: string, ruleId = 'no-ai-words'): Promise<Hit[]> {
  const hits = await lintAll(text, extension)
  return hits.filter(hit => hit.ruleId === ruleId)
}

export function at(line: number, column: number): Hit {
  return { ruleId: 'no-ai-words', line, column }
}

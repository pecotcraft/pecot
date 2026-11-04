import { TextlintKernel } from '@textlint/kernel'
import { withoutSummary, oneLine } from './findings.js'
import { loadMarkdownPlugin } from './plugins/load.js'
import { buildRules } from './rules.js'

export type TextMode = 'fragment' | 'markdown'
export interface TextFinding {
  ruleId: string
  message: string
  line: number
  column: number
}

const kernel = new TextlintKernel()
const plugin = loadMarkdownPlugin()
const rules = buildRules()

// 項目文字列を Markdown として渡すため、行頭の記法がブロック要素にならないようエスケープする
function escapeBlockSyntax(text: string): string {
  return text.replaceAll(/^(\d+)([.)])(\s)/gm, '$1\\$2$3').replaceAll(/^([-+*>#|])/gm, '\\$1')
}

export async function lintText(text: string, mode: TextMode): Promise<readonly TextFinding[]> {
  if (text.trim() === '') {
    return []
  }
  const result = await kernel.lintText(mode === 'fragment' ? escapeBlockSyntax(text) : text, {
    ext: '.md',
    plugins: [{ pluginId: 'markdown', plugin }],
    rules,
  })
  return withoutSummary(result.messages)
    .map(message => ({
      ruleId: message.ruleId,
      message: oneLine(message.message),
      line: message.loc.start.line,
      column: message.loc.start.column,
    }))
}

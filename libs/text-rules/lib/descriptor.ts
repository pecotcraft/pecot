import { TextlintKernelDescriptor } from '@textlint/kernel'
import { loadCommentsPlugin, loadMarkdownPlugin } from './plugins/load.js'
import strings from './plugins/strings.js'
import { buildRules } from './rules.js'

// kernel は拡張子に先頭一致した plugin 1 つだけで解析するので、strings を comments より前に置く。
// strings は comments を内包し、.py .sh .json .yaml のコメントと文字列を 1 つの Document にする。
export function buildDescriptor(): TextlintKernelDescriptor {
  return new TextlintKernelDescriptor({
    rules: buildRules(),
    filterRules: [],
    plugins: [
      { pluginId: 'markdown', plugin: loadMarkdownPlugin() },
      { pluginId: 'strings', plugin: strings },
      { pluginId: 'comments', plugin: loadCommentsPlugin() },
    ],
  })
}

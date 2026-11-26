// 配布テンプレート（plugins/pecot-workflow/cli/templates/）の場所。
// 見出しを読むのは @pecot/workflow-core の infra/template-sections.ts で、ここはファイルの位置だけを受け持つ。

import path from 'node:path'

import { pluginRoot } from '../version.js'

export type TemplateKind = 'issue' | 'comment' | 'pr' | 'workflow'

/**
種別ごとのテンプレートのディレクトリ
*/
export function templatesDirectory(kind: TemplateKind): string {
  return path.join(pluginRoot(), 'cli', 'templates', kind)
}

/**
種別と名前（拡張子なし）から決まるテンプレートのパス
*/
export function templateFile(kind: TemplateKind, name: string): string {
  return path.join(templatesDirectory(kind), `${name}.md`)
}

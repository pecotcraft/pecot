/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が決める。この層は読むだけ */
// 配布テンプレート（plugins/pecot-workflow/cli/templates/）の読み出し。
// 見出しの抽出そのものは domain/sections.ts が行い、ここはファイルの位置と読み込みを受け持つ。

import { existsSync } from 'node:fs'
import path from 'node:path'

import { extractSectionsFromTemplate } from '../domain/sections.js'
import type { SectionHeading } from '../domain/sections.js'
import { pluginRoot } from '../version.js'

import { readTextFile } from './text-file.js'

export type TemplateKind = 'issue' | 'comment' | 'pr'

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

/**
テンプレートファイルから必須セクションを抽出する。ファイルが無い・読めないときは空
*/
export function readTemplateSections(file: string): readonly SectionHeading[] {
  if (!existsSync(file)) return []
  try {
    return extractSectionsFromTemplate(readTextFile(file))
  }
  catch {
    return []
  }
}

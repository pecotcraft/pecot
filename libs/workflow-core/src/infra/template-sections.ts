/* eslint-disable security/detect-non-literal-fs-filename -- パスは呼び出し側が決める。この層は読むだけ */
// テンプレートのファイルから必須の見出しを読む。テンプレートの場所は、配布物のルートを知るプラグインの側が決めて渡す。
// 見出しの抽出そのものは domain/sections.ts が行う。

import { existsSync } from 'node:fs'

import { extractSectionsFromTemplate } from '../domain/sections.js'
import type { SectionHeading } from '../domain/sections.js'

import { readTextFile } from './text-file.js'

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

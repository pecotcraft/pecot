/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは skills・agents・hooks/templates 配下のみ */
// スキル・エージェント・hooks のテンプレートの本文を集める補助。
// skills テストは、利用環境のエージェントの挙動を決めるこれらの本文を読む。
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { COMMANDS } from '../../../src/commands/registry.js'
import { compareStrings } from '../../parity/baseline.js'

export const pluginRoot = path.resolve(import.meta.dirname, '../../../..')

export interface Document {
  /**
  プラグインのルートからの相対パス
  */
  readonly file: string
  readonly text: string
}

/**
本文を読む対象。skills 配下の md、agents/*.md、hooks/templates/*.md
*/
export function readDocuments(): readonly Document[] {
  const files = ['skills/**/*.md', 'agents/*.md', 'hooks/templates/*.md']
    .flatMap(pattern => globSync(pattern, { cwd: pluginRoot }))
    .toSorted(compareStrings)
  return files.map(file => ({ file, text: readFileSync(path.join(pluginRoot, file), 'utf8') }))
}

export function readPluginFile(relative: string): string {
  return readFileSync(path.join(pluginRoot, relative), 'utf8')
}

/**
ツール名から、受け取る入力の名前（グローバルの repo を含む）へ
*/
export function toolInputs(): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(COMMANDS.map(command => [command.toolName, new Set(Object.keys(command.input.shape))]))
}

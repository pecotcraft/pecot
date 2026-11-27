/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはこのリポのソースだけ */
// スキルが呼ぶチェックのツールが、GitHub に読み書きするモジュールを import しないことを確かめる（SC-005）。
// ツールのファイルから、相対パスと @pecot/workflow-core の import を辿り、値の import だけを数える。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'

const CLI_SRC = path.resolve(import.meta.dirname, '../src')
const CORE_SRC = path.resolve(import.meta.dirname, '../../../../libs/workflow-core/src')

// チェックのツールの定義を置くファイル
const CHECK_TOOL_FILES = [
  'commands/issue-check.ts',
  'commands/issue-dependency-check.ts',
  'commands/issue-comment-check.ts',
].map(file => path.join(CLI_SRC, file))

// GitHub の API の client。辿れる import のどこにもあってはならない。ディレクトリは、その下のすべてのファイルを指す
const FORBIDDEN: readonly string[] = [
  path.join(CORE_SRC, 'infra/github'),
  path.join(CLI_SRC, 'infra/github'),
  path.join(CORE_SRC, 'commands-shared/github-client.ts'),
]

// git と gh を起動するモジュール。設定の場所を求める paths.ts が git を使うので、ツールのファイルが直に import しないことだけを見る
const DIRECT_FORBIDDEN: readonly string[] = [
  path.join(CORE_SRC, 'infra/git.ts'),
  path.join(CLI_SRC, 'infra/git.ts'),
  path.join(CORE_SRC, 'infra/process-run.ts'),
  path.join(CLI_SRC, 'infra/process-run.ts'),
]

// import・export の文の始まり。`import type` と `export type` は値の import でないので除く
const STATEMENT_START = /^(?:import|export)[ \t{*]/u
// 文の終わりの from の文字列か、副作用の import の文字列
const SPECIFIER = /['"]([^'"]+)['"]$/u

// import・export の文の、from の文字列を返す。文は複数の行にまたがることがある
function specifiersOf(text: string): string[] {
  const found: string[] = []
  let statement: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (statement === undefined && STATEMENT_START.test(line)) statement = line
    else if (statement !== undefined) statement += ` ${line}`
    if (statement === undefined) continue
    const specifier = SPECIFIER.exec(statement)?.[1]
    const isEnded = specifier !== undefined || !/^(?:import|export)[ \t]*\{/u.test(statement)
    if (!isEnded) continue
    if (specifier !== undefined && !/^(?:import|export) type[ \t]/u.test(statement)) found.push(specifier)
    statement = undefined
  }
  return found
}

function resolveImport(from: string, specifier: string): string | undefined {
  let base: string | undefined
  if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier)
  else if (specifier.startsWith('@pecot/workflow-core/')) base = path.join(CORE_SRC, specifier.slice('@pecot/workflow-core/'.length))
  if (base === undefined) return undefined
  const candidates = [base.replace(/\.js$/u, '.ts'), `${base}.ts`, path.join(base, 'index.ts')]
  return candidates.find(candidate => existsSync(candidate))
}

function isUnder(file: string, list: readonly string[]): boolean {
  return list.some(forbidden => file === forbidden || file.startsWith(`${forbidden}${path.sep}`))
}

function valueImports(file: string): string[] {
  return specifiersOf(readFileSync(file, 'utf8'))
    .map(specifier => resolveImport(file, specifier))
    .filter(target => target !== undefined)
}

// 起点から辿れる、禁じたモジュールへの import を `<import したファイル> -> <禁じたモジュール>` で返す
function forbiddenImports(entry: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift() ?? ''
    if (seen.has(file)) continue
    seen.add(file)
    for (const target of valueImports(file)) {
      if (isUnder(target, FORBIDDEN)) {
        found.push(`${path.relative(CLI_SRC, file)} -> ${path.relative(CLI_SRC, target)}`)
        continue
      }
      queue.push(target)
    }
  }
  return found
}

describe('SC-005: チェックのツールは GitHub に読み書きしない', () => {
  it.each(CHECK_TOOL_FILES.map(file => [path.relative(CLI_SRC, file), file]))('%s から辿れる import に、GitHub に読み書きするモジュールが無い', async (_name, file) => {
    await explains('スキルが呼ぶチェックのツールのテストです。ツールのファイルから値の import を辿り、GitHub の client・`infra/github`・git・プロセスの起動のモジュールに届かないことを確認します。')
    expect(existsSync(file)).toBe(true)
    expect(forbiddenImports(file)).toEqual([])
  })

  it.each(CHECK_TOOL_FILES.map(file => [path.relative(CLI_SRC, file), file]))('%s が、git と gh を起動するモジュールを直に import しない', async (_name, file) => {
    await explains('スキルが呼ぶチェックのツールのテストです。ツールのファイルが、git と gh を起動するモジュールを直に import していないことを確認します。')
    expect(valueImports(file).filter(target => isUnder(target, DIRECT_FORBIDDEN)).map(target => path.relative(CLI_SRC, target))).toEqual([])
  })

  it('禁じたモジュールを import するファイルを起点にすると、その import を挙げる', async () => {
    await explains('このテストの検出のテストです。GitHub の client を import するファイルを起点にすると、その import が見つかることを確認します。')
    const offender = path.join(CLI_SRC, 'commands/board-add.ts')
    expect(forbiddenImports(offender).length).toBeGreaterThan(0)
  })
})

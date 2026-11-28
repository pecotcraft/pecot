/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはこのリポのソースだけ */
// MCP のツールが、GitHub に読み書きするモジュールを import しないことを確かめる（SC-005）。
// ツールの定義のファイルと mcp/server.ts から、相対パスと @pecot/workflow-core の import を辿り、値の import だけを数える。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'
import { stepSync } from './_helpers/step.js'

const CLI_SRC = path.resolve(import.meta.dirname, '../src')
const CORE_SRC = path.resolve(import.meta.dirname, '../../../../libs/workflow-core/src')

// release_check は、タグとコミットを手元の git と remote で確かめるので、git を直に読んでよい
const RELEASE_CHECK_FILE = 'commands/release.ts'

// チェックのツールの定義を置くファイル
const CHECK_TOOL_FILES = [
  'commands/issue-check.ts',
  'commands/issue-dependency-check.ts',
  'commands/issue-comment-check.ts',
  'commands/board-check.ts',
  'commands/branch-check.ts',
  'commands/pr.ts',
  'commands/project-check.ts',
  RELEASE_CHECK_FILE,
].map(file => path.join(CLI_SRC, file))

// ツールを defineTool() で定義するファイルと、ツールを呼ぶ MCP のサーバ
const TOOL_ENTRY_FILES = [
  ...readdirSync(path.join(CLI_SRC, 'commands'))
    .filter(name => name.endsWith('.ts') && readFileSync(path.join(CLI_SRC, 'commands', name), 'utf8').includes('defineTool('))
    .map(name => path.join(CLI_SRC, 'commands', name)),
  path.join(CLI_SRC, 'mcp/server.ts'),
]

const GITHUB_INFRA = path.join(CORE_SRC, 'infra/github')

// errors.ts はエラーのクラス、payload.ts は応答の値の読み取りだけを持ち、I/O を持たないので辿ってよい
const IO_FREE_GITHUB_FILES: readonly string[] = [path.join(GITHUB_INFRA, 'errors.ts'), path.join(GITHUB_INFRA, 'payload.ts')]

// GitHub の API の client。辿れる import のどこにもあってはならない。ディレクトリは、その下のすべてのファイルを指す
const FORBIDDEN: readonly string[] = [
  GITHUB_INFRA,
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

function isForbidden(file: string): boolean {
  return !IO_FREE_GITHUB_FILES.includes(file) && isUnder(file, FORBIDDEN)
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
      if (isForbidden(target)) {
        found.push(`${path.relative(CLI_SRC, file)} -> ${path.relative(CLI_SRC, target)}`)
        continue
      }
      queue.push(target)
    }
  }
  return found
}

describe('SC-005: MCP のツールは GitHub に読み書きしない', () => {
  it('ツールの定義のファイルが、registry.ts のグループのファイルを含む', async () => {
    await explains('このテストの起点のテストです。`defineTool()` を含むファイルとして、`registry.ts` と、チェックのツールのファイルが起点に含まれることを確認します。')
    const entries = stepSync('起点のファイルを集める', () => TOOL_ENTRY_FILES.map(file => path.relative(CLI_SRC, file)))
    stepSync('registry.ts とチェックのツールが含まれることを比べる', () => {
      expect(entries).toEqual(expect.arrayContaining(['commands/registry.ts', 'mcp/server.ts', ...CHECK_TOOL_FILES.map(file => path.relative(CLI_SRC, file))]))
    })
  })

  it.each(TOOL_ENTRY_FILES.map(file => [path.relative(CLI_SRC, file), file]))('%s から辿れる import に、GitHub に読み書きするモジュールが無い', async (_name, file) => {
    await explains('MCP のツールのテストです。ツールの定義のファイルと MCP のサーバから値の import を辿り、GitHub の client と `infra/github` の I/O のモジュールに届かないことを確認します。')
    const found = stepSync('ツールのファイルから import を辿る', () => forbiddenImports(file))
    stepSync('禁じたモジュールに届かないことを比べる', () => {
      expect(found).toEqual([])
    })
  })

  it.each(IO_FREE_GITHUB_FILES.map(file => [path.relative(CORE_SRC, file), file]))('辿ってよい %s が、domain と互いのほかを値で import しない', async (_name, file) => {
    await explains('`infra/github` のうち、辿ってよい `errors.ts` と `payload.ts` のテストです。値の import の先が、workflow-core の `domain` と、この 2 つのファイルだけであることを確認します。')
    const outside = stepSync('domain と互いのほかへの値の import を集める', () => valueImports(file).filter(target => !isUnder(target, [path.join(CORE_SRC, 'domain')]) && !IO_FREE_GITHUB_FILES.includes(target)))
    stepSync('ほかへの import が無いことを比べる', () => {
      expect(outside.map(target => path.relative(CORE_SRC, target))).toEqual([])
    })
  })

  it.each(CHECK_TOOL_FILES.filter(file => file !== path.join(CLI_SRC, RELEASE_CHECK_FILE)).map(file => [path.relative(CLI_SRC, file), file]))('%s が、git と gh を起動するモジュールを直に import しない', async (_name, file) => {
    await explains('スキルが呼ぶチェックのツールのテストです。ツールのファイルが、git と gh を起動するモジュールを直に import していないことを確認します。')
    const direct = stepSync('ツールのファイルが直に import するモジュールを集める', () => ({ exists: existsSync(file), targets: valueImports(file).filter(target => isUnder(target, DIRECT_FORBIDDEN)).map(target => path.relative(CLI_SRC, target)) }))
    stepSync('起動するモジュールが無いことを比べる', () => {
      expect(direct.exists).toBe(true)
      expect(direct.targets).toEqual([])
    })
  })

  it('禁じたモジュールを import するファイルを起点にすると、その import を挙げる', async () => {
    await explains('このテストの検出のテストです。GitHub の client を import する `commands-shared/github-client.ts` を起点にすると、その import が見つかることを確認します。')
    const offender = path.join(CORE_SRC, 'commands-shared/github-client.ts')
    const found = stepSync('禁じたモジュールを import するファイルから import を辿る', () => forbiddenImports(offender))
    stepSync('見つかった import の数を比べる', () => {
      expect(found.length).toBeGreaterThan(0)
    })
  })
})

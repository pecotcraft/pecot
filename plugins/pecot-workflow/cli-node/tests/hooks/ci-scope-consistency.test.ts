/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはリポ内の project.json と run-*.sh のみ */
// project.json の target が指定する --scope= の値を、起動先の run-*.sh が受理することの静的な確認。
// スクリプトは実行せず、command の文字列と case 文を付き合わせる。
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings, isRecord } from '../parity/baseline.js'
import { projectRoot } from './_helpers/paths.js'
import { parseJson } from './_helpers/text.js'

// `bash <path>/run-*.sh --scope=<value>` を command の文字列から取り出す。
const SCOPE_INVOCATION = /bash\s+(?<script>\S*run-[a-z]+\.sh)\s+--scope=(?<scope>\S+)/u
const ACCEPTED_SCOPE = /--scope=([a-z]+)/gu
// 各プラグインの project.json。1 プラグインが 1 project に当たる。
const PLUGINS: readonly string[] = ['pecot-workflow', 'pecot-visual', 'pecot-tools']

interface ScopeTarget {
  readonly label: string
  readonly projectRelative: string
  readonly target: string
  readonly scriptRelative: string
}

function isFile(target: string): boolean {
  return statSync(target, { throwIfNoEntry: false })?.isFile() ?? false
}

function readProject(relative: string): Readonly<Record<string, unknown>> {
  const parsed = parseJson(readFileSync(path.join(projectRoot, relative), 'utf8'))
  if (!isRecord(parsed)) throw new TypeError(`${relative} がオブジェクトではありません`)
  return parsed
}

// project.json の指定 target から、起動する script の相対パスと scope の値を取り出す。run-*.sh を含まなければ undefined。
function extractScopeInvocation(projectRelative: string, target: string): { script: string, scope: string } | undefined {
  const targets = readProject(projectRelative)['targets']
  const definition = isRecord(targets) ? Reflect.get(targets, target) : undefined
  if (!isRecord(definition)) return undefined
  const options = definition['options']
  if (!isRecord(options)) return undefined
  const commands: string[] = []
  if (typeof options['command'] === 'string') commands.push(options['command'])
  const list = options['commands']
  if (Array.isArray(list)) commands.push(...list.filter((item): item is string => typeof item === 'string'))
  for (const command of commands) {
    const groups = SCOPE_INVOCATION.exec(command)?.groups
    if (groups?.['script'] !== undefined && groups['scope'] !== undefined) return { script: groups['script'], scope: groups['scope'] }
  }
  return undefined
}

// run-*.sh の case パターンから、--scope= の受理値を集める。
function acceptedScopes(script: string): Set<string> {
  return new Set(Array.from(readFileSync(script, 'utf8').matchAll(ACCEPTED_SCOPE), match => match[1] ?? ''))
}

function collectScopeTargets(): ScopeTarget[] {
  const collected: ScopeTarget[] = []
  for (const plugin of PLUGINS) {
    const projectRelative = `plugins/${plugin}/project.json`
    const targets = readProject(projectRelative)['targets']
    const names = isRecord(targets) ? Object.keys(targets) : []
    for (const target of names) {
      const invocation = extractScopeInvocation(projectRelative, target)
      if (invocation !== undefined) {
        collected.push({ label: `${plugin}:${target}`, projectRelative, target, scriptRelative: `plugins/${plugin}/${invocation.script}` })
      }
    }
  }
  return collected
}

const scopeTargets = collectScopeTargets()

describe('project.json の --scope 値', () => {
  it('3 つのプラグインとも、run-*.sh を --scope 付きで起動する target を持つ', () => {
    const plugins = new Set(scopeTargets.map(row => row.projectRelative.split('/', 2)[1]))
    expect(plugins).toEqual(new Set(PLUGINS))
  })

  it.for(scopeTargets)('$label が起動する run-*.sh は実在し、その --scope 値を受理する', (row) => {
    const script = path.join(projectRoot, row.scriptRelative)
    expect(isFile(script), `${row.projectRelative}:${row.target} が起動する ${row.scriptRelative} が無い`).toBe(true)

    const invocation = extractScopeInvocation(row.projectRelative, row.target)
    expect(invocation).toBeDefined()
    const accepted = acceptedScopes(script)
    expect(accepted.has(invocation?.scope ?? ''), `project.json: ${row.projectRelative}:${row.target} の --scope=${invocation?.scope ?? ''} を ${row.scriptRelative} が受理しません。受理値: ${JSON.stringify([...accepted].toSorted(compareStrings))}`).toBe(true)
  })
})

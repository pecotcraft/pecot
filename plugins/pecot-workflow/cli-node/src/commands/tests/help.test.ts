import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { readGolden } from '../../../tests/parity/scenario.js'
import { helpText } from '../help.js'
import { defineCommand } from '../registry.js'
import type { CommandDefinition } from '../registry.js'
import { exitWith } from './support.js'

function define(path: readonly string[], description: string): CommandDefinition {
  return defineCommand({
    path,
    description,
    input: z.object({}),
    positional: [],
    interactive: false,
    run: async () => await exitWith(0),
  })
}

/**
golden の Commands の枠から、名前と説明の組を読む
*/
function commandRows(stdout: string): readonly (readonly [string, string])[] {
  const lines = stdout.split('\n')
  const start = lines.findIndex(line => line.startsWith('╭─ Commands'))
  const end = lines.findIndex((line, index) => index > start && line.startsWith('╰'))
  return lines.slice(start + 1, end).map((line) => {
    const [name = '', ...rest] = line.slice(2, -2).trimEnd().split(/ {2,}/u)
    return [name, rest.join('  ')]
  })
}

// 期待値は Python の CLI の実出力（golden）。コマンドの説明も golden から読む
describe('helpText', () => {
  const rootGolden = readGolden('global-ok-help')
  const groupGolden = readGolden('global-ok-help-group')
  const rootRows = commandRows(rootGolden.stdout)
  const groupNames = new Set(['project', 'issue', 'pr', 'session', 'release', 'security', 'worktree'])
  const leaves = rootRows.filter(([name]) => !groupNames.has(name)).map(([name, description]) => define([name], description))
  const issueCommands = commandRows(groupGolden.stdout).map(([name, description]) => define(['issue', name], description))
  const groups = rootRows.filter(([name]) => groupNames.has(name)).flatMap(([name]) => name === 'issue' ? issueCommands : [define([name, 'dummy'], '')])
  const commands = [...groups, ...leaves]

  it('ルートの --help は Python の書式と一致する（末尾に空行が付く）', () => {
    expect(`${helpText([], commands)}\n`).toBe(rootGolden.stdout)
  })

  it('引数なしの help は --help から末尾の空行を除いたもの', () => {
    expect(helpText([], commands)).toBe(readGolden('global-usage-no-args').stdout)
  })

  it('グループの --help は Python の書式と一致する', () => {
    expect(`${helpText(['issue'], commands)}\n`).toBe(groupGolden.stdout)
  })

  it('単独のコマンドが先、グループが後に並ぶ', () => {
    expect(rootRows.map(([name]) => name)).toEqual([
      'add-to-project',
      'update-issue-status',
      'create-branch',
      'delete-branch',
      'project',
      'issue',
      'pr',
      'session',
      'release',
      'security',
      'worktree',
    ])
  })

  it('golden の 4 つの単独コマンドと 5 つの issue のコマンドを読めている', () => {
    expect(leaves).toHaveLength(4)
    expect(issueCommands).toHaveLength(5)
  })

  it('コマンドが無ければ Commands の枠を出さない', () => {
    expect(helpText([], [])).not.toContain('Commands')
  })

  it('広い端末では説明の列が広がる。説明が長すぎれば … で切る', () => {
    const wide = helpText([], commands, 120).split('\n')
    expect(wide.filter(line => line.startsWith('╭')).map(line => line.length)).toEqual([120, 120])
    const narrow = helpText([], [define(['long'], 'あ'.repeat(60))], 40)
    expect(narrow).toContain('…')
  })
})

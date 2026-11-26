import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { compareStrings } from '../../../tests/parity/baseline.js'
import { COMMON_OUTPUT_KEYS } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { commandNameViolations } from '@pecot/workflow-core/commands-shared/names.js'
import { COMMANDS, defineCommand, findCommand, toolNameOf } from '../registry.js'
import { exitWith } from './support.js'

const COMMAND_COUNT = 45
const GENERATED = path.resolve(import.meta.dirname, '../../../../interface/generated.json')
const HINT_COMMANDS = path.resolve(import.meta.dirname, '../../../../../../libs/workflow-core/tests/_helpers/hint-commands.json')
const EntrySchema = z.object({ id: z.string() })
const GeneratedSchema = z.object({ prefix: z.string(), entries: z.array(EntrySchema) })

describe('コマンドの一覧', () => {
  it('45 個が登録され、path は重複しない', () => {
    expect(COMMANDS).toHaveLength(COMMAND_COUNT)
    expect(new Set(COMMANDS.map(command => command.path.join(' '))).size).toBe(COMMAND_COUNT)
  })

  it('ID の集合が、定義書の項目の ID と同じになる', () => {
    const generated = GeneratedSchema.parse(JSON.parse(readFileSync(GENERATED, 'utf8')))
    const ids = COMMANDS.map(command => `${generated.prefix}-${command.path.join('-').toUpperCase().replaceAll('_', '-')}`)
    expect(ids.toSorted(compareStrings)).toEqual(generated.entries.map(entry => entry.id).toSorted(compareStrings))
  })

  it('全部の path が、コマンド名の決まりに合う', () => {
    expect(commandNameViolations(COMMANDS.map(command => command.path))).toEqual([])
  })

  it('1 語目のグループごとにまとまり、グループは決めた順に並ぶ', () => {
    expect(COMMANDS.map(command => command.path.join(' '))).toEqual([
      'project list', 'project search', 'project init', 'project create', 'project activate', 'project link', 'project get', 'project set', 'project unset',
      'board show', 'board add', 'board move', 'board sync',
      'issue create', 'issue check', 'issue show', 'issue attributes', 'issue edit', 'issue comment', 'issue block', 'issue unblock', 'issue reopen',
      'session start', 'session show', 'session finish',
      'pr create', 'pr show', 'pr check', 'pr merge', 'pr restack',
      'review finish',
      'auto gate', 'auto start', 'auto finish',
      'release check', 'release create', 'release merge',
      'tracker sync',
      'worktree add', 'worktree remove', 'worktree init', 'worktree link',
      'branch delete',
      'workflow install', 'workflow doctor',
    ])
  })

  it.for(COMMANDS.map(command => ({ name: command.path.join(' '), output: command.output })))('$name の output は、入力の向きと出力の向きで JSON Schema が同じになる', ({ output }) => {
    expect(z.toJSONSchema(output, { io: 'input' })).toEqual(z.toJSONSchema(output, { io: 'output' }))
  })

  it('lib のテストが登録するコマンドの形の写しが、登録した形と同じになる', () => {
    const shapes: unknown = JSON.parse(readFileSync(HINT_COMMANDS, 'utf8'))
    expect(shapes).toEqual(COMMANDS.map(command => ({
      path: command.path,
      positional: command.positional,
      inputs: Object.keys(command.input.shape),
      cliOnly: command.cliOnly,
      hasOwnRepo: command.hasOwnRepo,
    })))
  })

  it('toolName は重複せず、path から作られている', () => {
    const names = COMMANDS.map(command => command.toolName)
    expect(new Set(names).size).toBe(names.length)
    for (const command of COMMANDS) expect(command.toolName).toBe(toolNameOf(command.path))
  })

  it('どのコマンドの output も、最上位に MCP の結果の共通の項目の名前を持たない', () => {
    const overlaps = COMMANDS.flatMap(command => COMMON_OUTPUT_KEYS
      .filter(key => Object.hasOwn(command.output.shape, key))
      .map(key => `${command.path.join(' ')}: ${key}`))
    expect(overlaps).toEqual([])
  })
})

describe('findCommand', () => {
  it('path が一致するコマンドを返し、一致しなければ undefined を返す', () => {
    const command = defineCommand({
      path: ['pr', 'read'],
      title: 'Test command',
      description: '',
      input: z.object({}),
      output: z.strictObject({}),
      positional: [],
      interactive: false,
      run: async () => await exitWith(0),
    })
    expect(findCommand(['pr', 'read'], [command])).toBe(command)
    expect(findCommand(['pr', 'undo'], [command])).toBeUndefined()
    expect(findCommand(['pr', 'undo'])).toBeUndefined()
  })
})

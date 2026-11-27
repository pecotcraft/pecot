import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { compareStrings } from '../../../tests/parity/baseline.js'
import { COMMON_OUTPUT_KEYS } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { CLI_HINT_COMMANDS } from '@pecot/workflow-core/commands-shared/hint-catalog.js'
import { commandNameViolations } from '@pecot/workflow-core/commands-shared/names.js'
import { COMMANDS, defineCommand, findCommand, toolNameOf } from '../registry.js'
import { exitWith } from './support.js'

const COMMAND_COUNT = 39
const GENERATED = path.resolve(import.meta.dirname, '../../../../interface/generated.json')
const EntrySchema = z.object({ id: z.string() })
const GeneratedSchema = z.object({ prefix: z.string(), entries: z.array(EntrySchema) })

describe('コマンドの一覧', () => {
  it('39 個が登録され、path は重複しない', async () => {
    await explains('登録済みのコマンドの一覧（`COMMANDS`）のテストです。コマンドが 39 個あり、`path` を空白でつないだ値がすべて異なることを確認します。')
    expect(COMMANDS).toHaveLength(COMMAND_COUNT)
    expect(new Set(COMMANDS.map(command => command.path.join(' '))).size).toBe(COMMAND_COUNT)
  })

  it('コマンドの ID の一覧が、定義書の項目の ID の一覧と一致する', async () => {
    await explains('コマンドと定義書（`generated.json`）の対応のテストです。各コマンドの `path` から作成した ID を並べ替えた一覧が、定義書の項目の ID の一覧と一致することを確認します。')
    const generated = GeneratedSchema.parse(JSON.parse(readFileSync(GENERATED, 'utf8')))
    const ids = COMMANDS.map(command => `${generated.prefix}-${command.path.join('-').toUpperCase().replaceAll('_', '-')}`)
    expect(ids.toSorted(compareStrings)).toEqual(generated.entries.map(entry => entry.id).toSorted(compareStrings))
  })

  it('すべてのコマンドの path が、コマンド名の規則に違反しない', async () => {
    await explains('コマンド名の規則のテストです。登録済みのすべてのコマンドの `path` について、`commandNameViolations` が違反を 1 件も返さないことを確認します。')
    expect(commandNameViolations(COMMANDS.map(command => command.path))).toEqual([])
  })

  it('コマンドは、1 語目のグループごとにまとめ、決められた順に並べる', async () => {
    await explains('コマンドの並び順のテストです。登録済みのコマンドが、`project`・`board`・`issue` などのグループごとにまとまり、グループと各コマンドが決められた順に並ぶことを確認します。')
    expect(COMMANDS.map(command => command.path.join(' '))).toEqual([
      'project list', 'project search', 'project init', 'project create', 'project activate', 'project link', 'project get', 'project set', 'project unset',
      'board show', 'board add', 'board move',
      'issue create', 'issue check', 'issue show', 'issue attributes', 'issue edit', 'issue comment', 'issue block', 'issue unblock', 'issue reopen',
      'session start', 'session show', 'session finish',
      'pr create', 'pr show', 'pr check', 'pr merge', 'pr restack',
      'release check', 'release create', 'release merge',
      'worktree add', 'worktree remove', 'worktree init', 'worktree link',
      'branch delete',
      'workflow install', 'workflow doctor',
    ])
  })

  it.for(COMMANDS.map(command => ({ name: command.path.join(' '), output: command.output })))('$name の output は、入力の向きと出力の向きで JSON Schema が同じになる', async ({ output }) => {
    await explains('各コマンドの `output` の JSON Schema のテストです。入力の向き（`input`）で変換した結果と、出力の向き（`output`）で変換した結果が一致することを確認します。')
    expect(z.toJSONSchema(output, { io: 'input' })).toEqual(z.toJSONSchema(output, { io: 'output' }))
  })

  it('lib の案内の一覧の CLI の形が、登録した形と同じになる', async () => {
    await explains('`libs/workflow-core` の案内に使うコマンドの一覧（`CLI_HINT_COMMANDS`）のテストです。一覧の `path`・位置引数・入力名・`cliOnly`・`hasOwnRepo` が、登録済みのコマンドの値と一致することを確認します。')
    expect(CLI_HINT_COMMANDS).toEqual(COMMANDS.map(command => ({
      path: command.path,
      positional: command.positional,
      inputs: Object.keys(command.input.shape),
      cliOnly: command.cliOnly,
      hasOwnRepo: command.hasOwnRepo,
    })))
  })

  it('toolName が重複せず、path から作成した名前と一致する', async () => {
    await explains('コマンドの `toolName` のテストです。登録済みのコマンドの `toolName` が重複せず、`toolNameOf` が `path` から作成した名前と一致することを確認します。')
    const names = COMMANDS.map(command => command.toolName)
    expect(new Set(names).size).toBe(names.length)
    for (const command of COMMANDS) expect(command.toolName).toBe(toolNameOf(command.path))
  })

  it('どのコマンドの output も、最上位に MCP の結果の共通の項目の名前を含まない', async () => {
    await explains('MCP の結果に共通する項目の名前（`COMMON_OUTPUT_KEYS`）のテストです。登録済みのどのコマンドの `output` も、最上位にその名前を持たないことを確認します。')
    const overlaps = COMMANDS.flatMap(command => COMMON_OUTPUT_KEYS
      .filter(key => Object.hasOwn(command.output.shape, key))
      .map(key => `${command.path.join(' ')}: ${key}`))
    expect(overlaps).toEqual([])
  })
})

describe('findCommand', () => {
  it('path が一致するコマンドを返し、一致しなければ undefined を返す', async () => {
    await explains('コマンドを探す `findCommand` のテストです。`path` が一致する場合はそのコマンドを返し、一致しない場合は `undefined` を返すことを確認します。')
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

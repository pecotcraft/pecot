/* eslint-disable security/detect-non-literal-fs-filename -- 読むのはこのリポの action.yml だけ */
// lib の案内の一覧の actions/ の形が、action.yml の inputs と合うかを確かめる。
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { ACTION_HINT_COMMANDS, TOOL_HINT_COMMANDS } from '@pecot/workflow-core/commands-shared/hint-catalog.js'

import { explains } from './_helpers/explains.js'

const ACTIONS_ROOT = path.resolve(import.meta.dirname, '..')

// token は案内に出さない。kebab-case の input を、案内の形の snake_case にする
function actionInputs(name: string): string[] {
  const action: unknown = parse(readFileSync(path.join(ACTIONS_ROOT, name, 'action.yml'), 'utf8'))
  const inputs: unknown = typeof action === 'object' && action !== null ? Reflect.get(action, 'inputs') : undefined
  if (typeof inputs !== 'object' || inputs === null) throw new TypeError(`${name}/action.yml に inputs がありません`)
  return Object.keys(inputs).filter(input => input !== 'token').map(input => input.replaceAll('-', '_')).toSorted((first, second) => first.localeCompare(second))
}

describe('ACTION_HINT_COMMANDS', () => {
  it.for(ACTION_HINT_COMMANDS.map(shape => ({ name: shape.name.replaceAll('_', '-'), inputs: shape.inputs })))('$name の形の inputs が、action.yml の token 以外の inputs と同じになる', async (row) => {
    await explains(`次に打つ操作の案内に使う \`ACTION_HINT_COMMANDS\` の \`${row.name}\` の形のテストです。形の \`inputs\` が、\`${row.name}/action.yml\` の \`token\` を除いた \`inputs\` を snake_case にしたものと一致することを確認します。`)
    expect([...row.inputs].toSorted((first, second) => first.localeCompare(second))).toEqual(actionInputs(row.name))
  })

  it('ツールの形と同じ name を持たない', async () => {
    await explains('操作の案内に使う `ACTION_HINT_COMMANDS` のテストです。action の形の `name` に、ツールの形の一覧 `TOOL_HINT_COMMANDS` と同じものが存在しないことを確認します。')
    const toolNames = new Set(TOOL_HINT_COMMANDS.map(shape => shape.name))
    expect(ACTION_HINT_COMMANDS.map(shape => shape.name).filter(name => toolNames.has(name))).toEqual([])
  })
})

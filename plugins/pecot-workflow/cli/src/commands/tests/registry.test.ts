import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { z } from 'zod'

import { compareStrings } from '../../../tests/parity/baseline.js'
import { COMMON_OUTPUT_KEYS, interfaceIdOf } from '@pecot/workflow-core/commands-shared/command-definition.js'
import { TOOL_HINT_COMMANDS } from '@pecot/workflow-core/commands-shared/hint-catalog.js'
import { toolNameViolations } from '@pecot/workflow-core/commands-shared/names.js'
import { TOOLS } from '../registry.js'

const TOOL_COUNT = 25
const GENERATED = path.resolve(import.meta.dirname, '../../../../interface/generated.json')
const EntrySchema = z.object({ id: z.string() })
const GeneratedSchema = z.object({ entries: z.array(EntrySchema) })

describe('ツールの一覧', () => {
  it('25 個が登録され、名前は重複しない', async () => {
    await explains('登録済みのツールの一覧（`TOOLS`）のテストです。ツールが 25 個あり、名前がすべて異なることを確認します。')
    expect(TOOLS).toHaveLength(TOOL_COUNT)
    expect(new Set(TOOLS.map(tool => tool.name)).size).toBe(TOOL_COUNT)
  })

  it('ツールの ID の一覧が、定義書の項目の ID の一覧と一致する', async () => {
    await explains('ツールと定義書（`generated.json`）の対応のテストです。各ツールの名前から作成した ID を並べ替えた一覧が、定義書の項目の ID の一覧と一致することを確認します。')
    const generated = GeneratedSchema.parse(JSON.parse(readFileSync(GENERATED, 'utf8')))
    const ids = TOOLS.map(tool => interfaceIdOf(tool.name))
    expect(ids.toSorted(compareStrings)).toEqual(generated.entries.map(entry => entry.id).toSorted(compareStrings))
  })

  it('すべてのツールの名前が、ツール名の規則に違反しない', async () => {
    await explains('ツール名の規則のテストです。登録済みのすべてのツールの名前について、`toolNameViolations` が違反を 1 件も返さないことを確認します。')
    expect(toolNameViolations(TOOLS.map(tool => tool.name))).toEqual([])
  })

  it('ツールは、1 語目のグループごとにまとめ、決められた順に並べる', async () => {
    await explains('ツールの並び順のテストです。登録済みのツールが、`project`・`board`・`issue` などのグループごとにまとまり、グループと各ツールが決められた順に並ぶことを確認します。')
    expect(TOOLS.map(tool => tool.name)).toEqual([
      'project_list', 'project_check', 'project_activate', 'project_link', 'project_get', 'project_set', 'project_unset',
      'board_show', 'board_check',
      'issue_check', 'issue_dependency_check', 'issue_comment_check',
      'session_start', 'session_show', 'session_finish',
      'pr_check', 'pr_restack',
      'release_check',
      'worktree_add', 'worktree_remove', 'worktree_init', 'worktree_link',
      'branch_check',
      'workflow_install', 'workflow_doctor',
    ])
  })

  it.for(TOOLS.map(tool => ({ name: tool.name, output: tool.output })))('$name の output は、入力の向きと出力の向きで JSON Schema が同じになる', async ({ output }) => {
    await explains('各ツールの `output` の JSON Schema のテストです。入力の向き（`input`）で変換した結果と、出力の向き（`output`）で変換した結果が一致することを確認します。')
    expect(z.toJSONSchema(output, { io: 'input' })).toEqual(z.toJSONSchema(output, { io: 'output' }))
  })

  it('lib の案内の一覧のツールの形が、登録した形と同じになる', async () => {
    await explains('`libs/workflow-core` の案内に使うツールの一覧（`TOOL_HINT_COMMANDS`）のテストです。一覧のツール名と入力名が、登録済みのツールの値と同じ順で一致することを確認します。')
    expect(TOOL_HINT_COMMANDS).toEqual(TOOLS.map(tool => ({ name: tool.name, inputs: Object.keys(tool.input.shape) })))
  })

  it('どのツールの output も、最上位に MCP の結果の共通の項目の名前を含まない', async () => {
    await explains('MCP の結果に共通する項目の名前（`COMMON_OUTPUT_KEYS`）のテストです。登録済みのどのツールの `output` も、最上位にその名前を持たないことを確認します。')
    const overlaps = TOOLS.flatMap(tool => COMMON_OUTPUT_KEYS
      .filter(key => Object.hasOwn(tool.output.shape, key))
      .map(key => `${tool.name}: ${key}`))
    expect(overlaps).toEqual([])
  })
})

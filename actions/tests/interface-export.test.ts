/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from './_helpers/explains.js'
import { exportEntries, main } from '../scripts/export-interface.js'
import { makeTemporaryDirectory, writeTree } from '../../libs/workflow-core/tests/_helpers/temporary.js'

interface Captured {
  readonly io: { readonly stdout: (text: string) => void, readonly stderr: (text: string) => void }
  readonly errors: string[]
}

function capture(): Captured {
  const errors: string[] = []
  const io = {
    stdout: (): void => undefined,
    stderr: (text: string): void => {
      errors.push(text)
    },
  }
  return { io, errors }
}

const ACTION = `name: pecot board sync
description: Move board items by the readiness of their Issues
inputs:
  token:
    description: GitHub token
    required: true
  dry-run:
    description: Print the plan without writing
    default: 'false'
outputs:
  moved:
    description: Number of moved items
runs:
  using: node24
  main: dist/index.js
`

describe('export-interface', () => {
  it('action.yml の inputs と outputs から、action の面を持つ項目を作る', async () => {
    await explains('定義書の項目を作る `exportEntries` のテストです。`action.yml` を 1 つ置いた場合に、`inputs` を入力のスキーマに、`outputs` を action の出力に写した項目を作ることを確認します。')
    const root = makeTemporaryDirectory('pecot-export-')
    writeTree(root, { 'board-sync/action.yml': ACTION, 'templates/x.yml': 'x: 1\n' })
    expect(exportEntries(root)).toEqual([{
      id: 'PA-BOARD-SYNC',
      name: 'board sync',
      description: 'Move board items by the readiness of their Issues',
      surfaces: { action: { path: 'actions/board-sync' } },
      hidden: false,
      deprecated: false,
      input: {
        type: 'object',
        properties: {
          'dry-run': { type: 'string', default: 'false', description: 'Print the plan without writing' },
          'token': { type: 'string', description: 'GitHub token' },
        },
        required: ['token'],
        additionalProperties: false,
      },
      action: { outputs: { moved: 'Number of moved items' } },
    }])
  })

  it('--write で書いたものを --check が通し、変わると stale を返す', async () => {
    await explains('`scripts/export-interface.ts` の `main` のテストです。`--write` で書き出した定義書を `--check` が通し、`action.yml` を変更した後の `--check` は `is stale` を出して 1 を返すことを確認します。')
    const root = makeTemporaryDirectory('pecot-export-')
    writeTree(root, { 'board-sync/action.yml': ACTION })
    const target = path.join(root, 'generated.json')
    const written = capture()
    expect(main(['--write'], written.io, { root, target })).toBe(0)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ plugin: 'pecot-actions', prefix: 'PA' })
    expect(main(['--check'], capture().io, { root, target })).toBe(0)
    writeTree(root, { 'board-sync/action.yml': ACTION.replace('Number of moved items', 'Moved items') })
    const checked = capture()
    expect(main(['--check'], checked.io, { root, target })).toBe(1)
    expect(checked.errors.join('')).toContain('is stale')
  })

  it('引数が --check・--write でないと、使い方を出して 2 を返す', async () => {
    await explains('`scripts/export-interface.ts` の `main` のテストです。引数を渡さない場合に、標準エラーに使い方を出して 2 を返すことを確認します。')
    const result = capture()
    expect(main([], result.io)).toBe(2)
    expect(result.errors.join('')).toContain('usage')
  })

  it('リポの generated.json は action.yml から作り直したものと同じ', async () => {
    await explains('commit した `actions/interface/generated.json` のテストです。リポの `action.yml` から作り直した定義書と一致し、`--check` が 0 を返すことを確認します。')
    const result = capture()
    expect(main(['--check'], result.io)).toBe(0)
  })
})

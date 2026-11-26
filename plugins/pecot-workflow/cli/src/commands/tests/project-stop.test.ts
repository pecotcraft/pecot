// project まわりの、止まり方と上限の振る舞い（保存より前の NAME の検証、パスが辿れない時の案内、並列数の上限、ID の無い Archived）。
import { describe, expect, it, vi } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { runCommand } from '../../../tests/_helpers/command-harness.js'
import { useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { mapWithLimit, pruneArchivedItems } from '@pecot/workflow-core/commands-shared/board-view.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { capture } from './support.js'
import { parseProjectConfig } from '@pecot/workflow-core/domain/config.js'
import type { BoardItem } from '@pecot/workflow-core/domain/format.js'

useIsolatedEnvironment()

describe('project link の --package', () => {
  it('NAME の形が不正だと、GitHub を呼ぶ前に終了コード 1 で止まる', async () => {
    await explains('`project link` の `--package` のテストです。名前の形が不正な場合に、GitHub を呼ばず、終了コード `1` で検証エラーを表示して終了することを確認します。')
    const result = await runCommand({ argv: ['project', 'link', 'acme/other', '--package', 'b!d:x/CHANGELOG.md'] })
    expect(result.code).toBe(1)
    expect(result.requests).toEqual([])
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: 1 validation error for Package\n {2}name\n {4}String should match pattern '\^\[A-Za-z0-9_\.-\]\+\$'/u)
    expect(result.stderr).not.toContain('added:')
  })
})

describe('project activate のパス', () => {
  it('ファイルの下を指すパス（ENOTDIR）は設定ファイルとみなさず、--host の案内で終わる', async () => {
    await explains('`project activate` に、ファイルの下を指すパス `package.json/x` を渡した場合のテストです。設定ファイルとして扱わず、`--host` の指定を求めるエラーを表示し、GitHub を呼ばないことを確認します。')
    const result = await runCommand({ argv: ['project', 'activate', 'package.json/x'], files: { 'package.json': '{}\n' } })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: --host is required')
    expect(result.requests).toEqual([])
  })
})

describe('mapWithLimit', () => {
  it('同時に動かす数を上限までに抑え、結果は入力の順で返す', async () => {
    await explains('並列に処理する `mapWithLimit` のテストです。20 件の項目を上限 8 で処理した場合に、同時に動く数が最大 8 になり、完了の順が入れ替わっても、結果が入力の順に並ぶことを確認します。')
    let running = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, index) => index)
    const results = await mapWithLimit(items, 8, async (item) => {
      running += 1
      peak = Math.max(peak, running)
      // 後ろの項目ほど早く終わらせ、完了の順が入力の順と変わるようにする
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20 - item)
      })
      running -= 1
      return item * 2
    })
    expect(peak).toBe(8)
    expect(results).toEqual(items.map(item => item * 2))
  })

  it('項目が上限より少なければ、項目の数だけ動かす', async () => {
    await explains('並列に処理する `mapWithLimit` のテストです。項目が 2 件で上限が 8 の場合に、2 件の結果を入力の順に返すことを確認します。')
    const results = await mapWithLimit(['a', 'b'], 8, async (item) => {
      await Promise.resolve()
      return item.toUpperCase()
    })
    expect(results).toEqual(['A', 'B'])
  })

  it('項目が存在しなければ、空の配列を返す', async () => {
    await explains('並列に処理する `mapWithLimit` のテストです。項目が 1 件も存在しない場合に、空の配列を返すことを確認します。')
    expect(await mapWithLimit([], 8, async (item: string) => {
      await Promise.resolve()
      return item
    })).toEqual([])
  })
})

const archived = (index: number, id: string | number | undefined): BoardItem => ({ id, workflow: 'Archived', updatedAt: `2026-01-${String(30 - index).padStart(2, '0')}`, content: {} })

describe('pruneArchivedItems', () => {
  const config = parseProjectConfig({
    host: 'github.com',
    owner: 'o',
    project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'F', options: {} } } },
    repositories: [],
  })

  it('ID が文字列でないアイテムは、削除を呼ばず、失敗として数えて返す', async () => {
    await explains('Archived のアイテムを削除する `pruneArchivedItems` のテストです。新しい順に 20 件を残して 3 件が対象になり、ID が数値の 1 件は削除せずに失敗として数え、2 件を削除して、結果と警告を表示することを確認します。')
    // 新しい順に 20 件を残し、後ろの 3 件が対象。そのうち 1 件は ID が数値
    const items = Array.from({ length: 23 }, (_, index) => archived(index, index === 21 ? 7 : `item-${String(index)}`))
    const deleteProjectItem = vi.fn().mockResolvedValue(undefined)
    const io = capture()
    expect(await pruneArchivedItems(createOutput(false, io), { deleteProjectItem }, config, items, false)).toEqual({ deleted: 2, failed: 1 })
    expect(deleteProjectItem.mock.calls).toEqual([['PVT_1', 'item-20'], ['PVT_1', 'item-22']])
    expect(io.err.join('')).toBe('deleted: 2 archived items\nwarning: failed to delete 1 archived items\n')
  })

  it('dry-run では削除を呼ばず、削除する予定の件数を表示する', async () => {
    await explains('Archived のアイテムを削除する `pruneArchivedItems` のテストです。dry-run の場合に、削除を呼ばず、`dry-run: would delete 3 archived items` の行を表示することを確認します。')
    const items = Array.from({ length: 23 }, (_, index) => archived(index, `item-${String(index)}`))
    const deleteProjectItem = vi.fn().mockResolvedValue(undefined)
    const io = capture()
    expect(await pruneArchivedItems(createOutput(true, io), { deleteProjectItem }, config, items, true)).toEqual({ deleted: 3, failed: 0 })
    expect(deleteProjectItem).not.toHaveBeenCalled()
    expect(io.err.join('') + io.out.join('')).toBe('dry-run: would delete 3 archived items\n')
  })

  it('Archived が 20 件以下の場合は、削除を呼ばず、行を表示しない', async () => {
    await explains('Archived のアイテムを削除する `pruneArchivedItems` のテストです。アイテムが 20 件の場合に、削除を呼ばず、何も表示せず、結果が削除 0 件・失敗 0 件になることを確認します。')
    const items = Array.from({ length: 20 }, (_, index) => archived(index, `item-${String(index)}`))
    const deleteProjectItem = vi.fn().mockResolvedValue(undefined)
    const io = capture()
    expect(await pruneArchivedItems(createOutput(false, io), { deleteProjectItem }, config, items, false)).toEqual({ deleted: 0, failed: 0 })
    expect(deleteProjectItem).not.toHaveBeenCalled()
    expect(io.err.join('') + io.out.join('')).toBe('')
  })
})

describe('位置引数の選択肢', () => {
  it.for([
    { name: 'project get の key', argv: ['project', 'get'] },
    { name: 'project set の key', argv: ['project', 'set'] },
    { name: 'project unset の key', argv: ['project', 'unset'] },
    { name: 'tracker sync の source', argv: ['tracker', 'sync'] },
  ])('$name を省くと、GitHub と設定を読まずに終了コード 2 で止まる', async ({ argv }) => {
    await explains('`project get` などの `key` と `tracker sync` の `source` を省略した場合のテストです。何も読み込まず、終了コード `2` で `Missing argument` の使い方の誤りを表示することを確認します。')
    const result = await runCommand({ argv })
    expect(result.code).toBe(2)
    expect(result.requests).toEqual([])
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`Usage: pecot ${argv.join(' ')} [OPTIONS]`)
    expect(result.stderr).toMatch(/Missing argument '(key|source)'\./u)
  })

  it.for([
    { name: 'project get の選択肢にない key', argv: ['project', 'get', 'develop_branch'], message: 'Invalid value for \'key\': \'develop_branch\' is not one of \'aggregation_repo\'.' },
    { name: 'project set の選択肢にない key', argv: ['project', 'set', 'develop_branch', 'a/b'], message: 'Invalid value for \'key\': \'develop_branch\' is not one of \'aggregation_repo\'.' },
    { name: 'project unset の選択肢にない key', argv: ['project', 'unset', 'develop_branch'], message: 'Invalid value for \'key\': \'develop_branch\' is not one of \'aggregation_repo\'.' },
    { name: 'tracker sync の選択肢にない source', argv: ['tracker', 'sync', 'codeql'], message: 'Invalid value for \'source\': \'codeql\' is not one of \'dependabot\', \'security\'.' },
  ])('$name を渡すと、何も読まずに終了コード 2 で止まる', async ({ argv, message }) => {
    await explains('位置引数へ選択肢以外の値を渡した場合のテストです。`key` や `source` が対象の場合に、何も読み込まず、終了コード `2` で `is not one of …` の使い方の誤りを表示することを確認します。')
    const result = await runCommand({ argv })
    expect(result.code).toBe(2)
    expect(result.requests).toEqual([])
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(message)
  })
})

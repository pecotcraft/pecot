// project まわりの、止まり方と上限の振る舞い（保存より前の NAME の検証、パスが辿れない時の案内、並列数の上限、ID の無い Archived）。
import { describe, expect, it, vi } from 'vitest'

import { runCommand } from '../../../tests/_helpers/command-harness.js'
import { useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { mapWithLimit, pruneArchivedItems } from '../project-info.js'
import { createOutput } from '../output.js'
import { capture } from './support.js'
import { parseProjectConfig } from '../../domain/config.js'
import type { BoardItem } from '../../domain/format.js'

useIsolatedEnvironment()

describe('repo set の --package', () => {
  it('NAME の形が不正だと、GitHub を呼ぶ前に終了コード 1 で止まる', async () => {
    const result = await runCommand({ argv: ['repo', 'set', 'acme/other', '--package', 'b!d:x/CHANGELOG.md'] })
    expect(result.code).toBe(1)
    expect(result.requests).toEqual([])
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/^error: 1 validation error for Package\n {2}name\n {4}String should match pattern '\^\[A-Za-z0-9_\.-\]\+\$'/u)
    expect(result.stderr).not.toContain('added:')
  })
})

describe('project activate のパス', () => {
  it('ファイルの下を指すパス（ENOTDIR）は設定ファイルとみなさず、--host の案内で終わる', async () => {
    const result = await runCommand({ argv: ['project', 'activate', 'package.json/x'], files: { 'package.json': '{}\n' } })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: --host is required')
    expect(result.requests).toEqual([])
  })
})

describe('mapWithLimit', () => {
  it('同時に動かす数を上限までに抑え、結果は入力の順で返す', async () => {
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
    const results = await mapWithLimit(['a', 'b'], 8, async (item) => {
      await Promise.resolve()
      return item.toUpperCase()
    })
    expect(results).toEqual(['A', 'B'])
  })

  it('項目が無ければ空を返す', async () => {
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
    workflow_suffix: 's',
    project: { number: 1, id: 'PVT_1', fields: { workflow: { id: 'F', options: {} } } },
    repositories: [],
  })

  it('ID が文字列でないアイテムは、削除を呼ばず、失敗として数える', async () => {
    // 新しい順に 20 件を残し、後ろの 3 件が対象。そのうち 1 件は ID が数値
    const items = Array.from({ length: 23 }, (_, index) => archived(index, index === 21 ? 7 : `item-${String(index)}`))
    const deleteProjectItem = vi.fn().mockResolvedValue(undefined)
    const io = capture()
    await pruneArchivedItems(createOutput(false, io), { deleteProjectItem }, config, items)
    expect(deleteProjectItem.mock.calls).toEqual([['PVT_1', 'item-20'], ['PVT_1', 'item-22']])
    expect(io.err.join('')).toBe('deleted: 2 archived items\nwarning: failed to delete 1 archived items\n')
  })
})

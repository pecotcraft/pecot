import { describe, expect, it, vi } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
import { settle } from '../tracker-sync.js'

function capture(isDryRun: boolean): string {
  const chunks: string[] = []
  const stderr = (text: string): void => {
    chunks.push(text)
  }
  settle(createOutput(isDryRun, { stdout: vi.fn(), stderr }), { verb: 'skip', target: 'step' })
  return chunks.join('')
}

describe('settle', () => {
  it('dry-run の場合は、実行予定の行だけを標準エラー出力に表示する', async () => {
    await explains('処理の結果を表示する `settle` のテストです。dry-run の場合に、`dry-run: would skip step` の 1 行だけを標準エラー出力に表示することを確認します。')
    expect(capture(true)).toBe('dry-run: would skip step\n')
  })

  it('実行する場合は、結果の行だけを標準エラー出力に表示する', async () => {
    await explains('処理の結果を表示する `settle` のテストです。dry-run でない通常の実行の場合に、`skipped: step` の 1 行だけを標準エラー出力に表示することを確認します。')
    expect(capture(false)).toBe('skipped: step\n')
  })
})

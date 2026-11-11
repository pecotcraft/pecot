import { describe, expect, it, vi } from 'vitest'

import { createOutput } from '../output.js'
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
  it('dry-run では計画の行だけを出す', () => {
    expect(capture(true)).toBe('dry-run: would skip step\n')
  })

  it('実行では結果の行だけを出す', () => {
    expect(capture(false)).toBe('skipped: step\n')
  })
})

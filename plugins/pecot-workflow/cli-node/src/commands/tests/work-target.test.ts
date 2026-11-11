/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
import { createOutput } from '../output.js'
import { recordWorkTarget } from '../work-target.js'
import { capture } from './support.js'

useIsolatedEnvironment()

function useProject(): string {
  const root = makeTemporaryDirectory()
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  return root
}

// .pecot がファイルだと、状態ファイルを書けない
function useBrokenProject(): void {
  writeFileSync(path.join(useProject(), '.pecot'), '')
}

describe('recordWorkTarget', () => {
  it('作業対象を書き、作業ディレクトリつきの set の行を出す', () => {
    const root = useProject()
    const io = capture()
    expect(recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 'title', { failWithExit: false })).toBeUndefined()
    expect(io.err).toEqual(['set: work target acme/demo/7 (work directory .pecot/work/7/)\n'])
    expect(io.out).toEqual([])
    expect(readFileSync(path.join(root, '.pecot', 'state', '.pecot-active'), 'utf8')).toContain('acme/demo/7')
    expect(existsSync(path.join(root, '.pecot', 'work', '7'))).toBe(true)
  })

  it('failWithExit が偽なら失敗を warning にし、undefined を返す', () => {
    useBrokenProject()
    const io = capture()
    expect(recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 'title', { failWithExit: false })).toBeUndefined()
    expect(io.err).toHaveLength(1)
    expect(io.err[0]).toMatch(/^warning: could not record the work target: \[Errno \d+\] .+\n$/u)
  })

  it('failWithExit で失敗すると、error の行を出して終了コード 1 を返す', () => {
    useBrokenProject()
    const io = capture()
    expect(recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 'title', { failWithExit: true })).toBe(1)
    expect(io.err).toHaveLength(1)
    expect(io.err[0]).toMatch(/^error: could not record the work target: \[Errno \d+\] .+\n$/u)
  })

  it('dry-run の出力では set の行を出さない', () => {
    useProject()
    const io = capture()
    recordWorkTarget(createOutput(true, io), 'acme', 'demo', 7, 'title', { failWithExit: false })
    expect(io.err).toEqual([])
  })
})

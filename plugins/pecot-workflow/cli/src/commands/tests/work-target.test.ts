/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは一時リポ配下だけ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createGitRepository } from '../../tests/_helpers/git-repository.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { writeTree } from '../../tests/_helpers/temporary.js'
import { CommandExit } from '../command-definition.js'
import { createOutput } from '../output.js'
import { recordWorkTarget } from '../work-target.js'
import { capture } from './support.js'

useIsolatedEnvironment()

function projectDirectory(files?: Readonly<Record<string, string>>): string {
  const directory = createGitRepository()
  if (files !== undefined) writeTree(directory, files)
  setEnvironment({ CLAUDE_PROJECT_DIR: directory })
  return directory
}

describe('recordWorkTarget', () => {
  it('作業対象を書き、set の行を出す', () => {
    const directory = projectDirectory()
    const io = capture()
    recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, '見本の Issue')
    expect(io.err.join('')).toBe('set: work target acme/demo/7 (work directory .pecot/work/7/)\n')
    expect(readFileSync(path.join(directory, '.pecot/state/.pecot-active'), 'utf8')).toBe('acme/demo/7')
    expect(readFileSync(path.join(directory, '.pecot/state/.pecot-session-title'), 'utf8')).toBe('#7 見本の Issue')
    expect(existsSync(path.join(directory, '.pecot/work/7'))).toBe(true)
  })

  it('書けないと、failWithExit が無ければ warning の行を出して戻る', () => {
    projectDirectory({ '.pecot/state': 'file' })
    const io = capture()
    recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toMatch(/^warning: could not record the work target: .+\n$/u)
  })

  it('failWithExit なら、error の行を出して CommandExit(1) を投げる', () => {
    projectDirectory({ '.pecot/state': 'file' })
    const io = capture()
    let thrown: unknown
    try {
      recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't', { failWithExit: true })
    }
    catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CommandExit)
    expect(thrown).toMatchObject({ exitCode: 1 })
    expect(io.err.join('')).toMatch(/^error: could not record the work target: .+\n$/u)
  })

  it('前の .pecot-base を消し、options.base があれば新しく書く', () => {
    const directory = projectDirectory({ '.pecot/state/.pecot-base': 'old' })
    const base = path.join(directory, '.pecot/state/.pecot-base')
    recordWorkTarget(createOutput(false, capture()), 'acme', 'demo', 7, 't')
    expect(existsSync(base)).toBe(false)
    recordWorkTarget(createOutput(false, capture()), 'acme', 'demo', 7, 't', { base: { branch: 'main', sha: '0'.repeat(40), stackedOn: undefined } })
    expect(readFileSync(base, 'utf8')).toBe(`main ${'0'.repeat(40)}`)
  })

  it('.pecot-base を消せないと、could not record the base の warning を出す', () => {
    projectDirectory({ '.pecot/state/.pecot-base/keep': 'x' })
    const io = capture()
    recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toMatch(/^warning: could not record the base: .+\n/u)
  })
})

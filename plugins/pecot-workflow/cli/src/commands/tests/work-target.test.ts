/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは一時リポ配下だけ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createGitRepository } from '../../tests/_helpers/git-repository.js'
import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { writeTree } from '../../tests/_helpers/temporary.js'
import { createOutput } from '../output.js'
import { planWorkTarget, recordWorkTarget } from '../work-target.js'
import { capture } from './support.js'

useIsolatedEnvironment()

function projectDirectory(files?: Readonly<Record<string, string>>): string {
  const directory = createGitRepository()
  if (files !== undefined) writeTree(directory, files)
  setEnvironment({ CLAUDE_PROJECT_DIR: directory })
  return directory
}

describe('recordWorkTarget', () => {
  it('セッション名のキャッシュと作業ディレクトリを作り、作業ディレクトリを作った行を出す。.pecot-active は書かない', () => {
    const directory = projectDirectory()
    const io = capture()
    const recorded = recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, '見本の Issue')
    expect(io.err.join('')).toBe('created: work directory .pecot/work/7/\n')
    expect(readFileSync(path.join(directory, '.pecot/state/.pecot-session-title'), 'utf8')).toBe('#7 見本の Issue')
    expect(existsSync(path.join(directory, '.pecot/state/.pecot-active'))).toBe(false)
    expect(recorded).toEqual({ status: 'recorded', issue: 'acme/demo/7', workDirectory: path.join(directory, '.pecot/work/7') })
  })

  it('作業ディレクトリがすでにあっても、同じ行を出す', () => {
    projectDirectory({ '.pecot/work/7/keep': 'x' })
    const io = capture()
    recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toBe('created: work directory .pecot/work/7/\n')
  })

  it('作業ディレクトリを作れないと、warning の行を出して戻る', () => {
    const directory = projectDirectory({ '.pecot/work': 'file' })
    const io = capture()
    const recorded = recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toBe('warning: could not create work directory .pecot/work/7/\n')
    expect(readFileSync(path.join(directory, '.pecot/state/.pecot-session-title'), 'utf8')).toBe('#7 t')
    expect(recorded).toEqual({ status: 'recorded', issue: 'acme/demo/7', workDirectory: undefined })
  })

  it('書けないと、warning の行を出して戻る', () => {
    projectDirectory({ '.pecot/state': 'file' })
    const io = capture()
    const recorded = recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toMatch(/^warning: could not record the work target: .+\n$/u)
    expect(recorded).toEqual({ status: 'failed', issue: 'acme/demo/7' })
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

describe('planWorkTarget', () => {
  it('作業ディレクトリを作る予行の行を出し、何も書かない', () => {
    const directory = projectDirectory()
    const io = capture()
    planWorkTarget(createOutput(true, io), 7)
    expect(io.err.join('')).toBe('dry-run: would create work directory .pecot/work/7/\n')
    expect(existsSync(path.join(directory, '.pecot'))).toBe(false)
  })
})

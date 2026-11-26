/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは一時リポ配下だけ */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { createGitRepository } from '../../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { writeTree } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { createOutput } from '@pecot/workflow-core/commands-shared/output.js'
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
  it('セッション名のキャッシュと作業ディレクトリを作成し、作成した旨の行を表示する。.pecot-active は書き込まない', async () => {
    await explains('作業対象を記録する `recordWorkTarget` のテストです。セッション名のファイルと作業ディレクトリ `.pecot/work/7` を作成して `created: work directory` を表示し、`.pecot-active` は書き込まないことを確認します。')
    const directory = projectDirectory()
    const io = capture()
    const recorded = recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, '見本の Issue')
    expect(io.err.join('')).toBe('created: work directory .pecot/work/7/\n')
    expect(readFileSync(path.join(directory, '.pecot/state/.pecot-session-title'), 'utf8')).toBe('#7 見本の Issue')
    expect(existsSync(path.join(directory, '.pecot/state/.pecot-active'))).toBe(false)
    expect(recorded).toEqual({ status: 'recorded', issue: 'acme/demo/7', workDirectory: path.join(directory, '.pecot/work/7') })
  })

  it('作業ディレクトリが既に存在する場合も、同じ行を表示する', async () => {
    await explains('作業対象を記録する `recordWorkTarget` のテストです。作業ディレクトリ `.pecot/work/7` が既に存在する場合でも、`created: work directory .pecot/work/7/` の行を表示することを確認します。')
    projectDirectory({ '.pecot/work/7/keep': 'x' })
    const io = capture()
    recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toBe('created: work directory .pecot/work/7/\n')
  })

  it('作業ディレクトリを作成できない場合は、warning の行を表示して処理を続ける', async () => {
    await explains('`.pecot/work` がファイルで、作業ディレクトリを作成できない場合のテストです。`warning: could not create work directory` を表示し、セッション名は書き込み、`workDirectory` は `undefined` になることを確認します。')
    const directory = projectDirectory({ '.pecot/work': 'file' })
    const io = capture()
    const recorded = recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toBe('warning: could not create work directory .pecot/work/7/\n')
    expect(readFileSync(path.join(directory, '.pecot/state/.pecot-session-title'), 'utf8')).toBe('#7 t')
    expect(recorded).toEqual({ status: 'recorded', issue: 'acme/demo/7', workDirectory: undefined })
  })

  it('作業対象を書き込めない場合は、warning の行を表示して failed を返す', async () => {
    await explains('`.pecot/state` がファイルで、作業対象を書き込めない場合のテストです。`warning: could not record the work target` の行を表示し、`status` が `failed` の結果を返すことを確認します。')
    projectDirectory({ '.pecot/state': 'file' })
    const io = capture()
    const recorded = recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toMatch(/^warning: could not record the work target: .+\n$/u)
    expect(recorded).toEqual({ status: 'failed', issue: 'acme/demo/7' })
  })

  it('前の .pecot-base を削除し、options.base が渡された場合は新しく書き込む', async () => {
    await explains('ベースブランチの記録のテストです。作業対象を記録すると前の `.pecot-base` を削除し、`options.base` を渡した場合は、`main` と SHA を書いた `.pecot-base` を作成することを確認します。')
    const directory = projectDirectory({ '.pecot/state/.pecot-base': 'old' })
    const base = path.join(directory, '.pecot/state/.pecot-base')
    recordWorkTarget(createOutput(false, capture()), 'acme', 'demo', 7, 't')
    expect(existsSync(base)).toBe(false)
    recordWorkTarget(createOutput(false, capture()), 'acme', 'demo', 7, 't', { base: { branch: 'main', sha: '0'.repeat(40), stackedOn: undefined } })
    expect(readFileSync(base, 'utf8')).toBe(`main ${'0'.repeat(40)}`)
  })

  it('.pecot-base を削除できない場合は、could not record the base の warning を表示する', async () => {
    await explains('`.pecot-base` がディレクトリで削除できない場合のテストです。`warning: could not record the base` で始まる行を表示することを確認します。')
    projectDirectory({ '.pecot/state/.pecot-base/keep': 'x' })
    const io = capture()
    recordWorkTarget(createOutput(false, io), 'acme', 'demo', 7, 't')
    expect(io.err.join('')).toMatch(/^warning: could not record the base: .+\n/u)
  })
})

describe('planWorkTarget', () => {
  it('作業ディレクトリを作成する予定の行を表示し、何も書き込まない', async () => {
    await explains('dry-run で作業対象を計画する `planWorkTarget` のテストです。`dry-run: would create work directory .pecot/work/7/` の行を表示し、`.pecot` ディレクトリを作成しないことを確認します。')
    const directory = projectDirectory()
    const io = capture()
    planWorkTarget(createOutput(true, io), 7)
    expect(io.err.join('')).toBe('dry-run: would create work directory .pecot/work/7/\n')
    expect(existsSync(path.join(directory, '.pecot'))).toBe(false)
  })
})

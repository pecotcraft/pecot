/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { mkdirSync, writeFileSync } from 'node:fs'
import type * as FileSystem from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { setEnvironment, useIsolatedEnvironment } from '../../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { makeTemporaryDirectory } from '../../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { OsError } from '@pecot/workflow-core/infra/os-error.js'
import { ensureWorkDirectory, hasFlag, readFlag } from '../state-store.js'

// OS のエラーでない失敗を、fs の境界で起こす。対象は、テストで使う名前のパスだけ
const failures = vi.hoisted(() => ({ mkdir: false, stat: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>()
  return {
    ...actual,
    mkdirSync: (target: string, options?: Readonly<FileSystem.MakeDirectoryOptions>) => {
      if (failures.mkdir && target.endsWith('work/1')) throw new TypeError('unexpected mkdir failure')
      return actual.mkdirSync(target, options)
    },
    statSync: (target: string) => {
      if (failures.stat && target.endsWith('.flag')) throw new TypeError('unexpected stat failure')
      return actual.statSync(target)
    },
  }
})

useIsolatedEnvironment()

beforeEach(() => {
  failures.mkdir = false
  failures.stat = false
})

function useProject(): string {
  const root = makeTemporaryDirectory()
  setEnvironment({ CLAUDE_PROJECT_DIR: root })
  return root
}

describe('state-store（想定外の失敗）', () => {
  it('作業ディレクトリの作成が OS のエラーでない理由で失敗した場合は、そのまま送出する', async () => {
    await explains('作業ディレクトリを作成する `ensureWorkDirectory` のテストです。ディレクトリの作成が OS のエラーではない理由で失敗した場合に、握りつぶさずに例外を送出することを確認します。')
    useProject()
    failures.mkdir = true
    expect(() => ensureWorkDirectory('o/r/1')).toThrow('unexpected mkdir failure')
  })

  it('フラグの確認が OS のエラーでない理由で失敗した場合は、そのまま送出する', async () => {
    await explains('フラグの有無を調べる `hasFlag` のテストです。ファイルの状態の取得が OS のエラーではない理由で失敗した場合に、false にせず例外を送出することを確認します。')
    useProject()
    failures.stat = true
    expect(() => hasFlag('.flag')).toThrow('unexpected stat failure')
  })

  it('フラグの名前の途中がファイルの場合は、OsError を送出する', async () => {
    await explains('フラグファイルを読み込む `readFlag` のテストです。名前の途中のパスがファイルのため、読み取りが失敗する場合は、OsError を送出することを確認します。')
    const root = useProject()
    mkdirSync(path.join(root, '.pecot', 'state'), { recursive: true })
    writeFileSync(path.join(root, '.pecot', 'state', 'plain'), 'x')
    expect(() => readFlag('plain/child')).toThrow(OsError)
  })
})

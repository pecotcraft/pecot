/* eslint-disable unicorn/no-null -- ProcessResult は、終了コードとシグナルが無いことを null で表す */
import { describe, expect, it, vi } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { step } from '../../../tests/_helpers/step.js'

import { runProcess } from '@pecot/workflow-core/infra/process-run.js'
import type { ProcessResult } from '@pecot/workflow-core/infra/process-run.js'
import { runSetupCommand } from '../worktree-setup.js'

vi.mock('@pecot/workflow-core/infra/process-run.js', () => ({ runProcess: vi.fn() }))

function resultOf(fields: Partial<ProcessResult>): ProcessResult {
  return { exitCode: null, signal: null, isTimedOut: false, stdout: '', stderr: '', ...fields }
}

describe('runSetupCommand（終了の理由が揃わない場合）', () => {
  it('終了の理由が何も無い場合は、終了コードを -1 にする', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。プロセスの結果から終了コードとシグナルの両方が欠けている場合に、終了コードを `-1` にすることを確認します。')
    vi.mocked(runProcess).mockResolvedValueOnce(resultOf({}))
    const result = await step('セットアップのコマンドを実行する', () => runSetupCommand('true', '.'))
    await step('終了コードを比べる', () => {
      expect(result.exitCode).toBe(-1)
    })
  })

  it('番号の表に無いシグナルで終了した場合は、終了コードを -1 にする', async () => {
    await explains('セットアップのコマンドを実行する `runSetupCommand` のテストです。この環境のシグナル番号の表に無いシグナルで終了した場合に、終了コードを `-1` にすることを確認します。')
    vi.mocked(runProcess).mockResolvedValueOnce(resultOf({ signal: 'SIGBREAK' }))
    const result = await step('セットアップのコマンドを実行する', () => runSetupCommand('true', '.'))
    await step('終了コードを比べる', () => {
      expect(result.exitCode).toBe(-1)
    })
  })
})

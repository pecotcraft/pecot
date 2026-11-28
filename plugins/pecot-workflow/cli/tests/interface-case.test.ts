/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// tests/_helpers/interface-case.ts の準備が動くことを、見本のツールで確かめる。
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineTool } from '../src/commands/registry.js'
import { exitWith } from '../src/commands/tests/support.js'
import { gitCurrentBranch } from '@pecot/workflow-core/infra/git.js'
import { loadActiveConfig } from '@pecot/workflow-core/infra/config-store.js'
import { useIsolatedEnvironment } from '../../../../libs/workflow-core/tests/_helpers/environment.js'
import { enterGitRepository, runInProcess, setUpProject, settleWithFakeDelays, useFakeDelays } from './_helpers/interface-case.js'
import { explains } from './_helpers/explains.js'

useIsolatedEnvironment()

const STARTING_DIRECTORY = process.cwd()

// 設定を読み、git のブランチを出し、3 秒ずつ 2 回待つ見本
const SAMPLE = defineTool({
  name: 'sample',
  title: 'Test tool',
  writes: { destructive: true, idempotent: false },
  description: '準備の確認用',
  input: z.object({}),
  output: z.strictObject({}),
  run: async (_input, io) => {
    const config = loadActiveConfig()
    await delay(3000)
    await delay(3000)
    io.stdout(`${config?.owner ?? '-'} ${gitCurrentBranch() ?? '-'} waited\n`)
    return await exitWith(0)
  },
})

describe('interface-case の準備', () => {
  it('設定・git・偽のタイマーを組み合わせて、ツールをプロセス内で動かせる', async () => {
    await explains('`interface-case.ts`（インタフェースのテストの準備）のテストです。設定・git・偽のタイマーを組み合わせて見本のツールを実行した場合に、設定の owner と git のブランチを含む出力で終了することを確認します。')
    const project = setUpProject({ files: { '.pecot/state/.pecot-base': '1' } })
    const repository = enterGitRepository()
    useFakeDelays()

    const result = await settleWithFakeDelays(runInProcess('sample', {}, [SAMPLE]))

    expect(result).toEqual({ code: 0, stdout: 'acme main waited\n', stderr: '' })
    expect(process.cwd()).toBe(repository)
    expect(existsSync(path.join(project.root, '.pecot/state/.pecot-base'))).toBe(true)
  })

  it('ホスト名と owner から設定のファイル名を作り、CLAUDE_PROJECT_DIR をプロジェクトルートに向ける', async () => {
    await explains('`interface-case.ts` で、ホスト名と owner を指定してプロジェクトの設定を作った場合のテストです。設定のファイル名がホスト名と owner から作られ、`CLAUDE_PROJECT_DIR` がプロジェクトルートを指すことを確認します。')
    const project = setUpProject({ host: 'github.com', owner: 'o', repositories: [] })
    expect(project.configFile).toBe('github.com_o_board_o.json')
    expect(process.env['CLAUDE_PROJECT_DIR']).toBe(project.root)
  })

  it('前のテストで移った作業ディレクトリと偽のタイマーは、次のテストに持ち越さない', async () => {
    await explains('`interface-case.ts` のテストです。前のテストで作業ディレクトリを移し、偽のタイマーを有効にした場合は、次のテストの開始時に、どちらも元の状態へ戻っていることを確認します。')
    expect(process.cwd()).toBe(STARTING_DIRECTORY)
    expect(vi.isFakeTimers()).toBe(false)
  })

  it('入力の検証に失敗すると、ZodError をそのまま投げる', async () => {
    await explains('`interface-case.ts` のテストです。共通の `repo` に文字列でない値を渡した場合に、本体を呼ばずに `ZodError` を投げることを確認します。')
    await expect(runInProcess('sample', { repo: 1 }, [SAMPLE])).rejects.toBeInstanceOf(z.ZodError)
  })
})

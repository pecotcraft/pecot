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
import { GitHubClient } from '@pecot/workflow-core/infra/github/index.js'
import { useIsolatedEnvironment } from '../../../../libs/workflow-core/tests/_helpers/environment.js'
import { ignoredDiagnostics } from '../../../../libs/workflow-core/tests/_helpers/recording-diagnostics.js'
import { restResponse } from '../../../../libs/workflow-core/src/infra/github/tests/fake-client.js'
import { enterGitRepository, runInProcess, setUpProject, settleWithFakeDelays, startGithub, useFakeDelays } from './_helpers/interface-case.js'
import { explains } from './_helpers/explains.js'

useIsolatedEnvironment()

const STARTING_DIRECTORY = process.cwd()

// 設定を読み、git のブランチを出し、3 秒待って Issue を 2 回作る見本
const SAMPLE = defineTool({
  name: 'sample',
  title: 'Test tool',
  description: '準備の確認用',
  input: z.object({}),
  output: z.strictObject({}),
  run: async (_input, io) => {
    const config = loadActiveConfig()
    const client = new GitHubClient({ host: config?.host ?? '', token: 'test_token', diagnostics: ignoredDiagnostics })
    const first = await client.createIssue('acme', 'demo', 'one')
    await delay(3000)
    const second = await client.createIssue('acme', 'demo', 'two')
    io.stdout(`${config?.owner ?? '-'} ${gitCurrentBranch() ?? '-'} ${JSON.stringify(first['number'])} ${JSON.stringify(second['number'])}\n`)
    return await exitWith(0)
  },
})

const CREATED = (number: number): ReturnType<typeof restResponse> => restResponse('POST', '/repos/acme/demo/issues', { status: 201, body: { number } })

describe('interface-case の準備', () => {
  it('設定・git・偽サーバ・偽のタイマーを組み合わせて、ツールをプロセス内で動かせる', async () => {
    await explains('`interface-case.ts`（インタフェースのテストの準備）のテストです。設定・git・偽サーバ・偽のタイマーを組み合わせて見本のツールを実行した場合に、期待する出力で終了し、偽サーバへ 2 件の要求が届くことを確認します。')
    const project = setUpProject({ files: { '.pecot/state/.pecot-base': '1' } })
    const repository = enterGitRepository()
    const github = await startGithub([CREATED(11), CREATED(12)])
    useFakeDelays()

    const result = await settleWithFakeDelays(runInProcess('sample', {}, [SAMPLE]))

    expect(result).toEqual({ code: 0, stdout: 'acme main 11 12\n', stderr: '' })
    expect(process.cwd()).toBe(repository)
    expect(existsSync(path.join(project.root, '.pecot/state/.pecot-base'))).toBe(true)
    expect(github.requests().map(request => request.type === 'rest' ? request.body : undefined)).toEqual([
      { title: 'one', body: '' },
      { title: 'two', body: '' },
    ])
  })

  it('プロジェクトの設定の環境変数をホスト名から作る', async () => {
    await explains('`interface-case.ts` のテストです。ホスト名とトークンを指定してプロジェクトの設定を作った場合に、ホスト名から環境変数の名前を作り、その環境変数へトークンを設定することを確認します。')
    const project = setUpProject({ host: 'github.com', owner: 'o', repositories: [], token: 'abc' })
    expect(project.tokenVariable).toBe('PECOT_GITHUB_GITHUB_COM_TOKEN')
    expect(process.env[project.tokenVariable]).toBe('abc')
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

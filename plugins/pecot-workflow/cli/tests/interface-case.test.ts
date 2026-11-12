/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// tests/_helpers/interface-case.ts の準備が動くことを、見本のコマンドで確かめる。
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineCommand } from '../src/commands/registry.js'
import { exitWith } from '../src/commands/tests/support.js'
import { gitCurrentBranch } from '../src/infra/git.js'
import { loadActiveConfig } from '../src/infra/config-store.js'
import { GitHubClient } from '../src/infra/github/index.js'
import { useIsolatedEnvironment } from '../src/tests/_helpers/environment.js'
import { ignoredDiagnostics } from '../src/infra/tests/recording-diagnostics.js'
import { restResponse } from '../src/infra/github/tests/fake-client.js'
import { enterGitRepository, runInProcess, setUpProject, settleWithFakeDelays, startGithub, useFakeDelays } from './_helpers/interface-case.js'

useIsolatedEnvironment()

const STARTING_DIRECTORY = process.cwd()

// 設定を読み、git のブランチを出し、3 秒待って Issue を 2 回作る見本
const SAMPLE = defineCommand({
  path: ['sample'],
  description: '準備の確認用',
  input: z.object({}),
  positional: [],
  interactive: false,
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
  it('設定・git・偽サーバ・偽のタイマーを組み合わせて、コマンドを runCli で動かせる', async () => {
    const project = setUpProject({ files: { '.pecot/state/issue-pending': '1' } })
    const repository = enterGitRepository()
    const github = await startGithub([CREATED(11), CREATED(12)])
    useFakeDelays()

    const result = await settleWithFakeDelays(runInProcess(['sample'], [SAMPLE]))

    expect(result).toEqual({ code: 0, stdout: 'acme main 11 12\n', stderr: '' })
    expect(process.cwd()).toBe(repository)
    expect(existsSync(path.join(project.root, '.pecot/state/issue-pending'))).toBe(true)
    expect(github.requests().map(request => request.type === 'rest' ? request.body : undefined)).toEqual([
      { title: 'one', body: '' },
      { title: 'two', body: '' },
    ])
  })

  it('プロジェクトの設定の環境変数をホスト名から作る', () => {
    const project = setUpProject({ host: 'github.com', owner: 'o', repositories: [], token: 'abc' })
    expect(project.tokenVariable).toBe('PECOT_GITHUB_GITHUB_COM_TOKEN')
    expect(process.env[project.tokenVariable]).toBe('abc')
  })

  it('前のテストで移った作業ディレクトリと偽のタイマーは、次のテストに持ち越さない', () => {
    expect(process.cwd()).toBe(STARTING_DIRECTORY)
    expect(vi.isFakeTimers()).toBe(false)
  })

  it('使い方の誤りも、終了コード 2 と出力といっしょに返す', async () => {
    const result = await runInProcess(['--no-such-option'], [SAMPLE])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('No such option: --no-such-option')
  })
})

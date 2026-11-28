/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// session_show の振る舞いを、ツールをプロセス内で呼んで確かめる。GitHub は読まない。remote は偽の ssh で一時の bare リポにつなぐ
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { installFakeExecutable } from '../../../../../libs/workflow-core/tests/_helpers/fake-executables.js'
import { setEnvironment, useIsolatedEnvironment } from '../../../../../libs/workflow-core/tests/_helpers/environment.js'
import { gitForTest } from '../../../../../libs/workflow-core/tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../../../../libs/workflow-core/tests/_helpers/temporary.js'
import { step } from '../_helpers/step.js'
import { SESSION_TOOLS } from '../../src/commands/session.js'
import { callToolOnce } from '../_helpers/mcp-client.js'
import type { ToolOutcome } from '../_helpers/mcp-client.js'
import { containing } from '../hooks/_helpers/text.js'
import { prepareSession } from '../_helpers/session-case.js'
import { verifies } from '../_helpers/verifies.js'
import { explains } from '../_helpers/explains.js'

useIsolatedEnvironment()

const SSH_ORIGIN = 'git@ghes.example.com:acme/demo.git'

/**
origin の `git@ghes.example.com:acme/demo.git` を、偽の ssh で一時の bare リポにつなぐ。bare のパスを返す
*/
function sshOrigin(): string {
  const remotes = makeTemporaryDirectory('pecot-remotes-')
  const bare = path.join(remotes, 'acme', 'demo.git')
  mkdirSync(bare, { recursive: true })
  gitForTest(bare, ['init', '-q', '--bare'])
  const bin = makeTemporaryDirectory('pecot-ssh-')
  // git が ssh として呼ぶ形は `fake-ssh <host> <git-upload-pack 'acme/demo.git'>`。host は見ず、bare に向ける
  const body = `cmd="$(eval "printf '%s\\n' $(printf '%s' "$2" | sed 's/^[^ ]* //')")"\nprog="\${2%% *}"\nexec git "\${prog#git-}" '${remotes}'/"$cmd"\n`
  setEnvironment({ GIT_SSH: installFakeExecutable(bin, 'fake-ssh', body), GIT_SSH_VARIANT: 'simple' })
  return bare
}

interface Scene {
  readonly branch?: string
  /**
  .pecot-base にスタック先 feat/3（acme/demo#3）を書くか
  */
  readonly isStacked?: boolean
  /**
  feat/3 を remote に置き、追跡参照も向けるか
  */
  readonly isLowerOnRemote?: boolean
  /**
  origin/main の追跡参照を置くか
  */
  readonly isDevelopTracked?: boolean
}

interface Prepared {
  readonly repository: string
  readonly head: string
}

function prepare(scene: Readonly<Scene> = {}): Prepared {
  const { branch = 'feat/demo/7', isStacked = false, isLowerOnRemote = false, isDevelopTracked = true } = scene
  const bare = sshOrigin()
  const { project, repository } = prepareSession({ branch, remotes: { origin: SSH_ORIGIN }, baseRecord: !isStacked })
  const head = gitForTest(repository, ['rev-parse', 'HEAD']).trim()
  if (isDevelopTracked) gitForTest(repository, ['update-ref', 'refs/remotes/origin/main', head])
  if (isLowerOnRemote) {
    gitForTest(repository, ['push', '-q', bare, 'HEAD:refs/heads/feat/3'])
    gitForTest(repository, ['update-ref', 'refs/remotes/origin/feat/3', head])
  }
  if (isStacked) {
    mkdirSync(path.join(project.root, '.pecot/state'), { recursive: true })
    writeFileSync(path.join(project.root, '.pecot/state/.pecot-base'), `feat/3 ${head} acme/demo#3\n`)
  }
  return { repository, head }
}

async function show(directory: string): Promise<ToolOutcome> {
  return await callToolOnce(SESSION_TOOLS, 'session_show', { directory })
}

describe('session_show', () => {
  it('呼ぶと、GitHub を読まずに、ブランチ・リポジトリ・作業中の Issue・worktree を返す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-01')
    await explains('作業ブランチ `feat/demo/7` の上で呼んだ場合のテストです。今のブランチと remote のリポジトリと作業中の Issue の参照と、`worktree` の情報を返すことを確認します。')
    const { repository } = prepare()
    const outcome = await show(repository)
    await step('結果を確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(outcome.structured).toEqual({
        branch: 'feat/demo/7',
        repository: 'acme/demo',
        activeIssue: { reference: 'acme/demo/7' },
        baseBranch: 'origin/main',
        worktree: { list: containing('[feat/demo/7]'), directoryName: path.basename(repository), isWorktree: false },
      })
      expect(outcome.text).toBe('# Session status')
    })
  })

  it('.pecot-base がスタック先を指すと、stack にブランチ・Issue・コミットを入れる', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-02')
    await explains('`.pecot-base` に、スタック先の `feat/3`（`acme/demo#3`）とコミットを記録した場合のテストです。`stack` に、ブランチ・Issue の参照・コミットを入れることを確認します。')
    const { repository, head } = prepare({ isStacked: true, isLowerOnRemote: true })
    const outcome = await show(repository)
    await step('結果を確かめる', () => {
      expect(outcome.structured['stack']).toEqual({ branch: 'feat/3', stackedOn: 'acme/demo/3', sha: head })
    })
  })

  it('スタックしていないと、baseBranch に remote の開発ブランチを入れる', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-03')
    await explains('開発ブランチから着手した記録がある場合のテストです。`baseBranch` に `origin/main` を入れ、`stack` を入れないことを確認します。')
    const { repository } = prepare()
    const outcome = await show(repository)
    await step('結果を確かめる', () => {
      expect(outcome.structured['baseBranch']).toBe('origin/main')
      expect(outcome.structured).not.toHaveProperty('stack')
    })
  })

  it.for([
    { name: '親ブランチが remote にある', isLowerOnRemote: true, expected: 'origin/feat/3' },
    { name: '親ブランチが remote に無いと答えた', isLowerOnRemote: false, expected: 'origin/main' },
  ])('スタックしていて $name と、baseBranch を $expected にする', async (row, context) => {
    await verifies(context, 'PW-SESSION-SHOW-04')
    await explains(`スタック先の \`feat/3\` を記録していて、${row.name}場合のテストです。\`baseBranch\` に \`${row.expected}\` を入れることを確認します。`)
    const { repository } = prepare({ isStacked: true, isLowerOnRemote: row.isLowerOnRemote })
    const outcome = await show(repository)
    await step('結果を確かめる', () => {
      expect(outcome.structured['baseBranch']).toBe(row.expected)
      expect(outcome.structured).not.toHaveProperty('warnings')
    })
  })

  it('開発ブランチの追跡参照が無いと、baseBranch を入れず、warnings に理由を入れて成功を返す', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-05')
    await explains('`origin/main` の追跡参照が存在しない場合のテストです。失敗を返さずに `baseBranch` を省き、決められない理由と確認の方法を `warnings` に入れることを確認します。')
    const { repository } = prepare({ isDevelopTracked: false })
    const outcome = await show(repository)
    await step('結果を確かめる', () => {
      expect(outcome.isError).toBe(false)
      expect(outcome.structured).not.toHaveProperty('baseBranch')
      expect(outcome.structured['warnings']).toEqual(['baseBranch is not decided: branch origin/main does not exist\n  check the remote branches with: git branch -r'])
    })
  })

  it('ブランチ名が番号で終わらないと、activeIssue を入れない', async (context) => {
    await verifies(context, 'PW-SESSION-SHOW-06')
    await explains('ブランチ名が Issue の番号で終わらない（`topic`）場合のテストです。`activeIssue` を入れず、ブランチとリポジトリは返すことを確認します。')
    const { repository } = prepare({ branch: 'topic' })
    const outcome = await show(repository)
    await step('結果を確かめる', () => {
      expect(outcome.structured).not.toHaveProperty('activeIssue')
      expect(outcome.structured).toMatchObject({ branch: 'topic', repository: 'acme/demo' })
    })
  })
})

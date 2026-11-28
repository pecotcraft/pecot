/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { setEnvironment, useIsolatedEnvironment } from '../../../tests/_helpers/environment.js'
import { createGitRepository, gitEnvironment, gitForTest } from '../../../tests/_helpers/git-repository.js'
import { CancelledError } from '../../domain/errors.js'
import { makeTemporaryDirectory } from '../../../tests/_helpers/temporary.js'
import {
  abortRebase,
  conflictedFiles,
  continueRebase,
  fetchRemote,
  GitCommandError,
  hasSameTree,
  isRebaseInProgress,
  mergeBase,
  pushWithLease,
  rebaseOnto,
  remoteBranchHead,
  remoteOnlyChanges,
  remoteTagExists,
  resetHardTo,
  resolveCommit,
} from '../git.js'
import { explains } from '../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../tests/_helpers/step.js'

useIsolatedEnvironment()

beforeEach(() => {
  setEnvironment({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' })
})

interface Stack {
  readonly origin: string
  /**
  親ブランチ（lower）を checkout した作業ディレクトリ
  */
  readonly lower: string
  /**
  子ブランチ（upper）を checkout した linked worktree
  */
  readonly upper: string
  /**
  子ブランチの着手のときに記録した base の位置（lower の先頭）
  */
  readonly recordedBase: string
}

function sha(cwd: string, reference: string): string {
  return gitForTest(cwd, ['rev-parse', reference]).trim()
}

function commitFile(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(path.join(cwd, file), content)
  gitForTest(cwd, ['add', file])
  gitForTest(cwd, ['commit', '-q', '-m', message])
  return sha(cwd, 'HEAD')
}

function subjects(cwd: string, range: string): readonly string[] {
  return gitForTest(cwd, ['log', '--format=%s', range]).split('\n').filter(line => line !== '')
}

// 1〜20 の行のファイル。changed の行だけを、その文字列に替える
function numbered(changed: Readonly<Record<number, string>>): string {
  return Array.from({ length: 20 }, (_, index) => `${changed[index + 1] ?? String(index + 1)}\n`).join('')
}

/**
main ← lower ← upper のスタックしたブランチ。lower と upper は別の作業ディレクトリで、どちらも origin に push 済み
*/
function createStack(): Stack {
  const root = makeTemporaryDirectory('pecot-restack-')
  const origin = path.join(root, 'origin.git')
  gitForTest(root, ['init', '--bare', '-q', '-b', 'main', origin])
  const lower = createGitRepository({ 'base.txt': 'base\n' }, path.join(root, 'lower'))
  gitForTest(lower, ['remote', 'add', 'origin', origin])
  gitForTest(lower, ['push', '-q', 'origin', 'main'])
  gitForTest(lower, ['switch', '-q', '-c', 'lower'])
  commitFile(lower, 'lower.txt', 'l1\n', 'L1')
  gitForTest(lower, ['push', '-q', 'origin', 'lower'])
  const upper = path.join(root, 'upper')
  gitForTest(lower, ['worktree', 'add', '-q', '-b', 'upper', upper, 'lower'])
  commitFile(upper, 'upper.txt', 'u1\n', 'U1')
  commitFile(upper, 'upper2.txt', 'u2\n', 'U2')
  gitForTest(upper, ['push', '-q', 'origin', 'upper'])
  return { origin, lower, upper, recordedBase: sha(lower, 'lower') }
}

interface Hang {
  readonly pidFile: string
}

// origin の upload-pack を、自分の pid を書いて眠るスクリプトに替える
function hangUploadPack(cwd: string): Hang {
  const directory = makeTemporaryDirectory('pecot-hang-')
  const script = path.join(directory, 'upload-pack')
  const pidFile = `${script}.pid`
  writeFileSync(script, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`)
  chmodSync(script, 0o755)
  gitForTest(cwd, ['config', 'remote.origin.uploadpack', script])
  return { pidFile }
}

async function pidOf(hang: Readonly<Hang>): Promise<number> {
  await expect.poll(() => existsSync(hang.pidFile) && readFileSync(hang.pidFile, 'utf8').trim() !== '', { timeout: 10_000, interval: 20 }).toBe(true)
  return Number(readFileSync(hang.pidFile, 'utf8').trim())
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

/**
親ブランチを squash で main に入れる。main には先に別の変更も入れておく
*/
function squashLowerIntoMain(stack: Readonly<Stack>): void {
  gitForTest(stack.lower, ['switch', '-q', 'main'])
  commitFile(stack.lower, 'develop.txt', 'd\n', 'develop work')
  gitForTest(stack.lower, ['merge', '-q', '--squash', 'lower'])
  gitForTest(stack.lower, ['commit', '-q', '-m', 'squash lower'])
  gitForTest(stack.lower, ['push', '-q', 'origin', 'main'])
  gitForTest(stack.lower, ['switch', '-q', 'lower'])
}

/**
GitHub がリモートの子ブランチを main の上に書き換えたのと同じ形にする。コミットの日時をずらし、手元のスタックし直しと SHA を変える
*/
function rewriteRemoteUpperOntoMain(stack: Readonly<Stack>, extraCommit?: string): string | undefined {
  const scratch = makeTemporaryDirectory('pecot-rewrite-')
  gitForTest(scratch, ['clone', '-q', stack.origin, '.'])
  gitForTest(scratch, ['config', 'commit.gpgsign', 'false'])
  gitForTest(scratch, ['switch', '-q', '-c', 'rewritten', 'origin/main'])
  execFileSync('git', ['cherry-pick', `${stack.recordedBase}..origin/upper`], { cwd: scratch, env: { ...gitEnvironment(), GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' }, stdio: 'ignore' })
  const extra = extraCommit === undefined ? undefined : commitFile(scratch, 'suggestion.txt', 's\n', extraCommit)
  gitForTest(scratch, ['push', '-q', '-f', 'origin', 'rewritten:upper'])
  return extra
}

/**
子ブランチと親ブランチが base.txt の同じ行を変え、スタックし直しが衝突する
*/
function createConflictingStack(): Stack {
  const stack = createStack()
  commitFile(stack.upper, 'base.txt', 'upper\n', 'U3 edits base')
  commitFile(stack.lower, 'base.txt', 'lower\n', 'L2 edits base')
  return stack
}

describe('rebaseOnto', () => {
  it('親ブランチにコミットを追加すると、子ブランチを記録した位置から親ブランチの新しい先頭へスタックし直す', async () => {
    await explains('子ブランチを親ブランチの上に載せ直す `rebaseOnto` のテストです。親ブランチにコミットを追加した場合に、`done` を返し、子ブランチの 2 つのコミットが親ブランチの新しい先頭の上に載ることを確認します。')
    const { stack, newLower } = stepSync('親ブランチにコミットを追加したスタックを用意する', () => {
      const created = createStack()
      return { stack: created, newLower: commitFile(created.lower, 'lower2.txt', 'l2\n', 'L2') }
    })
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'lower', stack.recordedBase))
    stepSync('スタックし直した結果を比べる', () => {
      expect(outcome).toBe('done')
      expect(sha(stack.upper, 'HEAD~2')).toBe(newLower)
      expect(subjects(stack.upper, 'lower..HEAD')).toEqual(['U2', 'U1'])
    })
  })

  it('親ブランチを squash で開発ブランチに統合した後は、子ブランチを開発ブランチの上に載せ、親ブランチのコミットを除外する', async () => {
    await explains('`rebaseOnto` のテストです。親ブランチを squash で開発ブランチへ統合した場合に、子ブランチのコミットだけを `origin/main` の上に載せ、親ブランチのコミットは含めないことを確認します。')
    const stack = stepSync('親ブランチを squash で統合したスタックを用意する', () => {
      const created = createStack()
      squashLowerIntoMain(created)
      return created
    })
    const fetched = await step('remote から取得する', async () => await fetchRemote(stack.upper, 'origin'))
    await step('取得の成功を確かめる', () => {
      expect(fetched).toMatchObject({ succeeded: true })
    })
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'origin/main', stack.recordedBase))
    stepSync('スタックし直した結果を比べる', () => {
      expect(outcome).toBe('done')
      expect(sha(stack.upper, 'HEAD~2')).toBe(sha(stack.upper, 'origin/main'))
      expect(subjects(stack.upper, 'origin/main..HEAD')).toEqual(['U2', 'U1'])
      expect(readFileSync(path.join(stack.upper, 'lower.txt'), 'utf8')).toBe('l1\n')
    })
  })

  it('親ブランチの作業ディレクトリの未コミットの変更とブランチの位置を、変更しない', async () => {
    await explains('`rebaseOnto` のテストです。親ブランチの作業ディレクトリに未コミットの変更と未追跡のファイルがある場合に、スタックし直した後も、その状態とブランチの位置が変わらないことを確認します。')
    const { stack, statusBefore, lowerBefore } = stepSync('未コミットの変更がある親ブランチのスタックを用意する', () => {
      const created = createStack()
      commitFile(created.lower, 'lower2.txt', 'l2\n', 'L2')
      writeFileSync(path.join(created.lower, 'lower.txt'), 'edited\n')
      writeFileSync(path.join(created.lower, 'untracked.txt'), 'u\n')
      return { stack: created, statusBefore: gitForTest(created.lower, ['status', '--porcelain']), lowerBefore: sha(created.lower, 'lower') }
    })
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'lower', stack.recordedBase))
    stepSync('親ブランチが変わっていないことを確かめる', () => {
      expect(outcome).toBe('done')
      expect(gitForTest(stack.lower, ['status', '--porcelain'])).toBe(statusBefore)
      expect(sha(stack.lower, 'lower')).toBe(lowerBefore)
      expect(readFileSync(path.join(stack.lower, 'lower.txt'), 'utf8')).toBe('edited\n')
    })
  })

  it('rebase.updateRefs を true に設定していても、範囲内の別のローカルブランチを更新しない', async () => {
    await explains('`rebaseOnto` のテストです。`rebase.updateRefs` を `true` に設定し、範囲内のコミットを指す別のブランチ（`marker`）がある場合に、スタックし直した後も `marker` の位置が変わらないことを確認します。')
    const { stack, markerBefore } = stepSync('marker ブランチと updateRefs を設定したスタックを用意する', () => {
      const created = createStack()
      gitForTest(created.upper, ['config', 'rebase.updateRefs', 'true'])
      gitForTest(created.upper, ['branch', 'marker', 'HEAD~1'])
      const before = sha(created.upper, 'marker')
      commitFile(created.lower, 'lower2.txt', 'l2\n', 'L2')
      return { stack: created, markerBefore: before }
    })
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'lower', stack.recordedBase))
    stepSync('marker の位置が変わらないことを確かめる', () => {
      expect(outcome).toBe('done')
      expect(sha(stack.upper, 'marker')).toBe(markerBefore)
      expect(sha(stack.upper, 'HEAD~2')).toBe(sha(stack.upper, 'lower'))
    })
  })

  it('衝突すると conflict を返し、conflictedFiles が衝突したファイルを返す', async () => {
    await explains('`rebaseOnto` と `conflictedFiles` のテストです。子ブランチと親ブランチが同じ行を変更している場合に、`rebaseOnto` が `conflict` を返し、`conflictedFiles` が `base.txt` を返すことを確認します。')
    const stack = stepSync('衝突するスタックを用意する', () => createConflictingStack())
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'lower', stack.recordedBase))
    const files = stepSync('衝突したファイルを求める', () => conflictedFiles(stack.upper))
    stepSync('結果を比べる', () => {
      expect(outcome).toBe('conflict')
      expect(files).toEqual(['base.txt'])
    })
  })

  it('衝突以外で失敗すると、GitCommandError を発生させる', async () => {
    await explains('`rebaseOnto` のテストです。存在しないブランチを指定するなど、衝突以外の原因で失敗した場合に、`GitCommandError` が発生し、スタックし直しが途中で残らないことを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    stepSync('エラーの種類を確かめる', () => {
      expect(() => rebaseOnto(stack.upper, 'no-such-branch', stack.recordedBase)).toThrow(GitCommandError)
    })
    stepSync('スタックし直しが残っていないことを確かめる', () => {
      expect(isRebaseInProgress(stack.upper)).toBe(false)
    })
  })

  it('既にスタックし直しの途中の場合は、衝突とは扱わず GitCommandError を発生させる', async () => {
    await explains('`rebaseOnto` のテストです。衝突でスタックし直しが途中で止まっている状態で再度実行した場合に、`conflict` ではなく `GitCommandError` が発生し、途中の状態が残ることを確認します。')
    const stack = stepSync('衝突するスタックを用意する', () => createConflictingStack())
    const first = stepSync('子ブランチをスタックし直して衝突させる', () => rebaseOnto(stack.upper, 'lower', stack.recordedBase))
    stepSync('衝突を確かめる', () => {
      expect(first).toBe('conflict')
    })
    stepSync('途中の状態でもう一度スタックし直す', () => {
      expect(() => rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toThrow(GitCommandError)
    })
    stepSync('スタックし直しが途中のまま残ることを確かめる', () => {
      expect(isRebaseInProgress(stack.upper)).toBe(true)
    })
  })
})

describe('abortRebase と continueRebase', () => {
  it('衝突の後に abortRebase を呼ぶと、スタックし直す前の位置に戻る', async () => {
    await explains('`abortRebase` のテストです。衝突で止まったスタックし直しを中止した場合に、子ブランチの先頭がスタックし直す前の位置に戻り、ブランチ `upper` に戻ることを確認します。')
    const { stack, before } = stepSync('衝突で止まったスタックを用意する', () => {
      const created = createConflictingStack()
      const head = sha(created.upper, 'HEAD')
      expect(rebaseOnto(created.upper, 'lower', created.recordedBase)).toBe('conflict')
      return { stack: created, before: head }
    })
    stepSync('スタックし直しを中止する', () => {
      abortRebase(stack.upper)
    })
    stepSync('元の位置とブランチに戻ったことを確かめる', () => {
      expect(sha(stack.upper, 'HEAD')).toBe(before)
      expect(gitForTest(stack.upper, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('upper')
    })
  })

  it('衝突を解決せずに continueRebase を呼ぶと、conflict を返す', async () => {
    await explains('`continueRebase` のテストです。衝突を解決せずに続行した場合は、`conflict` を返し、スタックし直しが途中の状態のまま残ることを確認します。')
    const stack = stepSync('衝突で止まったスタックを用意する', () => {
      const created = createConflictingStack()
      rebaseOnto(created.upper, 'lower', created.recordedBase)
      return created
    })
    const outcome = stepSync('スタックし直しを続行する', () => continueRebase(stack.upper))
    stepSync('結果を比べる', () => {
      expect(outcome).toBe('conflict')
      expect(isRebaseInProgress(stack.upper)).toBe(true)
    })
  })

  it('衝突を解決して continueRebase を呼ぶと、エディタを開かずに done を返す', async () => {
    await explains('`continueRebase` のテストです。衝突を解決してファイルを追加した後に続行した場合は、エディタを開かずに `done` を返し、スタックし直しを完了することを確認します。')
    const stack = stepSync('衝突を解決したスタックを用意する', () => {
      const created = createConflictingStack()
      rebaseOnto(created.upper, 'lower', created.recordedBase)
      writeFileSync(path.join(created.upper, 'base.txt'), 'resolved\n')
      gitForTest(created.upper, ['add', 'base.txt'])
      setEnvironment({ GIT_EDITOR: 'false' })
      return created
    })
    const outcome = stepSync('スタックし直しを続行する', () => continueRebase(stack.upper))
    stepSync('完了した結果を比べる', () => {
      expect(outcome).toBe('done')
      expect(sha(stack.upper, 'HEAD~3')).toBe(sha(stack.upper, 'lower'))
      expect(subjects(stack.upper, 'lower..HEAD')).toEqual(['U3 edits base', 'U2', 'U1'])
      expect(isRebaseInProgress(stack.upper)).toBe(false)
    })
  })
})

describe('isRebaseInProgress', () => {
  it('.git がファイルの worktree でも、衝突中は true を返し、衝突の前と中止した後は false を返す', async () => {
    await explains('スタックし直しが途中かを判定する `isRebaseInProgress` のテストです。`.git` がファイルの worktree で、衝突中は `true`、衝突の前と中止した後は `false` を返すことを確認します。')
    const stack = stepSync('衝突するスタックを用意する', () => createConflictingStack())
    const isBefore = stepSync('衝突の前に判定する', () => isRebaseInProgress(stack.upper))
    stepSync('衝突の前の判定を比べる', () => {
      expect(statSync(path.join(stack.upper, '.git')).isFile()).toBe(true)
      expect(isBefore).toBe(false)
    })
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'lower', stack.recordedBase))
    const during = stepSync('衝突中に判定する', () => ({ upper: isRebaseInProgress(stack.upper), lower: isRebaseInProgress(stack.lower) }))
    stepSync('衝突中の判定を比べる', () => {
      expect(outcome).toBe('conflict')
      expect(during).toEqual({ upper: true, lower: false })
    })
    stepSync('スタックし直しを中止する', () => {
      abortRebase(stack.upper)
    })
    const isAfter = stepSync('中止した後に判定する', () => isRebaseInProgress(stack.upper))
    stepSync('中止した後の判定を比べる', () => {
      expect(isAfter).toBe(false)
    })
  })
})

describe('hasSameTree と resetHardTo', () => {
  it('スタックし直した結果が origin の子ブランチと同じ内容の場合は true を返し、resetHardTo の後は origin と同じ SHA になる', async () => {
    await explains('`hasSameTree` と `resetHardTo` のテストです。スタックし直した結果が `origin/upper` と同じ内容の場合に `true` を返し、`resetHardTo` の後に `origin/upper` と同じ SHA になることを確認します。')
    const stack = stepSync('親ブランチを統合し、remote の子ブランチを書き換えたスタックを用意する', () => {
      const created = createStack()
      squashLowerIntoMain(created)
      rewriteRemoteUpperOntoMain(created)
      return created
    })
    const fetched = await step('remote から取得する', async () => await fetchRemote(stack.upper, 'origin'))
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'origin/main', stack.recordedBase))
    await step('取得とスタックし直しの結果を比べる', () => {
      expect(fetched).toMatchObject({ succeeded: true })
      expect(outcome).toBe('done')
      expect(sha(stack.upper, 'HEAD')).not.toBe(sha(stack.upper, 'origin/upper'))
    })
    const isSame = stepSync('内容が同じかを判定する', () => hasSameTree(stack.upper, 'HEAD', 'origin/upper'))
    stepSync('同じ内容であることを確かめる', () => {
      expect(isSame).toBe(true)
    })
    stepSync('origin の子ブランチへ reset する', () => {
      resetHardTo(stack.upper, 'origin/upper')
    })
    stepSync('SHA とブランチを比べる', () => {
      expect(sha(stack.upper, 'HEAD')).toBe(sha(stack.upper, 'origin/upper'))
      expect(gitForTest(stack.upper, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('upper')
    })
  })

  it('内容が異なる場合は、hasSameTree が false を返す', async () => {
    await explains('`hasSameTree` のテストです。スタックし直した結果と `origin/upper` の内容が異なる場合に、`false` を返すことを確認します。')
    const stack = stepSync('親ブランチにコミットを追加したスタックを用意する', () => {
      const created = createStack()
      commitFile(created.lower, 'lower2.txt', 'l2\n', 'L2')
      return created
    })
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'lower', stack.recordedBase))
    const isSame = stepSync('内容が同じかを判定する', () => hasSameTree(stack.upper, 'HEAD', 'origin/upper'))
    stepSync('結果を比べる', () => {
      expect(outcome).toBe('done')
      expect(isSame).toBe(false)
    })
  })

  it('比較する ref が存在しない場合は、GitCommandError を発生させる', async () => {
    await explains('`hasSameTree` のテストです。存在しない ref（`origin/no-such-branch`）を指定した場合に、`GitCommandError` が発生することを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    stepSync('エラーの種類を確かめる', () => {
      expect(() => hasSameTree(stack.upper, 'HEAD', 'origin/no-such-branch')).toThrow(GitCommandError)
    })
  })
})

describe('pushWithLease', () => {
  it('期待する SHA が remote と同じ場合は、push して remote を手元の SHA にする', async () => {
    await explains('`pushWithLease` のテストです。期待する SHA が remote の先頭と同じ場合に、`pushed` が `true` の結果を返し、remote の子ブランチが手元の先頭と同じ SHA になることを確認します。')
    const { stack, expected } = stepSync('スタックし直した子ブランチを用意する', () => {
      const created = createStack()
      commitFile(created.lower, 'lower2.txt', 'l2\n', 'L2')
      const head = sha(created.upper, 'origin/upper')
      expect(rebaseOnto(created.upper, 'lower', created.recordedBase)).toBe('done')
      return { stack: created, expected: head }
    })
    const result = await step('lease つきで push する', async () => await pushWithLease(stack.upper, 'origin', 'upper', expected))
    await step('push の結果と remote の SHA を比べる', () => {
      expect(result).toEqual({ pushed: true })
      expect(sha(stack.origin, 'upper')).toBe(sha(stack.upper, 'HEAD'))
    })
  })

  it('期待する SHA が remote の先頭と一致しない場合は、push を拒否し、remote を変更しない', async () => {
    await explains('`pushWithLease` のテストです。期待する SHA が remote の先頭と一致しない場合に、`rejected` として拒否され、標準エラーに `stale info` を含み、remote が変更されないことを確認します。')
    const { stack, remoteBefore } = stepSync('ローカルにだけコミットがあるスタックを用意する', () => {
      const created = createStack()
      const before = sha(created.origin, 'upper')
      commitFile(created.upper, 'local.txt', 'x\n', 'local')
      return { stack: created, remoteBefore: before }
    })
    const result = await step('古い SHA を期待して push する', async () => await pushWithLease(stack.upper, 'origin', 'upper', stack.recordedBase))
    await step('拒否の結果と remote を比べる', () => {
      expect(result).toMatchObject({ pushed: false, reason: 'rejected' })
      expect(result.pushed ? '' : result.stderr).toContain('stale info')
      expect(sha(stack.origin, 'upper')).toBe(remoteBefore)
    })
  })

  it('pre-push のフックが時間切れを超えると、フックごと git を停止してすぐに timed-out を返し、remote を変更しない', async () => {
    await explains('`pushWithLease` のテストです。`pre-push` のフックが指定した時間を超えて動き続ける場合に、フックごと git を停止し、`timed-out` を短時間で返し、remote が変更されないことを確認します。')
    const { stack, remoteBefore, hook } = stepSync('遅い pre-push のフックを置いたスタックを用意する', () => {
      const created = createStack()
      const before = sha(created.origin, 'upper')
      commitFile(created.upper, 'local.txt', 'x\n', 'local')
      return { stack: created, remoteBefore: before, hook: installSlowPrePush(created.upper) }
    })
    const started = Date.now()
    const result = await step('時間切れを指定して push する', async () => await pushWithLease(stack.upper, 'origin', 'upper', remoteBefore, { timeoutMilliseconds: 2000 }))
    const elapsed = Date.now() - started
    await step('時間切れの結果と remote を比べる', () => {
      expect(elapsed).toBeLessThan(HOOK_SECONDS * 1000 / 2)
      expect(result).toMatchObject({ pushed: false, reason: 'timed-out' })
      expect(sha(stack.origin, 'upper')).toBe(remoteBefore)
    })
    await step('フックが止まったことを確かめる', async () => {
      await expect.poll(() => isRunning(hook.pid())).toBe(false)
    })
  })

  it('push の待機中に取り消されると、フックごと git を停止してすぐに CancelledError を発生させ、remote を変更しない', async () => {
    await explains('`pushWithLease` のテストです。`pre-push` のフックの実行中に取り消した場合は、フックごと git を停止して `CancelledError` を発生させ、remote を変更しないことを確認します。')
    const { stack, remoteBefore, hook } = stepSync('遅い pre-push のフックを置いたスタックを用意する', () => {
      const created = createStack()
      const before = sha(created.origin, 'upper')
      commitFile(created.upper, 'local.txt', 'x\n', 'local')
      return { stack: created, remoteBefore: before, hook: installSlowPrePush(created.upper) }
    })
    const controller = new AbortController()
    const started = Date.now()
    const { pending } = await step('push を始める', () => ({ pending: pushWithLease(stack.upper, 'origin', 'upper', remoteBefore, { signal: controller.signal }) }))
    await step('フックの起動を待つ', async () => {
      await expect.poll(() => hook.pid()).toBeDefined()
    })
    await step('push を取り消す', () => {
      controller.abort('stop')
    })
    await step('取り消しのエラーを確かめる', async () => {
      await expect(pending).rejects.toThrow(new CancelledError('stop'))
    })
    const elapsed = Date.now() - started
    await step('経過時間と remote を比べる', () => {
      expect(elapsed).toBeLessThan(HOOK_SECONDS * 1000 / 2)
      expect(sha(stack.origin, 'upper')).toBe(remoteBefore)
    })
    await step('フックが止まったことを確かめる', async () => {
      await expect.poll(() => isRunning(hook.pid())).toBe(false)
    })
  })
})

const HOOK_SECONDS = 30

// 返らないフックの代わりに、30 秒かかる pre-push のフックを置く。フックは自分の pid を書く。linked worktree でも共通の hooks に置く
function installSlowPrePush(cwd: string): { readonly pid: () => number | undefined } {
  const hooks = path.resolve(cwd, gitForTest(cwd, ['rev-parse', '--git-path', 'hooks']).trim())
  mkdirSync(hooks, { recursive: true })
  const hook = path.join(hooks, 'pre-push')
  const pidFile = path.join(hooks, 'pre-push.pid')
  writeFileSync(hook, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep ${String(HOOK_SECONDS)}\n`)
  chmodSync(hook, 0o755)
  return {
    pid: () => {
      const text = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : ''
      return text === '' ? undefined : Number(text)
    },
  }
}

function isRunning(pid: number | undefined): boolean {
  if (pid === undefined) throw new Error('the hook did not start')
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error: unknown) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

describe('remoteOnlyChanges', () => {
  it('GitHub が書き換えた子ブランチのコミットと、親ブランチ・開発ブランチのコミットは、一覧に含めない', async () => {
    await explains('remote にだけ存在するコミットを返す `remoteOnlyChanges` のテストです。GitHub が子ブランチを書き換えただけの場合に、書き換えたコミットと親・開発ブランチのコミットを除いた、空の一覧を返すことを確認します。')
    const stack = stepSync('親ブランチを統合し、remote の子ブランチを書き換えたスタックを用意する', () => {
      const created = createStack()
      squashLowerIntoMain(created)
      rewriteRemoteUpperOntoMain(created)
      return created
    })
    const fetched = await step('remote から取得する', async () => await fetchRemote(stack.upper, 'origin'))
    const changes = stepSync('remote にだけあるコミットを求める', () => remoteOnlyChanges(stack.upper, 'HEAD', 'origin/upper', [stack.recordedBase, 'origin/main']))
    await step('一覧が空であることを確かめる', () => {
      expect(fetched).toMatchObject({ succeeded: true })
      expect(changes).toEqual([])
    })
  })

  it('親ブランチの修正が子ブランチの変更の近くに入った場合は、書き換えたコミットはスタックし直す前の HEAD とは一致せず、スタックし直した後の HEAD とは一致する', async () => {
    await explains('`remoteOnlyChanges` のテストです。親ブランチの修正が子ブランチの変更に近い場合は、スタックし直す前の HEAD では書き換えたコミットが 1 件残り、直した後の HEAD では空の一覧を返すことを確認します。')
    const { stack, rewritten } = stepSync('親ブランチの修正が子ブランチの変更に近いスタックを用意する', () => {
      const initial = createStack()
      commitFile(initial.lower, 'f.txt', numbered({}), 'L2')
      gitForTest(initial.upper, ['rebase', '-q', 'lower'])
      const commit = commitFile(initial.upper, 'f.txt', numbered({ 8: 'upper' }), 'U3')
      gitForTest(initial.upper, ['push', '-q', '-f', 'origin', 'upper'])
      const created = { ...initial, recordedBase: sha(initial.lower, 'lower') }
      commitFile(created.lower, 'f.txt', numbered({ 5: 'fixed' }), 'fix near the upper change')
      gitForTest(created.lower, ['push', '-q', 'origin', 'lower'])
      squashLowerIntoMain(created)
      rewriteRemoteUpperOntoMain(created)
      return { stack: created, rewritten: commit }
    })
    const fetched = await step('remote から取得する', async () => await fetchRemote(stack.upper, 'origin'))
    const excluded = [stack.recordedBase, 'origin/main']
    const beforeRebase = stepSync('スタックし直す前の HEAD で remote にだけあるコミットを求める', () => remoteOnlyChanges(stack.upper, rewritten, 'origin/upper', excluded))
    const outcome = stepSync('子ブランチをスタックし直す', () => rebaseOnto(stack.upper, 'origin/main', stack.recordedBase))
    const afterRebase = stepSync('スタックし直した後の HEAD で remote にだけあるコミットを求める', () => remoteOnlyChanges(stack.upper, 'HEAD', 'origin/upper', excluded))
    await step('前後の一覧を比べる', () => {
      expect(fetched).toMatchObject({ succeeded: true })
      expect(beforeRebase).toHaveLength(1)
      expect(outcome).toBe('done')
      expect(afterRebase).toEqual([])
    })
  })

  it('remote の子ブランチにだけ追加されたコミットは、一覧に含める', async () => {
    await explains('`remoteOnlyChanges` のテストです。GitHub の書き換えに加えて、remote の子ブランチにだけコミット（`apply suggestion`）が追加された場合に、そのコミットだけを返すことを確認します。')
    const { stack, suggestion } = stepSync('remote の子ブランチにだけコミットを追加したスタックを用意する', () => {
      const created = createStack()
      squashLowerIntoMain(created)
      return { stack: created, suggestion: rewriteRemoteUpperOntoMain(created, 'apply suggestion') }
    })
    const fetched = await step('remote から取得する', async () => await fetchRemote(stack.upper, 'origin'))
    const changes = stepSync('remote にだけあるコミットを求める', () => remoteOnlyChanges(stack.upper, 'HEAD', 'origin/upper', [stack.recordedBase, 'origin/main']))
    await step('追加したコミットだけが返ることを確かめる', () => {
      expect(fetched).toMatchObject({ succeeded: true })
      expect(changes).toEqual([suggestion])
    })
  })

  it('書き換えがない remote の子ブランチにだけ追加されたコミットは、一覧に含め、親ブランチの新しいコミットは含めない', async () => {
    await explains('`remoteOnlyChanges` のテストです。書き換えがなく remote の子ブランチにだけコミットが追加された場合に、そのコミットだけを返し、親ブランチの新しいコミットを含めないことを確認します。')
    const { stack, suggestion } = stepSync('書き換えの無い remote の子ブランチにコミットを追加したスタックを用意する', () => {
      const created = createStack()
      commitFile(created.lower, 'lower2.txt', 'l2\n', 'L2')
      gitForTest(created.lower, ['push', '-q', 'origin', 'lower'])
      const scratch = makeTemporaryDirectory('pecot-suggest-')
      gitForTest(scratch, ['clone', '-q', '-b', 'upper', created.origin, '.'])
      gitForTest(scratch, ['config', 'commit.gpgsign', 'false'])
      const commit = commitFile(scratch, 'suggestion.txt', 's\n', 'apply suggestion')
      gitForTest(scratch, ['push', '-q', 'origin', 'upper'])
      return { stack: created, suggestion: commit }
    })
    const fetched = await step('remote から取得する', async () => await fetchRemote(stack.upper, 'origin'))
    const changes = stepSync('remote にだけあるコミットを求める', () => remoteOnlyChanges(stack.upper, 'HEAD', 'origin/upper', [stack.recordedBase, 'origin/lower']))
    await step('追加したコミットだけが返ることを確かめる', () => {
      expect(fetched).toMatchObject({ succeeded: true })
      expect(changes).toEqual([suggestion])
    })
  })
})

describe('fetchRemote', () => {
  it('remote が存在しない場合は、失敗と標準エラーを返す', async () => {
    await explains('remote から取得する `fetchRemote` のテストです。存在しない remote を指定した場合に、`succeeded` が `false` の結果と、remote 名を含む標準エラーを返すことを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    const result = await step('存在しない remote から取得する', async () => await fetchRemote(stack.upper, 'no-such-remote'))
    await step('失敗と標準エラーを比べる', () => {
      expect(result.succeeded).toBe(false)
      expect(result.stderr).toContain('no-such-remote')
    })
  })

  it('取り消すと、待機中の upload-pack ごと停止し、CancelledError を発生させる', async () => {
    await explains('`fetchRemote` のテストです。`upload-pack` が応答しない状態で `AbortSignal` により取り消した場合に、`upload-pack` のプロセスも停止し、`CancelledError` が発生することを確認します。')
    const { stack, hang } = stepSync('応答しない upload-pack を設定したスタックを用意する', () => {
      const created = createStack()
      return { stack: created, hang: hangUploadPack(created.upper) }
    })
    const controller = new AbortController()
    const { fetching } = await step('remote からの取得を始める', () => ({ fetching: fetchRemote(stack.upper, 'origin', controller.signal) }))
    const pid = await step('upload-pack の pid を読む', async () => await pidOf(hang))
    await step('取得を取り消す', () => {
      controller.abort('stop')
    })
    await step('取り消しのエラーを確かめる', async () => {
      await expect(fetching).rejects.toThrow(new CancelledError('stop'))
    })
    await step('upload-pack が止まったことを確かめる', async () => {
      await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
    })
  })
})

describe('remoteBranchHead', () => {
  it('remote にブランチが存在する場合は、その先頭の SHA を返す', async () => {
    await explains('remote のブランチの先頭を返す `remoteBranchHead` のテストです。remote にブランチが存在する場合に、`isReachable` が `true` で、その先頭の SHA を返すことを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    const head = await step('remote のブランチの先頭を求める', async () => await remoteBranchHead(stack.upper, 'origin', 'lower'))
    await step('先頭を比べる', () => {
      expect(head).toEqual({ isReachable: true, sha: stack.recordedBase })
    })
  })

  it('remote にブランチが存在しない場合は、sha が undefined の結果を返す', async () => {
    await explains('`remoteBranchHead` のテストです。remote に指定したブランチが存在しない場合に、`isReachable` が `true` で `sha` が `undefined` の結果を返すことを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    const head = await step('存在しないブランチの先頭を求める', async () => await remoteBranchHead(stack.upper, 'origin', 'no-such-branch'))
    await step('結果を比べる', () => {
      expect(head).toEqual({ isReachable: true, sha: undefined })
    })
  })

  it('remote に接続できない場合は、isReachable が false の結果を返す', async () => {
    await explains('`remoteBranchHead` のテストです。存在しない remote を指定した場合に、`isReachable` が `false` の結果を返すことを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    const head = await step('存在しない remote のブランチの先頭を求める', async () => await remoteBranchHead(stack.upper, 'no-such-remote', 'lower'))
    await step('結果を比べる', () => {
      expect(head).toEqual({ isReachable: false })
    })
  })
})

describe('remoteTagExists', () => {
  it('remote にタグが存在する場合は isFound が true、存在しない場合は false を返す', async () => {
    await explains('remote のタグを確認する `remoteTagExists` のテストです。タグ `v1.0.0` を push した場合に `isFound` が `true`、存在しない `v2.0.0` の場合に `false` を返すことを確認します。')
    const stack = stepSync('タグを push したスタックを用意する', () => {
      const created = createStack()
      gitForTest(created.lower, ['tag', 'v1.0.0'])
      gitForTest(created.lower, ['push', '-q', 'origin', 'v1.0.0'])
      return created
    })
    const found = await step('存在するタグを確認する', async () => await remoteTagExists(stack.upper, 'origin', 'v1.0.0'))
    const missing = await step('存在しないタグを確認する', async () => await remoteTagExists(stack.upper, 'origin', 'v2.0.0'))
    await step('確認の結果を比べる', () => {
      expect(found).toEqual({ isFound: true })
      expect(missing).toEqual({ isFound: false })
    })
  })

  it('remote に接続できない場合は、failure に git の標準エラーを返す', async () => {
    await explains('`remoteTagExists` のテストです。存在しない remote を指定した場合に、`failure` に remote 名を含む標準エラーを返すことを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    const result = await step('存在しない remote のタグを確認する', async () => await remoteTagExists(stack.upper, 'no-such-remote', 'v1.0.0'))
    await step('failure を比べる', () => {
      expect('failure' in result && result.failure).toContain('no-such-remote')
    })
  })

  it('取り消すと、待機中の upload-pack ごと停止し、CancelledError を発生させる', async () => {
    await explains('`remoteTagExists` のテストです。`upload-pack` が応答しない状態で `AbortSignal` により取り消した場合に、`upload-pack` のプロセスも停止し、`CancelledError` が発生することを確認します。')
    const { stack, hang } = stepSync('応答しない upload-pack を設定したスタックを用意する', () => {
      const created = createStack()
      return { stack: created, hang: hangUploadPack(created.upper) }
    })
    const controller = new AbortController()
    const { listing } = await step('remote のタグの確認を始める', () => ({ listing: remoteTagExists(stack.upper, 'origin', 'v1.0.0', controller.signal) }))
    const pid = await step('upload-pack の pid を読む', async () => await pidOf(hang))
    await step('確認を取り消す', () => {
      controller.abort('stop')
    })
    await step('取り消しのエラーを確かめる', async () => {
      await expect(listing).rejects.toThrow(new CancelledError('stop'))
    })
    await step('upload-pack が止まったことを確かめる', async () => {
      await expect.poll(() => isAlive(pid), { timeout: 2000, interval: 20 }).toBe(false)
    })
  })
})

describe('resolveCommit と mergeBase', () => {
  it('ref の SHA を返し、存在しない ref は undefined を返す', async () => {
    await explains('ref を SHA に解決する `resolveCommit` のテストです。存在する ref の場合に SHA を返し、存在しない ref の場合に `undefined` を返すことを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    const resolved = stepSync('ref を SHA に解決する', () => ({ existing: resolveCommit(stack.upper, 'lower'), missing: resolveCommit(stack.upper, 'no-such-branch') }))
    stepSync('解決した結果を比べる', () => {
      expect(resolved.existing).toBe(stack.recordedBase)
      expect(resolved.missing).toBeUndefined()
    })
  })

  it('2 つの ref の merge-base を返し、共通の祖先がない場合は undefined を返す', async () => {
    await explains('`mergeBase` のテストです。共通の祖先を持つ 2 つの ref の場合に merge-base の SHA を返し、孤立したブランチで共通の祖先がない場合に `undefined` を返すことを確認します。')
    const stack = stepSync('スタックを用意する', () => createStack())
    const shared = stepSync('共通の祖先を持つ 2 つの ref の merge-base を求める', () => mergeBase(stack.upper, 'upper', 'main'))
    stepSync('merge-base を比べる', () => {
      expect(shared).toBe(sha(stack.upper, 'main'))
    })
    stepSync('孤立したブランチを作る', () => {
      gitForTest(stack.upper, ['switch', '-q', '--orphan', 'orphan'])
      commitFile(stack.upper, 'orphan.txt', 'o\n', 'orphan')
    })
    const isolated = stepSync('孤立したブランチの merge-base を求める', () => mergeBase(stack.upper, 'orphan', 'main'))
    stepSync('merge-base が無いことを確かめる', () => {
      expect(isolated).toBeUndefined()
    })
  })
})

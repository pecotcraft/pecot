/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { setEnvironment, useIsolatedEnvironment } from '../../tests/_helpers/environment.js'
import { createGitRepository, gitEnvironment, gitForTest } from '../../tests/_helpers/git-repository.js'
import { makeTemporaryDirectory } from '../../tests/_helpers/temporary.js'
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
  remoteOnlyChanges,
  resetHardTo,
  resolveCommit,
} from '../git.js'

useIsolatedEnvironment()

beforeEach(() => {
  setEnvironment({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' })
})

interface Stack {
  readonly origin: string
  /**
  下の段（lower）を checkout した作業ディレクトリ
  */
  readonly lower: string
  /**
  上の段（upper）を checkout した linked worktree
  */
  readonly upper: string
  /**
  上の段の着手のときに記録した base の位置（lower の先頭）
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
main ← lower ← upper の積んだブランチ。lower と upper は別の作業ディレクトリで、どちらも origin に push 済み
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

/**
下の段を squash で main に入れる。main には先に別の変更も入れておく
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
GitHub がリモートの上の段を main の上に書き換えたのと同じ形にする。コミットの日時をずらし、手元の載せ直しと SHA を変える
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
上の段と下の段が base.txt の同じ行を変え、載せ直しが衝突する
*/
function createConflictingStack(): Stack {
  const stack = createStack()
  commitFile(stack.upper, 'base.txt', 'upper\n', 'U3 edits base')
  commitFile(stack.lower, 'base.txt', 'lower\n', 'L2 edits base')
  return stack
}

describe('rebaseOnto', () => {
  it('下の段にコミットを足すと、上の段を記録の位置から下の段の新しい先頭へ載せ直す', () => {
    const stack = createStack()
    const newLower = commitFile(stack.lower, 'lower2.txt', 'l2\n', 'L2')

    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('done')

    expect(sha(stack.upper, 'HEAD~2')).toBe(newLower)
    expect(subjects(stack.upper, 'lower..HEAD')).toEqual(['U2', 'U1'])
  })

  it('下の段を squash で開発ブランチへ入れた後、上の段を開発ブランチへ載せ、下の段のコミットを落とす', () => {
    const stack = createStack()
    squashLowerIntoMain(stack)
    expect(fetchRemote(stack.upper, 'origin').succeeded).toBe(true)

    expect(rebaseOnto(stack.upper, 'origin/main', stack.recordedBase)).toBe('done')

    expect(sha(stack.upper, 'HEAD~2')).toBe(sha(stack.upper, 'origin/main'))
    expect(subjects(stack.upper, 'origin/main..HEAD')).toEqual(['U2', 'U1'])
    expect(readFileSync(path.join(stack.upper, 'lower.txt'), 'utf8')).toBe('l1\n')
  })

  it('もう一方の作業ディレクトリの、未コミットの変更とブランチの位置を変えない', () => {
    const stack = createStack()
    commitFile(stack.lower, 'lower2.txt', 'l2\n', 'L2')
    writeFileSync(path.join(stack.lower, 'lower.txt'), 'edited\n')
    writeFileSync(path.join(stack.lower, 'untracked.txt'), 'u\n')
    const statusBefore = gitForTest(stack.lower, ['status', '--porcelain'])
    const lowerBefore = sha(stack.lower, 'lower')

    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('done')

    expect(gitForTest(stack.lower, ['status', '--porcelain'])).toBe(statusBefore)
    expect(sha(stack.lower, 'lower')).toBe(lowerBefore)
    expect(readFileSync(path.join(stack.lower, 'lower.txt'), 'utf8')).toBe('edited\n')
  })

  it('rebase.updateRefs を true にしていても、範囲の中を指す別のローカルブランチを書き換えない', () => {
    const stack = createStack()
    gitForTest(stack.upper, ['config', 'rebase.updateRefs', 'true'])
    gitForTest(stack.upper, ['branch', 'marker', 'HEAD~1'])
    const markerBefore = sha(stack.upper, 'marker')
    commitFile(stack.lower, 'lower2.txt', 'l2\n', 'L2')

    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('done')

    expect(sha(stack.upper, 'marker')).toBe(markerBefore)
    expect(sha(stack.upper, 'HEAD~2')).toBe(sha(stack.upper, 'lower'))
  })

  it('衝突すると conflict を返し、conflictedFiles が衝突したファイルを返す', () => {
    const stack = createConflictingStack()

    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('conflict')

    expect(conflictedFiles(stack.upper)).toEqual(['base.txt'])
  })

  it('衝突以外で失敗すると GitCommandError を投げる', () => {
    const stack = createStack()
    expect(() => rebaseOnto(stack.upper, 'no-such-branch', stack.recordedBase)).toThrow(GitCommandError)
    expect(isRebaseInProgress(stack.upper)).toBe(false)
  })

  it('既に rebase の途中なら、衝突と読まずに GitCommandError を投げる', () => {
    const stack = createConflictingStack()
    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('conflict')

    expect(() => rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toThrow(GitCommandError)
    expect(isRebaseInProgress(stack.upper)).toBe(true)
  })
})

describe('abortRebase と continueRebase', () => {
  it('衝突の後に abortRebase すると、載せ直しの前の位置に戻る', () => {
    const stack = createConflictingStack()
    const before = sha(stack.upper, 'HEAD')
    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('conflict')

    abortRebase(stack.upper)

    expect(sha(stack.upper, 'HEAD')).toBe(before)
    expect(gitForTest(stack.upper, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('upper')
  })

  it('衝突を解かずに continueRebase すると、conflict を返す', () => {
    const stack = createConflictingStack()
    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('conflict')

    expect(continueRebase(stack.upper)).toBe('conflict')
    expect(isRebaseInProgress(stack.upper)).toBe(true)
  })

  it('衝突を解いて continueRebase すると、エディタを開かずに done を返す', () => {
    const stack = createConflictingStack()
    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('conflict')
    writeFileSync(path.join(stack.upper, 'base.txt'), 'resolved\n')
    gitForTest(stack.upper, ['add', 'base.txt'])
    setEnvironment({ GIT_EDITOR: 'false' })

    expect(continueRebase(stack.upper)).toBe('done')

    expect(sha(stack.upper, 'HEAD~3')).toBe(sha(stack.upper, 'lower'))
    expect(subjects(stack.upper, 'lower..HEAD')).toEqual(['U3 edits base', 'U2', 'U1'])
    expect(isRebaseInProgress(stack.upper)).toBe(false)
  })
})

describe('isRebaseInProgress', () => {
  it('.git がファイルの worktree でも、衝突中は true、取りやめた後と前は false を返す', () => {
    const stack = createConflictingStack()
    expect(statSync(path.join(stack.upper, '.git')).isFile()).toBe(true)
    expect(isRebaseInProgress(stack.upper)).toBe(false)

    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('conflict')
    expect(isRebaseInProgress(stack.upper)).toBe(true)
    expect(isRebaseInProgress(stack.lower)).toBe(false)

    abortRebase(stack.upper)
    expect(isRebaseInProgress(stack.upper)).toBe(false)
  })
})

describe('hasSameTree と resetHardTo', () => {
  it('載せ直した木が origin の上の段と同じなら true を返し、resetHardTo の後は origin と同じ SHA になる', () => {
    const stack = createStack()
    squashLowerIntoMain(stack)
    rewriteRemoteUpperOntoMain(stack)
    expect(fetchRemote(stack.upper, 'origin').succeeded).toBe(true)
    expect(rebaseOnto(stack.upper, 'origin/main', stack.recordedBase)).toBe('done')
    expect(sha(stack.upper, 'HEAD')).not.toBe(sha(stack.upper, 'origin/upper'))

    expect(hasSameTree(stack.upper, 'HEAD', 'origin/upper')).toBe(true)
    resetHardTo(stack.upper, 'origin/upper')

    expect(sha(stack.upper, 'HEAD')).toBe(sha(stack.upper, 'origin/upper'))
    expect(gitForTest(stack.upper, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('upper')
  })

  it('木が違えば false を返す', () => {
    const stack = createStack()
    commitFile(stack.lower, 'lower2.txt', 'l2\n', 'L2')
    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('done')

    expect(hasSameTree(stack.upper, 'HEAD', 'origin/upper')).toBe(false)
  })

  it('比べる ref が無ければ GitCommandError を投げる', () => {
    const stack = createStack()
    expect(() => hasSameTree(stack.upper, 'HEAD', 'origin/no-such-branch')).toThrow(GitCommandError)
  })
})

describe('pushWithLease', () => {
  it('期待の SHA が remote と同じなら push し、remote が手元の SHA になる', () => {
    const stack = createStack()
    commitFile(stack.lower, 'lower2.txt', 'l2\n', 'L2')
    const expected = sha(stack.upper, 'origin/upper')
    expect(rebaseOnto(stack.upper, 'lower', stack.recordedBase)).toBe('done')

    expect(pushWithLease(stack.upper, 'origin', 'upper', expected)).toEqual({ pushed: true })

    expect(sha(stack.origin, 'upper')).toBe(sha(stack.upper, 'HEAD'))
  })

  it('期待の SHA が remote の先頭に一致しなければ拒まれ、remote を変えない', () => {
    const stack = createStack()
    const remoteBefore = sha(stack.origin, 'upper')
    commitFile(stack.upper, 'local.txt', 'x\n', 'local')

    const result = pushWithLease(stack.upper, 'origin', 'upper', stack.recordedBase)

    expect(result.pushed).toBe(false)
    expect(result.pushed ? '' : result.stderr).toContain('stale info')
    expect(sha(stack.origin, 'upper')).toBe(remoteBefore)
  })
})

describe('remoteOnlyChanges', () => {
  it('GitHub が書き換えた上の段のコミットと、下の段・開発ブランチのコミットは一覧に入れない', () => {
    const stack = createStack()
    squashLowerIntoMain(stack)
    rewriteRemoteUpperOntoMain(stack)
    expect(fetchRemote(stack.upper, 'origin').succeeded).toBe(true)

    expect(remoteOnlyChanges(stack.upper, 'HEAD', 'origin/upper', [stack.recordedBase, 'origin/main'])).toEqual([])
  })

  it('下の段の直しが上の段の変更の近くに入ると、書き換えたコミットは載せ直しの前の HEAD とは合わず、載せ直した後の HEAD とは合う', () => {
    const initial = createStack()
    commitFile(initial.lower, 'f.txt', numbered({}), 'L2')
    gitForTest(initial.upper, ['rebase', '-q', 'lower'])
    const rewritten = commitFile(initial.upper, 'f.txt', numbered({ 8: 'upper' }), 'U3')
    gitForTest(initial.upper, ['push', '-q', '-f', 'origin', 'upper'])
    const stack = { ...initial, recordedBase: sha(initial.lower, 'lower') }
    commitFile(stack.lower, 'f.txt', numbered({ 5: 'fixed' }), 'fix near the upper change')
    gitForTest(stack.lower, ['push', '-q', 'origin', 'lower'])
    squashLowerIntoMain(stack)
    rewriteRemoteUpperOntoMain(stack)
    expect(fetchRemote(stack.upper, 'origin').succeeded).toBe(true)
    const excluded = [stack.recordedBase, 'origin/main']

    expect(remoteOnlyChanges(stack.upper, rewritten, 'origin/upper', excluded)).toHaveLength(1)
    expect(rebaseOnto(stack.upper, 'origin/main', stack.recordedBase)).toBe('done')
    expect(remoteOnlyChanges(stack.upper, 'HEAD', 'origin/upper', excluded)).toEqual([])
  })

  it('remote の上の段にだけ足されたコミットを一覧に入れる', () => {
    const stack = createStack()
    squashLowerIntoMain(stack)
    const suggestion = rewriteRemoteUpperOntoMain(stack, 'apply suggestion')
    expect(fetchRemote(stack.upper, 'origin').succeeded).toBe(true)

    expect(remoteOnlyChanges(stack.upper, 'HEAD', 'origin/upper', [stack.recordedBase, 'origin/main'])).toEqual([suggestion])
  })

  it('書き換えの無い remote の上の段にだけ足されたコミットを一覧に入れ、下の段の新しいコミットは入れない', () => {
    const stack = createStack()
    commitFile(stack.lower, 'lower2.txt', 'l2\n', 'L2')
    gitForTest(stack.lower, ['push', '-q', 'origin', 'lower'])
    const scratch = makeTemporaryDirectory('pecot-suggest-')
    gitForTest(scratch, ['clone', '-q', '-b', 'upper', stack.origin, '.'])
    gitForTest(scratch, ['config', 'commit.gpgsign', 'false'])
    const suggestion = commitFile(scratch, 'suggestion.txt', 's\n', 'apply suggestion')
    gitForTest(scratch, ['push', '-q', 'origin', 'upper'])
    expect(fetchRemote(stack.upper, 'origin').succeeded).toBe(true)

    expect(remoteOnlyChanges(stack.upper, 'HEAD', 'origin/upper', [stack.recordedBase, 'origin/lower'])).toEqual([suggestion])
  })
})

describe('fetchRemote', () => {
  it('remote が無ければ、失敗と stderr を返す', () => {
    const stack = createStack()
    const result = fetchRemote(stack.upper, 'no-such-remote')
    expect(result.succeeded).toBe(false)
    expect(result.stderr).toContain('no-such-remote')
  })
})

describe('resolveCommit と mergeBase', () => {
  it('ref の SHA を返し、無い ref は undefined を返す', () => {
    const stack = createStack()
    expect(resolveCommit(stack.upper, 'lower')).toBe(stack.recordedBase)
    expect(resolveCommit(stack.upper, 'no-such-branch')).toBeUndefined()
  })

  it('2 つの ref の merge-base を返し、共通の祖先が無ければ undefined を返す', () => {
    const stack = createStack()
    expect(mergeBase(stack.upper, 'upper', 'main')).toBe(sha(stack.upper, 'main'))
    gitForTest(stack.upper, ['switch', '-q', '--orphan', 'orphan'])
    commitFile(stack.upper, 'orphan.txt', 'o\n', 'orphan')
    expect(mergeBase(stack.upper, 'orphan', 'main')).toBeUndefined()
  })
})

import { describe, expect, it, vi } from 'vitest'

import { validationErrorTextOutput } from '../../tests/_helpers/python-output.js'
import { InvalidValueError } from '../errors.js'
import type { GitResult, GitRunner } from '../git-runner.js'
import {
  AmbiguousRepositoryError,
  createRepositoryReference,
  createResolvedRepository,
  detectCurrentGitRepository,
  parseOwnerRepository,
  pickPrimaryRemote,
  repositoryFullName,
  resolveRepository,
} from '../repository-resolver.js'

interface FakeGitOptions {
  readonly isInsideWorktree?: boolean
  readonly remotes?: readonly string[]
  readonly remoteUrls?: Readonly<Record<string, string>>
}

/**
git のメモリ上の実装。最初の引数で分岐する。
- rev-parse --is-inside-work-tree: true か 128
- remote: 名前を 1 行ずつ
- remote get-url <name>: URL か 128
*/
function result(exitCode: number, stdout: string, stderr = ''): GitResult {
  return { exitCode, stdout, stderr }
}

function fakeGit(options: FakeGitOptions = {}): GitRunner {
  const { isInsideWorktree = true, remotes = [], remoteUrls = {} } = options
  return (arguments_) => {
    const [command, subcommand, name] = arguments_
    if (command === 'rev-parse') return isInsideWorktree ? result(0, 'true\n') : result(128, '', 'fatal: not a git repository')
    if (command === 'remote' && arguments_.length === 1) return result(0, remotes.length > 0 ? `${remotes.join('\n')}\n` : '')
    if (command === 'remote' && subcommand === 'get-url' && name !== undefined) {
      const url = new Map(Object.entries(remoteUrls)).get(name)
      return url === undefined ? result(128, '', 'fatal: No such remote') : result(0, `${url}\n`)
    }
    throw new Error(`unexpected git args: ${arguments_.join(' ')}`)
  }
}

describe('parseOwnerRepository（成功）', () => {
  it.each([
    ['owner/repo', 'owner', 'repo'],
    ['owner.io/my-repo', 'owner.io', 'my-repo'],
    ['my_org/my_repo', 'my_org', 'my_repo'],
    ['a.b.c/x.y.z', 'a.b.c', 'x.y.z'],
    ['my-org/my-repo', 'my-org', 'my-repo'],
    ['A/B', 'A', 'B'],
  ])('%j を分ける', (raw, owner, repository) => {
    expect(parseOwnerRepository(raw)).toEqual({ owner, repository })
  })
})

describe('parseOwnerRepository（失敗）', () => {
  it.each([
    '',
    'ownerrepo',
    'owner/repo/extra',
    'owner/',
    '/repo',
    'owner//repo',
    'owner/repo/',
    ' owner/repo',
    'owner/repo ',
    'owner /repo',
    'owner@bad/repo',
    'owner/repo name',
    'オーナー/リポ',
    'owner/repo#123',
    './repo',
    'owner/..',
    '../repo',
    'owner/.',
  ])('%j は値の不正', (raw) => {
    expect(() => parseOwnerRepository(raw)).toThrow(InvalidValueError)
  })

  it('スラッシュの数が違うときの文は Python と同じ', () => {
    expect(() => parseOwnerRepository('ownerrepo')).toThrow('invalid owner/repo form: \'ownerrepo\' (expected: \'owner/repo\')')
    expect(() => parseOwnerRepository('owner/repo/extra')).toThrow('invalid owner/repo form: \'owner/repo/extra\' (expected: \'owner/repo\')')
  })

  it('セグメントが不正なときの文は検証エラーの書式（Python の実出力）', () => {
    const { input, message } = validationErrorTextOutput('repo-ref-bad-owner')
    expect(() => parseOwnerRepository(input)).toThrow(message)
    expect(() => parseOwnerRepository('o/bad@repo')).toThrow('1 validation error for RepoRef\nrepo\n  Value error, invalid owner/repo segment: \'bad@repo\'')
  })
})

describe('createRepositoryReference', () => {
  it('owner が不正なら例外', () => {
    expect(() => createRepositoryReference('bad owner', 'repo')).toThrow(InvalidValueError)
  })

  it('repository が不正なら例外', () => {
    expect(() => createRepositoryReference('owner', 'bad@repo')).toThrow(InvalidValueError)
  })

  it('空文字は例外', () => {
    expect(() => createRepositoryReference('', 'repo')).toThrow(InvalidValueError)
  })

  it('両方が不正なら 2 件のエラーを 1 つの文にまとめる', () => {
    expect(() => createRepositoryReference('a b', 'c d')).toThrow(/^2 validation errors for RepoRef\nowner\n.*\n.*\nrepo\n/u)
  })
})

describe('repositoryFullName', () => {
  it('owner と repository を / でつないだ名前を返す', () => {
    expect(repositoryFullName(createRepositoryReference('owner', 'repo'))).toBe('owner/repo')
  })

  it('名前にドットを含む owner/repo を、そのまま owner/repo の形で返す', () => {
    expect(repositoryFullName(parseOwnerRepository('a.io/b.c'))).toBe('a.io/b.c')
  })
})

describe('createResolvedRepository', () => {
  const repository = createRepositoryReference('o', 'r')

  it('explicit は remoteName なし', () => {
    const resolved = createResolvedRepository({ repository, source: 'explicit', remoteName: undefined })
    expect(resolved.source).toBe('explicit')
    expect(resolved.remoteName).toBeUndefined()
  })

  it('current-git は remoteName あり', () => {
    expect(createResolvedRepository({ repository, source: 'current-git', remoteName: 'origin' }).remoteName).toBe('origin')
  })

  it('current-git で remoteName が無いと例外', () => {
    expect(() => createResolvedRepository({ repository, source: 'current-git', remoteName: undefined })).toThrow(InvalidValueError)
    expect(() => createResolvedRepository({ repository, source: 'current-git', remoteName: undefined })).toThrow('remote_name is required when source=CURRENT_GIT')
  })

  it('current-git で remoteName が空文字でも例外', () => {
    expect(() => createResolvedRepository({ repository, source: 'current-git', remoteName: '' })).toThrow(InvalidValueError)
  })

  it('explicit で remoteName があると例外', () => {
    expect(() => createResolvedRepository({ repository, source: 'explicit', remoteName: 'origin' })).toThrow('remote_name must be None when source=EXPLICIT')
  })
})

describe('AmbiguousRepositoryError', () => {
  it('Error であり、メッセージを持つ', () => {
    expect(new AmbiguousRepositoryError('ambiguous')).toBeInstanceOf(Error)
    expect(() => {
      throw new AmbiguousRepositoryError('ambiguous')
    }).toThrow(AmbiguousRepositoryError)
  })
})

describe('detectCurrentGitRepository', () => {
  it('git の外なら undefined', () => {
    expect(detectCurrentGitRepository(fakeGit({ isInsideWorktree: false }))).toBeUndefined()
  })

  it('origin だけがあるとき、origin の URL からリポジトリを返す', () => {
    const detected = detectCurrentGitRepository(fakeGit({ remotes: ['origin'], remoteUrls: { origin: 'git@github.com:owner/repoA.git' } }))
    expect(detected).toEqual({ repository: { owner: 'owner', repository: 'repoA' }, remoteName: 'origin' })
  })

  it('origin を upstream より優先する', () => {
    const detected = detectCurrentGitRepository(fakeGit({
      remotes: ['origin', 'upstream'],
      remoteUrls: { origin: 'git@github.com:o/origin-repo.git', upstream: 'git@github.com:o/upstream-repo.git' },
    }))
    expect(detected?.remoteName).toBe('origin')
    expect(detected?.repository.repository).toBe('origin-repo')
  })

  it('upstream だけなら先頭の remote を使う', () => {
    const detected = detectCurrentGitRepository(fakeGit({ remotes: ['upstream'], remoteUrls: { upstream: 'https://github.com/o/up.git' } }))
    expect(detected).toEqual({ repository: { owner: 'o', repository: 'up' }, remoteName: 'upstream' })
  })

  it('remote が無ければ undefined', () => {
    expect(detectCurrentGitRepository(fakeGit({ remotes: [] }))).toBeUndefined()
  })

  it('URL が読めなければ値の不正がそのまま伝わる', () => {
    expect(() => detectCurrentGitRepository(fakeGit({ remotes: ['origin'], remoteUrls: { origin: 'foo.bar' } }))).toThrow(InvalidValueError)
  })

  it('remote get-url が失敗したら undefined', () => {
    expect(detectCurrentGitRepository(fakeGit({ remotes: ['origin'], remoteUrls: {} }))).toBeUndefined()
  })
})

describe('resolveRepository', () => {
  it('--repo の明示値は git を呼ばずに勝つ', () => {
    const git = vi.fn<GitRunner>()
    const resolved = resolveRepository('a/b', git)
    expect(git).not.toHaveBeenCalled()
    expect(resolved).toEqual({ repository: { owner: 'a', repository: 'b' }, source: 'explicit', remoteName: undefined })
  })

  it('明示値が無ければ現在の git の origin', () => {
    const resolved = resolveRepository(undefined, fakeGit({ remotes: ['origin'], remoteUrls: { origin: 'git@github.com:o/r.git' } }))
    expect(resolved).toEqual({ repository: { owner: 'o', repository: 'r' }, source: 'current-git', remoteName: 'origin' })
  })

  it('git の外で明示値も無ければ曖昧', () => {
    expect(() => resolveRepository(undefined, fakeGit({ isInsideWorktree: false }))).toThrow(AmbiguousRepositoryError)
    expect(() => resolveRepository(undefined, fakeGit({ isInsideWorktree: false }))).toThrow('repository is ambiguous: pass --repo <owner/repo>')
  })

  it('明示値の形式が不正なら値の不正', () => {
    expect(() => resolveRepository('invalid', fakeGit())).toThrow(InvalidValueError)
  })
})

describe('pickPrimaryRemote', () => {
  it.each([
    [['upstream', 'origin'], 'origin'],
    [['upstream', 'fork'], 'upstream'],
    [[], undefined],
  ])('remote %j から %j を選ぶ', (remotes, expected) => {
    expect(pickPrimaryRemote(remotes)).toBe(expected)
  })
})

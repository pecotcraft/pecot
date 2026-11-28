import { describe, expect, it, vi } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { validationErrorTextOutput } from '../../../tests/_helpers/python-output.js'
import { InvalidValueError } from '../errors.js'
import type { GitResult, GitRunner } from '../git-runner.js'
import {
  AmbiguousRepositoryError,
  createRepositoryReference,
  createResolvedRepository,
  isSameRepository,
  parseOwnerRepository,
  pickPrimaryRemote,
  readCurrentGitRemote,
  repositoryFullName,
  resolveRepository,
  resolveShortReferenceBase,
  splitOwnerRepository,
  UnreadableRemoteError,
  withUnreadableReason,
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

describe('splitOwnerRepository', () => {
  it.each([
    ['octo/hello', { owner: 'octo', repository: 'hello' }],
    ['a/', { owner: 'a', repository: '' }],
    ['/b', { owner: '', repository: 'b' }],
  ])('%s を渡すと、owner と repository の 2 つに分ける（中身は検証しない）', async (raw, expected) => {
    await explains('文字列を owner と repository に分ける `splitOwnerRepository` のテストです。スラッシュで区切った 2 つの部分が空文字でも、中身は検証せず、そのまま 2 つに分けて返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(splitOwnerRepository(raw)).toEqual(expected)
    })
  })

  it.each(['octo', 'a/b/c', ''])('%j を渡すと、2 つに分けられないので undefined を返す', async (raw) => {
    await explains('`splitOwnerRepository` に、2 つに分けられない文字列を渡した場合のテストです。スラッシュがない場合・2 つ以上ある場合・空文字の場合に、`undefined` を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(splitOwnerRepository(raw)).toBeUndefined()
    })
  })
})

describe('parseOwnerRepository（成功）', () => {
  it.each([
    ['owner/repo', 'owner', 'repo'],
    ['owner.io/my-repo', 'owner.io', 'my-repo'],
    ['my_org/my_repo', 'my_org', 'my_repo'],
    ['a.b.c/x.y.z', 'a.b.c', 'x.y.z'],
    ['my-org/my-repo', 'my-org', 'my-repo'],
    ['A/B', 'A', 'B'],
  ])('%j を渡すと、owner と repository に分ける', async (raw, owner, repository) => {
    await explains('`owner/repo` の形の文字列を解析する `parseOwnerRepository` のテストです。ドット・ハイフン・アンダースコアを含む名前や大文字を渡した場合に、owner と repository に分けて返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseOwnerRepository(raw)).toEqual({ owner, repository })
    })
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
  ])('%j を渡すと、値が不正として例外が発生する', async (raw) => {
    await explains('`parseOwnerRepository` に、不正な文字列を渡した場合のテストです。空文字・区切りの数が違う値・使えない文字を含む値などで、`InvalidValueError` の例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseOwnerRepository(raw)).toThrow(InvalidValueError)
    })
  })

  it('スラッシュの数が違うときのメッセージは、Python と同じ文にする', async () => {
    await explains('スラッシュの数が正しくない場合のメッセージのテストです。スラッシュがない場合と 2 つ以上ある場合に、Python と同じ `invalid owner/repo form` の文で例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseOwnerRepository('ownerrepo')).toThrow('invalid owner/repo form: \'ownerrepo\' (expected: \'owner/repo\')')
      expect(() => parseOwnerRepository('owner/repo/extra')).toThrow('invalid owner/repo form: \'owner/repo/extra\' (expected: \'owner/repo\')')
    })
  })

  it('owner や repository の部分が不正なときのメッセージは、検証エラーの書式にする（Python の実際の出力）', async () => {
    await explains('owner や repository の部分が不正な場合のメッセージのテストです。Python の実際の出力と同じ、検証エラーの書式の文で例外が発生することを確認します。')
    const { input, message } = stepSync('検証エラーの出力を用意する', () => validationErrorTextOutput('repo-ref-bad-owner'))
    stepSync('例外を確かめる', () => {
      expect(() => parseOwnerRepository(input)).toThrow(message)
      expect(() => parseOwnerRepository('o/bad@repo')).toThrow('1 validation error for RepoRef\nrepo\n  Value error, invalid owner/repo segment: \'bad@repo\'')
    })
  })
})

describe('createRepositoryReference', () => {
  it('owner が不正なら、例外が発生する', async () => {
    await explains('リポジトリの参照を作る `createRepositoryReference` のテストです。owner に空白を含む値を渡した場合に、`InvalidValueError` の例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => createRepositoryReference('bad owner', 'repo')).toThrow(InvalidValueError)
    })
  })

  it('repository が不正なら、例外が発生する', async () => {
    await explains('`createRepositoryReference` のテストです。repository に使えない文字を含む値を渡した場合に、`InvalidValueError` の例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => createRepositoryReference('owner', 'bad@repo')).toThrow(InvalidValueError)
    })
  })

  it('空文字を渡すと、例外が発生する', async () => {
    await explains('`createRepositoryReference` のテストです。owner が空文字の場合に、`InvalidValueError` の例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => createRepositoryReference('', 'repo')).toThrow(InvalidValueError)
    })
  })

  it('owner と repository の両方が不正なら、2 件のエラーを 1 つのメッセージにまとめる', async () => {
    await explains('`createRepositoryReference` で、owner と repository の両方が不正な場合のテストです。2 件の検証エラーを、1 つのメッセージにまとめて例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => createRepositoryReference('a b', 'c d')).toThrow(/^2 validation errors for RepoRef\nowner\n.*\n.*\nrepo\n/u)
    })
  })
})

describe('repositoryFullName', () => {
  it('owner と repository を / でつないだ名前を返す', async () => {
    await explains('リポジトリの名前を文字列にする `repositoryFullName` のテストです。owner と repository を `/` でつないだ `owner/repo` の形で返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(repositoryFullName(createRepositoryReference('owner', 'repo'))).toBe('owner/repo')
    })
  })

  it('名前にドットを含む owner/repo を、そのまま owner/repo の形で返す', async () => {
    await explains('ドットを含む名前の、`repositoryFullName` のテストです。`a.io/b.c` を解析した結果を文字列にしたとき、同じ `a.io/b.c` の形で返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(repositoryFullName(parseOwnerRepository('a.io/b.c'))).toBe('a.io/b.c')
    })
  })
})

describe('isSameRepository', () => {
  it('大文字と小文字を区別せず、同じリポジトリは同一とし、違うリポジトリは同一としない', async () => {
    await explains('2 つの参照が同じリポジトリかを判定する `isSameRepository` のテストです。大文字と小文字だけが異なる参照は同一とみなし、名前が異なる参照は同一とみなさないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(isSameRepository(createRepositoryReference('Acme', 'App'), createRepositoryReference('acme', 'app'))).toBe(true)
      expect(isSameRepository(createRepositoryReference('acme', 'app'), createRepositoryReference('acme', 'other'))).toBe(false)
    })
  })
})

describe('createResolvedRepository', () => {
  const repository = createRepositoryReference('o', 'r')

  it('解決元が explicit の場合は、remoteName を持たない', async () => {
    await explains('解決したリポジトリを作る `createResolvedRepository` のテストです。解決元が `explicit` で `remoteName` を指定しない場合に、`remoteName` が `undefined` になることを確認します。')
    const resolved = stepSync('createResolvedRepository を呼ぶ', () => createResolvedRepository({ repository, source: 'explicit', remoteName: undefined }))
    stepSync('結果を比べる', () => {
      expect(resolved.source).toBe('explicit')
      expect(resolved.remoteName).toBeUndefined()
    })
  })

  it('解決元が current-git の場合は、remoteName を持つ', async () => {
    await explains('解決元が `current-git` の場合の、`createResolvedRepository` のテストです。`remoteName` に `origin` を渡した場合に、その値を保持することを確認します。')
    stepSync('結果を比べる', () => {
      expect(createResolvedRepository({ repository, source: 'current-git', remoteName: 'origin' }).remoteName).toBe('origin')
    })
  })

  it('解決元が current-git で remoteName が存在しなければ、例外が発生する', async () => {
    await explains('解決元が `current-git` で、`remoteName` を指定しない場合のテストです。`InvalidValueError` の例外が発生し、メッセージが `remote_name is required` から始まることを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => createResolvedRepository({ repository, source: 'current-git', remoteName: undefined })).toThrow(InvalidValueError)
      expect(() => createResolvedRepository({ repository, source: 'current-git', remoteName: undefined })).toThrow('remote_name is required when source=CURRENT_GIT')
    })
  })

  it('解決元が current-git で remoteName が空文字でも、例外が発生する', async () => {
    await explains('解決元が `current-git` で、`remoteName` が空文字の場合のテストです。`InvalidValueError` の例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => createResolvedRepository({ repository, source: 'current-git', remoteName: '' })).toThrow(InvalidValueError)
    })
  })

  it('解決元が explicit で remoteName を指定すると、例外が発生する', async () => {
    await explains('解決元が `explicit` で、`remoteName` を指定した場合のテストです。`remote_name must be None` を含むメッセージで、例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => createResolvedRepository({ repository, source: 'explicit', remoteName: 'origin' })).toThrow('remote_name must be None when source=EXPLICIT')
    })
  })
})

describe('AmbiguousRepositoryError', () => {
  it('Error を継承し、投げると AmbiguousRepositoryError として捕捉できる', async () => {
    await explains('リポジトリが曖昧な場合の例外 `AmbiguousRepositoryError` のテストです。`Error` のインスタンスで、投げた場合に `AmbiguousRepositoryError` として捕捉できることを確認します。')
    stepSync('例外を確かめる', () => {
      expect(new AmbiguousRepositoryError('ambiguous')).toBeInstanceOf(Error)
      expect(() => {
        throw new AmbiguousRepositoryError('ambiguous')
      }).toThrow(AmbiguousRepositoryError)
    })
  })
})

describe('readCurrentGitRemote', () => {
  it('Git リポジトリの外では、undefined を返す', async () => {
    await explains('現在の Git の remote を読み取る `readCurrentGitRemote` のテストです。Git のワークツリーの外で呼んだ場合に、`undefined` を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(readCurrentGitRemote(fakeGit({ isInsideWorktree: false }))).toBeUndefined()
    })
  })

  it('remote が origin だけなら、origin の URL からリポジトリを返す', async () => {
    await explains('remote が `origin` だけの場合の、`readCurrentGitRemote` のテストです。`origin` の URL を解析して、リポジトリの参照と remote 名を返すことを確認します。')
    const current = stepSync('readCurrentGitRemote を呼ぶ', () => readCurrentGitRemote(fakeGit({ remotes: ['origin'], remoteUrls: { origin: 'git@github.com:owner/repoA.git' } })))
    stepSync('結果を比べる', () => {
      expect(current).toEqual({ repository: { owner: 'owner', repository: 'repoA' }, source: 'current-git', remoteName: 'origin' })
    })
  })

  it('origin と upstream がある場合は、origin を優先する', async () => {
    await explains('remote が複数ある場合の、`readCurrentGitRemote` のテストです。`origin` と `upstream` の両方が存在するとき、`origin` の URL を使うことを確認します。')
    const current = stepSync('readCurrentGitRemote を呼ぶ', () => readCurrentGitRemote(fakeGit({
      remotes: ['origin', 'upstream'],
      remoteUrls: { origin: 'git@github.com:o/origin-repo.git', upstream: 'git@github.com:o/upstream-repo.git' },
    })))
    stepSync('結果を比べる', () => {
      expect(current).toMatchObject({ repository: { repository: 'origin-repo' }, remoteName: 'origin' })
    })
  })

  it('remote が upstream だけなら、その remote を使う', async () => {
    await explains('`origin` がない場合の、`readCurrentGitRemote` のテストです。remote が `upstream` だけのとき、先頭の remote である `upstream` の URL を使うことを確認します。')
    const current = stepSync('readCurrentGitRemote を呼ぶ', () => readCurrentGitRemote(fakeGit({ remotes: ['upstream'], remoteUrls: { upstream: 'https://github.com/o/up.git' } })))
    stepSync('結果を比べる', () => {
      expect(current).toEqual({ repository: { owner: 'o', repository: 'up' }, source: 'current-git', remoteName: 'upstream' })
    })
  })

  it('remote が存在しなければ、undefined を返す', async () => {
    await explains('remote を持たない場合の、`readCurrentGitRemote` のテストです。remote が 1 つも存在しないとき、`undefined` を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(readCurrentGitRemote(fakeGit({ remotes: [] }))).toBeUndefined()
    })
  })

  it('URL から owner と repo を読み取れなければ、unreadable-remote を返す', async () => {
    await explains('URL を解析できない場合の、`readCurrentGitRemote` のテストです。ローカルのパスのように owner と repo を読み取れない URL のとき、`unreadable-remote` と remote 名を返すことを確認します。')
    const current = stepSync('readCurrentGitRemote を呼ぶ', () => readCurrentGitRemote(fakeGit({ remotes: ['origin'], remoteUrls: { origin: '/srv/git/bare.git' } })))
    stepSync('結果を比べる', () => {
      expect(current).toEqual({ source: 'unreadable-remote', remoteName: 'origin' })
    })
  })

  it('git remote get-url が失敗したら、undefined を返す', async () => {
    await explains('`git remote get-url` が失敗した場合の、`readCurrentGitRemote` のテストです。remote の URL を取得できないとき、`undefined` を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(readCurrentGitRemote(fakeGit({ remotes: ['origin'], remoteUrls: {} }))).toBeUndefined()
    })
  })
})

describe('resolveShortReferenceBase', () => {
  it('明示した値があれば、その値を base にする', async () => {
    await explains('短縮形の参照の基準を決める `resolveShortReferenceBase` のテストです。リポジトリを明示した場合に、その値を基準にし、読み取れない remote はないものとして返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(resolveShortReferenceBase('a/b', fakeGit())).toEqual({ base: { owner: 'a', repository: 'b' }, unreadable: undefined })
    })
  })

  it('明示した値がなく URL を読み取れなければ、base を決めず、読み取れない remote を返す', async () => {
    await explains('リポジトリを明示せず、remote の URL も解析できない場合の、`resolveShortReferenceBase` のテストです。基準は決めず、読み取れなかった remote の情報を返すことを確認します。')
    const result = stepSync('resolveShortReferenceBase を呼ぶ', () => resolveShortReferenceBase(undefined, fakeGit({ remotes: ['origin'], remoteUrls: { origin: '/srv/git/bare.git' } })))
    stepSync('結果を比べる', () => {
      expect(result).toEqual({ base: undefined, unreadable: { source: 'unreadable-remote', remoteName: 'origin' } })
    })
  })
})

describe('withUnreadableReason', () => {
  it('読み取れない remote があれば、案内の後に理由の行を追加する', async () => {
    await explains('案内の文に理由を追加する `withUnreadableReason` のテストです。読み取れない remote がある場合に、案内の後ろに、URL から読み取れなかった理由の行を追加することを確認します。')
    stepSync('結果を比べる', () => {
      expect(withUnreadableReason('needs a base', { source: 'unreadable-remote', remoteName: 'origin' }))
        .toBe('needs a base\ncould not read the repository from the URL of the Git remote origin')
    })
  })

  it('読み取れない remote がなければ、案内をそのまま返す', async () => {
    await explains('読み取れない remote がない場合の、`withUnreadableReason` のテストです。案内の文を変更せず、そのまま返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(withUnreadableReason('needs a base', undefined)).toBe('needs a base')
    })
  })
})

describe('resolveRepository', () => {
  it('repo で明示した値は、git を呼ばずに採用する', async () => {
    await explains('リポジトリを決める `resolveRepository` のテストです。リポジトリを明示した場合に、git を呼び出さず、その値を `explicit` として返すことを確認します。')
    const git = stepSync('偽の git を用意する', () => vi.fn<GitRunner>())
    const resolved = stepSync('resolveRepository を呼ぶ', () => resolveRepository('a/b', git))
    stepSync('結果を比べる', () => {
      expect(git).not.toHaveBeenCalled()
      expect(resolved).toEqual({ repository: { owner: 'a', repository: 'b' }, source: 'explicit', remoteName: undefined })
    })
  })

  it('明示した値がなければ、現在の git の origin を採用する', async () => {
    await explains('リポジトリを明示しない場合の、`resolveRepository` のテストです。現在の git の `origin` の URL から、リポジトリを `current-git` として返すことを確認します。')
    const resolved = stepSync('resolveRepository を呼ぶ', () => resolveRepository(undefined, fakeGit({ remotes: ['origin'], remoteUrls: { origin: 'git@github.com:o/r.git' } })))
    stepSync('結果を比べる', () => {
      expect(resolved).toEqual({ repository: { owner: 'o', repository: 'r' }, source: 'current-git', remoteName: 'origin' })
    })
  })

  it('Git リポジトリの外で、明示した値もなければ、曖昧として例外が発生する', async () => {
    await explains('Git リポジトリの外で、リポジトリも明示しない場合の、`resolveRepository` のテストです。`AmbiguousRepositoryError` の例外が発生し、`repo` の指定を案内することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => resolveRepository(undefined, fakeGit({ isInsideWorktree: false }))).toThrow(AmbiguousRepositoryError)
      expect(() => resolveRepository(undefined, fakeGit({ isInsideWorktree: false }))).toThrow('repository is ambiguous: pass repo: <owner/repo>')
    })
  })

  it('明示した値がなく remote の URL を読み取れなければ、理由を持つ UnreadableRemoteError を投げる', async () => {
    await explains('リポジトリを明示せず、remote の URL も解析できない場合の、`resolveRepository` のテストです。読み取れなかった理由を含む `UnreadableRemoteError` の例外が発生することを確認します。')
    const git = stepSync('偽の git を用意する', () => fakeGit({ remotes: ['origin'], remoteUrls: { origin: '/srv/git/bare.git' } }))
    stepSync('例外を確かめる', () => {
      expect(() => resolveRepository(undefined, git)).toThrow(UnreadableRemoteError)
      expect(() => resolveRepository(undefined, git)).toThrow('could not read the repository from the URL of the Git remote origin')
    })
  })

  it('明示した値の形式が不正なら、値が不正として例外が発生する', async () => {
    await explains('形式が不正な値を明示した場合の、`resolveRepository` のテストです。`InvalidValueError` の例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => resolveRepository('invalid', fakeGit())).toThrow(InvalidValueError)
    })
  })
})

describe('pickPrimaryRemote', () => {
  it.each([
    [['upstream', 'origin'], 'origin'],
    [['upstream', 'fork'], 'upstream'],
    [[], undefined],
  ])('remote が %j のとき、%j を選ぶ', async (remotes, expected) => {
    await explains('主に使う remote を選ぶ `pickPrimaryRemote` のテストです。`origin` があればそれを優先し、なければ先頭の remote を選び、remote が存在しなければ `undefined` を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(pickPrimaryRemote(remotes)).toBe(expected)
    })
  })
})

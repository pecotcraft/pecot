import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { step, stepSync } from '../../../tests/_helpers/step.js'

import { PecotError } from '../errors.js'
import type { GitResult, GitRunner } from '../git-runner.js'
import { InvalidVersionError } from '../changelog.js'
import { ReleaseError, runPreflight } from '../release.js'
import type { CountCommitsAhead, LookUpRemoteTag, PreflightOptions, PreflightResult } from '../release.js'

const SAMPLE_CHANGELOG = `# 変更履歴

## [Unreleased]

## [0.6.1] - 2026-02-20

### 追加

- 新機能A
- 新機能B

### 修正

- バグ修正

## [0.6.0] - 2026-02-15

### 追加

- 旧機能
`

interface Script {
  readonly git: GitRunner
  readonly lookUpRemoteTag: LookUpRemoteTag
  readonly calls: readonly (readonly string[])[]
}

/**
git のメモリ上の実装。呼ばれた順に results を返す。足りなければ失敗にする。remote のタグを尋ねるのも ls-remote の 1 回として数える
*/
function scriptedGit(results: readonly (string | GitResult)[]): Script {
  const calls: (readonly string[])[] = []
  const git: GitRunner = (arguments_) => {
    const next = results[calls.length]
    calls.push(arguments_)
    if (next === undefined) throw new Error(`想定外の git 呼び出し: ${arguments_.join(' ')}`)
    return typeof next === 'string' ? { exitCode: 0, stdout: next, stderr: '' } : next
  }
  const lookUpRemoteTag: LookUpRemoteTag = async (remote, tagName) => {
    await Promise.resolve()
    const result = git(['ls-remote', '--tags', remote, `refs/tags/${tagName}`])
    return result.exitCode === 0 ? { isFound: result.stdout.trim() !== '' } : { failure: result.stderr }
  }
  return { git, lookUpRemoteTag, calls }
}

async function preflight(preflightOptions: PreflightOptions, script: Readonly<Script>, countAhead: CountCommitsAhead): Promise<PreflightResult> {
  return await runPreflight(preflightOptions, script.git, script.lookUpRemoteTag, countAhead)
}

interface AheadScript {
  readonly countAhead: CountCommitsAhead
  readonly calls: readonly (readonly [string, string])[]
}

// GitHub の compare の代わり。呼ばれた (base, head) を記録して count を返す
function aheadBy(count: number): AheadScript {
  const calls: (readonly [string, string])[] = []
  const countAhead: CountCommitsAhead = async (base, head) => {
    calls.push([base, head])
    await Promise.resolve()
    return count
  }
  return { countAhead, calls }
}

// 差分を数える前に止まるケース用。呼ばれたら失敗にする
const neverCounted: CountCommitsAhead = async () => {
  await Promise.resolve()
  throw new Error('想定外の差分の数え上げ')
}

const failingCount: CountCommitsAhead = async () => {
  await Promise.resolve()
  throw new PecotError('compare failed')
}

function options(overrides: Partial<PreflightOptions> = {}): PreflightOptions {
  return {
    changelogPath: '/repo/CHANGELOG.md',
    changelogContent: SAMPLE_CHANGELOG,
    developBranch: 'develop-aist',
    releaseBranch: 'main',
    version: '0.6.1',
    tagPrefix: undefined,
    ...overrides,
  }
}

describe('ReleaseError', () => {
  it('PecotError を継承し、渡したメッセージを持つ', async () => {
    await explains('リリースの事前確認で使う例外 `ReleaseError` のテストです。`PecotError` のインスタンスとして、渡したメッセージを保持していることを確認します。')
    const error = stepSync('テスト用のエラーを用意する', () => new ReleaseError('テストエラー'))
    stepSync('結果を比べる', () => {
      expect(error).toBeInstanceOf(PecotError)
      expect(error.message).toBe('テストエラー')
    })
  })
})

describe('runPreflight', () => {
  it('バージョンを指定すると、版・リリースノート・ブランチ名・差分数・タグ名を返す', async () => {
    await explains('リリースの事前確認 `runPreflight` のテストです。バージョンを指定した場合に、CHANGELOG から取り出したリリースノートと、ブランチ名・差分数・タグ名を返し、ローカルと remote のタグを検索することを確認します。')
    const script = stepSync('偽の git を用意する', () => scriptedGit(['', '']))
    const ahead = stepSync('先行コミット数の偽を用意する', () => aheadBy(5))
    const result = await step('preflight を呼ぶ', async () => preflight(options(), script, ahead.countAhead))
    stepSync('結果を比べる', () => {
      expect(result).toStrictEqual({
        version: '0.6.1',
        releaseNotes: '### 追加\n\n- 新機能A\n- 新機能B\n\n### 修正\n\n- バグ修正',
        developBranch: 'develop-aist',
        releaseBranch: 'main',
        diffCount: 5,
        tagName: 'v0.6.1',
      })
      expect(script.calls).toStrictEqual([
        ['tag', '-l', 'v0.6.1'],
        ['ls-remote', '--tags', 'origin', 'refs/tags/v0.6.1'],
      ])
      expect(ahead.calls).toStrictEqual([['main', 'develop-aist']])
    })
  })

  it('差分は git の fetch や rev-list ではなく、渡した数え方で release から develop へ数える', async () => {
    await explains('差分の数え方のテストです。git の `fetch` や `rev-list` は呼ばず、渡した関数を使って、release ブランチから develop ブランチへの差分を数えることを確認します。')
    const script = stepSync('偽の git を用意する', () => scriptedGit(['', '']))
    const ahead = stepSync('先行コミット数の偽を用意する', () => aheadBy(1))
    await step('preflight を呼ぶ', async () => {
      await preflight(options({ releaseBranch: 'release', developBranch: 'develop' }), script, ahead.countAhead)
    })
    stepSync('結果を比べる', () => {
      expect(script.calls.map(call => call[0])).toStrictEqual(['tag', 'ls-remote'])
      expect(ahead.calls).toStrictEqual([['release', 'develop']])
    })
  })

  it('remote を渡すと、ls-remote とエラーメッセージにその remote を使う', async () => {
    await explains('`remote` を指定した場合のテストです。`upstream` を指定すると、`ls-remote` の呼び出しと、差分が 0 件のときのエラーメッセージで、その remote 名を使うことを確認します。')
    const script = stepSync('偽の git を用意する', () => scriptedGit(['', '']))
    await step('例外を確かめる', async () => {
      await expect(preflight(options({ remote: 'upstream' }), script, aheadBy(0).countAhead)).rejects.toThrow('no difference between upstream/main and upstream/develop-aist: there is nothing to release')
      expect(script.calls).toStrictEqual([
        ['tag', '-l', 'v0.6.1'],
        ['ls-remote', '--tags', 'upstream', 'refs/tags/v0.6.1'],
      ])
    })
  })

  it('バージョンを省略すると、CHANGELOG から検出する', async () => {
    await explains('バージョンを省略した場合のテストです。バージョンを渡さないとき、CHANGELOG の最新の版である `0.6.1` を検出して返すことを確認します。')
    const script = stepSync('偽の git を用意する', () => scriptedGit(['', '']))
    const result = await step('preflight を呼ぶ', async () => preflight(options({ version: undefined }), script, aheadBy(3).countAhead))
    stepSync('結果を比べる', () => {
      expect(result.version).toBe('0.6.1')
    })
  })

  it('CHANGELOG の内容が存在しなければ、git と差分の数え上げを呼ばずに ReleaseError を投げる', async () => {
    await explains('CHANGELOG の内容が存在しない場合のテストです。`ReleaseError` の例外が発生し、メッセージにファイルのパスが含まれ、git も差分の数え上げも呼ばないことを確認します。')
    const script = stepSync('偽の git を用意する', () => scriptedGit([]))
    await step('例外を確かめる', async () => {
      await expect(preflight(options({ changelogContent: undefined }), script, neverCounted)).rejects.toThrow(ReleaseError)
      await expect(preflight(options({ changelogContent: undefined }), script, neverCounted)).rejects.toThrow('CHANGELOG.md not found: /repo/CHANGELOG.md')
      expect(script.calls).toStrictEqual([])
    })
  })

  it('CHANGELOG の内容が存在しないときのメッセージは、実際のファイル名を使う', async () => {
    await explains('CHANGELOG の内容が存在しない場合のメッセージのテストです。ファイル名が `AIST-CHANGELOG.md` のとき、メッセージの中も固定の名前ではなく、実際のファイル名になることを確認します。')
    const missing = stepSync('確認の入力を用意する', () => options({ changelogPath: '/repo/AIST-CHANGELOG.md', changelogContent: undefined }))
    await step('例外を確かめる', async () => {
      await expect(preflight(missing, scriptedGit([]), neverCounted)).rejects.toThrow('AIST-CHANGELOG.md not found: /repo/AIST-CHANGELOG.md')
    })
  })

  it('バージョンが見つからないときのメッセージも、実際のファイル名を使う', async () => {
    await explains('バージョンが見つからない場合のメッセージのテストです。バージョンを検出できない場合と、指定した版が存在しない場合のどちらでも、実際のファイル名がメッセージに入ることを確認します。')
    const changelogPath = '/repo/AIST-CHANGELOG.md'
    const detect = stepSync('確認の入力を用意する', () => options({ changelogPath, version: undefined, changelogContent: '## [Unreleased]\n' }))
    await step('例外を確かめる', async () => {
      await expect(preflight(detect, scriptedGit([]), neverCounted)).rejects.toThrow('no version found in AIST-CHANGELOG.md')
    })
    const specified = stepSync('確認の入力を用意する', () => options({ changelogPath, version: '9.9.9' }))
    await step('例外を確かめる', async () => {
      await expect(preflight(specified, scriptedGit(['', '']), aheadBy(5).countAhead)).rejects.toThrow('version not found in AIST-CHANGELOG.md: 9.9.9')
    })
  })

  it('バージョンを省略して CHANGELOG にバージョンが存在しなければ、ReleaseError に包んで投げる', async () => {
    await explains('バージョンを省略した場合の例外のテストです。CHANGELOG に版が存在しないとき、`ReleaseError` の例外が発生し、メッセージが `no version found` になることを確認します。')
    const empty = stepSync('確認の入力を用意する', () => options({ version: undefined, changelogContent: '## [Unreleased]\n' }))
    await step('例外を確かめる', async () => {
      await expect(preflight(empty, scriptedGit([]), neverCounted)).rejects.toThrow(ReleaseError)
      await expect(preflight(empty, scriptedGit([]), neverCounted)).rejects.toThrow('no version found in CHANGELOG.md')
    })
  })

  it('指定したバージョンが X.Y.Z の形でなければ、InvalidVersionError を投げる', async () => {
    await explains('指定したバージョンの形式のテストです。`v0.6.1` のように `X.Y.Z` の形でない場合に、`ReleaseError` ではなく `InvalidVersionError` の例外が発生することを確認します。')
    await step('例外を確かめる', async () => {
      await expect(preflight(options({ version: 'v0.6.1' }), scriptedGit([]), neverCounted)).rejects.toThrow(InvalidVersionError)
    })
  })

  it('空文字列のバージョンは、省略とみなさず検証で失敗する', async () => {
    await explains('空文字列のバージョンのテストです。空文字列を省略とはみなさず、版の検証で `InvalidVersionError` の例外が発生することを確認します。')
    await step('例外を確かめる', async () => {
      await expect(preflight(options({ version: '' }), scriptedGit([]), neverCounted)).rejects.toThrow(InvalidVersionError)
    })
  })

  it('ローカルタグが既に存在すれば、ReleaseError を投げる', async () => {
    await explains('同じ名前のタグがローカルに存在する場合のテストです。`git tag -l` の出力に `v0.6.1` が含まれるとき、`ReleaseError` の例外が発生することを確認します。')
    await step('例外を確かめる', async () => {
      await expect(preflight(options(), scriptedGit(['v0.6.1']), neverCounted)).rejects.toThrow('tag already exists locally: v0.6.1')
    })
  })

  it('tag -l の出力は、行ごとに完全一致で比較する', async () => {
    await explains('`git tag -l` の出力の比較のテストです。`v0.6.1-rc1` や `v0.6.10` のように前方一致するだけのタグは同じタグとみなさず、事前確認が成功することを確認します。')
    const script = stepSync('偽の git を用意する', () => scriptedGit(['v0.6.1-rc1\nv0.6.10\n', '']))
    const result = await step('preflight を呼ぶ', async () => preflight(options(), script, aheadBy(1).countAhead))
    stepSync('結果を比べる', () => {
      expect(result.tagName).toBe('v0.6.1')
    })
  })

  it('ローカルタグが複数行の出力に含まれていても、検出する', async () => {
    await explains('複数のタグが出力される場合のテストです。`git tag -l` の出力が複数行で、その途中に `v0.6.1` がある場合も、既に存在するタグとして検出することを確認します。')
    await step('例外を確かめる', async () => {
      await expect(preflight(options(), scriptedGit(['v0.6.0\nv0.6.1\n']), neverCounted)).rejects.toThrow('tag already exists locally')
    })
  })

  it('リモートタグが既に存在すれば、ReleaseError を投げる', async () => {
    await explains('同じ名前のタグが remote に存在する場合のテストです。`git ls-remote` の出力にタグが含まれるとき、`ReleaseError` の例外が発生することを確認します。')
    await step('例外を確かめる', async () => {
      await expect(preflight(options(), scriptedGit(['', 'abc123\trefs/tags/v0.6.1']), neverCounted)).rejects.toThrow('tag already exists on the remote: v0.6.1')
    })
  })

  it('差分が 0 件なら、ReleaseError を投げる', async () => {
    await explains('リリースする差分が存在しない場合のテストです。差分の数が 0 件のとき、`ReleaseError` の例外が発生し、メッセージに比較した 2 つのブランチ名が含まれることを確認します。')
    await step('例外を確かめる', async () => {
      await expect(preflight(options(), scriptedGit(['', '']), aheadBy(0).countAhead)).rejects.toThrow('no difference between origin/main and origin/develop-aist: there is nothing to release')
    })
  })

  it('tagPrefix を指定しなければ、タグ名は v<ver> の形になる', async () => {
    await explains('`tagPrefix` を指定しない場合のテストです。タグ名が `v0.6.1` のように、`v` に版を続けた形になることを確認します。')
    const result = await step('preflight を呼ぶ', async () => await preflight(options(), scriptedGit(['', '']), aheadBy(5).countAhead))
    stepSync('結果を比べる', () => {
      expect(result.tagName).toBe('v0.6.1')
    })
  })

  it('tagPrefix を指定すると、タグ名は <prefix>-v<ver> の形になり、タグの検索にも prefix を使う', async () => {
    await explains('`tagPrefix` を指定した場合のテストです。タグ名が `pecot-workflow-v0.6.1` の形になり、ローカルと remote のタグの検索にも同じ名前を使うことを確認します。')
    const script = stepSync('偽の git を用意する', () => scriptedGit(['', '']))
    const result = await step('preflight を呼ぶ', async () => preflight(options({ tagPrefix: 'pecot-workflow' }), script, aheadBy(5).countAhead))
    stepSync('結果を比べる', () => {
      expect(result.tagName).toBe('pecot-workflow-v0.6.1')
      expect(script.calls[0]).toContain('pecot-workflow-v0.6.1')
      expect(script.calls[1]).toContain('refs/tags/pecot-workflow-v0.6.1')
    })
  })

  it('空文字列の tagPrefix は、prefix なしとして扱う（Python の if tag_prefix と同じ）', async () => {
    await explains('空文字列の `tagPrefix` のテストです。Python の `if tag_prefix` と同じように、prefix を指定しない場合として扱い、タグ名が `v0.6.1` になることを確認します。')
    const result = await step('preflight を呼ぶ', async () => await preflight(options({ tagPrefix: '' }), scriptedGit(['', '']), aheadBy(5).countAhead))
    stepSync('結果を比べる', () => {
      expect(result.tagName).toBe('v0.6.1')
    })
  })

  it('指定したバージョンが CHANGELOG に存在しなければ、ReleaseError に包んで投げる', async () => {
    await explains('指定したバージョンが CHANGELOG に存在しない場合のテストです。`ReleaseError` の例外が発生し、メッセージが `version not found` になることを確認します。')
    await step('例外を確かめる', async () => {
      await expect(preflight(options({ version: '9.9.9' }), scriptedGit(['', '']), aheadBy(5).countAhead)).rejects.toThrow(ReleaseError)
      await expect(preflight(options({ version: '9.9.9' }), scriptedGit(['', '']), aheadBy(5).countAhead)).rejects.toThrow('version not found in CHANGELOG.md: 9.9.9')
    })
  })

  it('git が 0 以外で終了したら、コマンドと標準エラーを含む ReleaseError を投げる', async () => {
    await explains('git の実行が失敗した場合のテストです。終了コードが 0 以外のとき、実行したコマンドと標準エラーの内容を含む `ReleaseError` の例外が発生することを確認します。')
    const script = stepSync('偽の git を用意する', () => scriptedGit(['', { exitCode: 128, stdout: '', stderr: '  fatal: no remote\n' }]))
    await step('例外を確かめる', async () => {
      await expect(preflight(options(), script, neverCounted)).rejects.toThrow('git command failed: git ls-remote --tags origin refs/tags/v0.6.1\nfatal: no remote')
    })
  })

  it('差分の数え上げが失敗したら、その例外をそのまま伝える', async () => {
    await explains('差分の数え上げが失敗した場合のテストです。数える関数が例外を投げたとき、`ReleaseError` に包まず、元のメッセージのまま例外が発生することを確認します。')
    await step('例外を確かめる', async () => {
      await expect(preflight(options(), scriptedGit(['', '']), failingCount)).rejects.toThrow('compare failed')
    })
  })
})

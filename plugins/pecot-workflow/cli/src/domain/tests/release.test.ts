import { describe, expect, it } from 'vitest'

import { PecotError } from '../errors.js'
import type { GitResult, GitRunner } from '../git-runner.js'
import { InvalidVersionError } from '../changelog.js'
import { ReleaseError, runPreflight } from '../release.js'
import type { CountCommitsAhead, PreflightOptions } from '../release.js'

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
  readonly calls: readonly (readonly string[])[]
}

/**
git のメモリ上の実装。呼ばれた順に results を返す。足りなければ失敗にする
*/
function scriptedGit(results: readonly (string | GitResult)[]): Script {
  const calls: (readonly string[])[] = []
  const git: GitRunner = (arguments_) => {
    const next = results[calls.length]
    calls.push(arguments_)
    if (next === undefined) throw new Error(`想定外の git 呼び出し: ${arguments_.join(' ')}`)
    return typeof next === 'string' ? { exitCode: 0, stdout: next, stderr: '' } : next
  }
  return { git, calls }
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
  it('PecotError であり、メッセージを持つ', () => {
    const error = new ReleaseError('テストエラー')
    expect(error).toBeInstanceOf(PecotError)
    expect(error.message).toBe('テストエラー')
  })
})

describe('runPreflight', () => {
  it('バージョンを指定すると、版・リリースノート・ブランチ名・差分数・タグ名を返す', async () => {
    const { git, calls } = scriptedGit(['', ''])
    const ahead = aheadBy(5)
    const result = await runPreflight(options(), git, ahead.countAhead)
    expect(result).toStrictEqual({
      version: '0.6.1',
      releaseNotes: '### 追加\n\n- 新機能A\n- 新機能B\n\n### 修正\n\n- バグ修正',
      developBranch: 'develop-aist',
      releaseBranch: 'main',
      diffCount: 5,
      tagName: 'v0.6.1',
    })
    expect(calls).toStrictEqual([
      ['tag', '-l', 'v0.6.1'],
      ['ls-remote', '--tags', 'origin', 'refs/tags/v0.6.1'],
    ])
    expect(ahead.calls).toStrictEqual([['main', 'develop-aist']])
  })

  it('差分は git の fetch・rev-list でなく、渡した数え方で release から develop へ数える', async () => {
    const { git, calls } = scriptedGit(['', ''])
    const ahead = aheadBy(1)
    await runPreflight(options({ releaseBranch: 'release', developBranch: 'develop' }), git, ahead.countAhead)
    expect(calls.map(call => call[0])).toStrictEqual(['tag', 'ls-remote'])
    expect(ahead.calls).toStrictEqual([['release', 'develop']])
  })

  it('remote を渡すと、ls-remote と誤りの文にその remote を使う', async () => {
    const { git, calls } = scriptedGit(['', ''])
    await expect(runPreflight(options({ remote: 'upstream' }), git, aheadBy(0).countAhead)).rejects.toThrow('no difference between upstream/main and upstream/develop-aist: there is nothing to release')
    expect(calls).toStrictEqual([
      ['tag', '-l', 'v0.6.1'],
      ['ls-remote', '--tags', 'upstream', 'refs/tags/v0.6.1'],
    ])
  })

  it('バージョン省略時は CHANGELOG から検出する', async () => {
    const { git } = scriptedGit(['', ''])
    const result = await runPreflight(options({ version: undefined }), git, aheadBy(3).countAhead)
    expect(result.version).toBe('0.6.1')
  })

  it('CHANGELOG の内容が無ければ ReleaseError（git と差分の数え上げを呼ばない）', async () => {
    const { git, calls } = scriptedGit([])
    await expect(runPreflight(options({ changelogContent: undefined }), git, neverCounted)).rejects.toThrow(ReleaseError)
    await expect(runPreflight(options({ changelogContent: undefined }), git, neverCounted)).rejects.toThrow('CHANGELOG.md not found: /repo/CHANGELOG.md')
    expect(calls).toStrictEqual([])
  })

  it('CHANGELOG の内容が無いときの文は、実際のファイル名を使う', async () => {
    const missing = options({ changelogPath: '/repo/AIST-CHANGELOG.md', changelogContent: undefined })
    await expect(runPreflight(missing, scriptedGit([]).git, neverCounted)).rejects.toThrow('AIST-CHANGELOG.md not found: /repo/AIST-CHANGELOG.md')
  })

  it('バージョンが無いときの文も、実際のファイル名を使う', async () => {
    const changelogPath = '/repo/AIST-CHANGELOG.md'
    const detect = options({ changelogPath, version: undefined, changelogContent: '## [Unreleased]\n' })
    await expect(runPreflight(detect, scriptedGit([]).git, neverCounted)).rejects.toThrow('no version found in AIST-CHANGELOG.md')
    const specified = options({ changelogPath, version: '9.9.9' })
    await expect(runPreflight(specified, scriptedGit(['', '']).git, aheadBy(5).countAhead)).rejects.toThrow('version not found in AIST-CHANGELOG.md: 9.9.9')
  })

  it('バージョン省略で CHANGELOG にバージョンが無ければ ReleaseError に包む', async () => {
    const empty = options({ version: undefined, changelogContent: '## [Unreleased]\n' })
    await expect(runPreflight(empty, scriptedGit([]).git, neverCounted)).rejects.toThrow(ReleaseError)
    await expect(runPreflight(empty, scriptedGit([]).git, neverCounted)).rejects.toThrow('no version found in CHANGELOG.md')
  })

  it('指定バージョンが X.Y.Z でなければ InvalidVersionError（ReleaseError ではない）', async () => {
    await expect(runPreflight(options({ version: 'v0.6.1' }), scriptedGit([]).git, neverCounted)).rejects.toThrow(InvalidVersionError)
  })

  it('空文字列のバージョンは省略扱いにしない（検証で落ちる）', async () => {
    await expect(runPreflight(options({ version: '' }), scriptedGit([]).git, neverCounted)).rejects.toThrow(InvalidVersionError)
  })

  it('ローカルタグが既にあれば ReleaseError', async () => {
    await expect(runPreflight(options(), scriptedGit(['v0.6.1']).git, neverCounted)).rejects.toThrow('tag already exists locally: v0.6.1')
  })

  it('tag -l の出力は行ごとに完全一致で比べる', async () => {
    const { git } = scriptedGit(['v0.6.1-rc1\nv0.6.10\n', ''])
    const result = await runPreflight(options(), git, aheadBy(1).countAhead)
    expect(result.tagName).toBe('v0.6.1')
  })

  it('ローカルタグが複数行の中にあっても検出する', async () => {
    await expect(runPreflight(options(), scriptedGit(['v0.6.0\nv0.6.1\n']).git, neverCounted)).rejects.toThrow('tag already exists locally')
  })

  it('リモートタグが既にあれば ReleaseError', async () => {
    await expect(runPreflight(options(), scriptedGit(['', 'abc123\trefs/tags/v0.6.1']).git, neverCounted)).rejects.toThrow('tag already exists on the remote: v0.6.1')
  })

  it('差分が 0 件なら ReleaseError', async () => {
    await expect(runPreflight(options(), scriptedGit(['', '']).git, aheadBy(0).countAhead)).rejects.toThrow('no difference between origin/main and origin/develop-aist: there is nothing to release')
  })

  it('tagPrefix なしの tagName は v<ver>', async () => {
    const result = await runPreflight(options(), scriptedGit(['', '']).git, aheadBy(5).countAhead)
    expect(result.tagName).toBe('v0.6.1')
  })

  it('tagPrefix 指定時の tagName は <prefix>-v<ver>。タグ検索も prefix 付きで行う', async () => {
    const { git, calls } = scriptedGit(['', ''])
    const result = await runPreflight(options({ tagPrefix: 'pecot-workflow' }), git, aheadBy(5).countAhead)
    expect(result.tagName).toBe('pecot-workflow-v0.6.1')
    expect(calls[0]).toContain('pecot-workflow-v0.6.1')
    expect(calls[1]).toContain('refs/tags/pecot-workflow-v0.6.1')
  })

  it('空文字列の tagPrefix は prefix なし扱い（Python の if tag_prefix と同じ）', async () => {
    const result = await runPreflight(options({ tagPrefix: '' }), scriptedGit(['', '']).git, aheadBy(5).countAhead)
    expect(result.tagName).toBe('v0.6.1')
  })

  it('指定バージョンが CHANGELOG に無ければ ReleaseError に包む', async () => {
    await expect(runPreflight(options({ version: '9.9.9' }), scriptedGit(['', '']).git, aheadBy(5).countAhead)).rejects.toThrow(ReleaseError)
    await expect(runPreflight(options({ version: '9.9.9' }), scriptedGit(['', '']).git, aheadBy(5).countAhead)).rejects.toThrow('version not found in CHANGELOG.md: 9.9.9')
  })

  it('git が非 0 で終わったら、コマンドと標準エラーを含む ReleaseError', async () => {
    const { git } = scriptedGit(['', { exitCode: 128, stdout: '', stderr: '  fatal: no remote\n' }])
    await expect(runPreflight(options(), git, neverCounted)).rejects.toThrow('git command failed: git ls-remote --tags origin refs/tags/v0.6.1\nfatal: no remote')
  })

  it('差分の数え上げの失敗は、そのまま伝える', async () => {
    await expect(runPreflight(options(), scriptedGit(['', '']).git, failingCount)).rejects.toThrow('compare failed')
  })
})

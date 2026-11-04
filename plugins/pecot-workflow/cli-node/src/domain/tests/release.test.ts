import { describe, expect, it } from 'vitest'

import { PecotError, InvalidValueError } from '../errors.js'
import type { GitResult, GitRunner } from '../git-runner.js'
import { InvalidVersionError } from '../changelog.js'
import { ReleaseError, runPreflight } from '../release.js'
import type { PreflightOptions } from '../release.js'

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
  it('バージョン指定での正常実行', () => {
    const { git, calls } = scriptedGit(['', '', '', '5\n'])
    const result = runPreflight(options(), git)
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
      ['fetch', 'origin', 'main', 'develop-aist'],
      ['rev-list', '--count', 'origin/main..origin/develop-aist'],
    ])
  })

  it('バージョン省略時は CHANGELOG から検出する', () => {
    const { git } = scriptedGit(['', '', '', '3'])
    expect(runPreflight(options({ version: undefined }), git).version).toBe('0.6.1')
  })

  it('CHANGELOG の内容が無ければ ReleaseError（git は呼ばない）', () => {
    const { git, calls } = scriptedGit([])
    expect(() => runPreflight(options({ changelogContent: undefined }), git)).toThrow(ReleaseError)
    expect(() => runPreflight(options({ changelogContent: undefined }), git)).toThrow('CHANGELOG.mdが見つかりません: /repo/CHANGELOG.md')
    expect(calls).toStrictEqual([])
  })

  it('CHANGELOG の内容が無いときの文は、実際のファイル名を使う', () => {
    const { git } = scriptedGit([])
    const missing = options({ changelogPath: '/repo/AIST-CHANGELOG.md', changelogContent: undefined })
    expect(() => runPreflight(missing, git)).toThrow('AIST-CHANGELOG.mdが見つかりません: /repo/AIST-CHANGELOG.md')
  })

  it('バージョンが無いときの文も、実際のファイル名を使う', () => {
    const changelogPath = '/repo/AIST-CHANGELOG.md'
    const detect = options({ changelogPath, version: undefined, changelogContent: '## [Unreleased]\n' })
    expect(() => runPreflight(detect, scriptedGit([]).git)).toThrow('AIST-CHANGELOG.mdにバージョンが見つかりません')
    const specified = options({ changelogPath, version: '9.9.9' })
    expect(() => runPreflight(specified, scriptedGit(['', '', '', '5']).git)).toThrow('バージョン 9.9.9 がAIST-CHANGELOG.mdに見つかりません')
  })

  it('バージョン省略で CHANGELOG にバージョンが無ければ ReleaseError に包む', () => {
    const { git } = scriptedGit([])
    expect(() => runPreflight(options({ version: undefined, changelogContent: '## [Unreleased]\n' }), git)).toThrow(ReleaseError)
    expect(() => runPreflight(options({ version: undefined, changelogContent: '## [Unreleased]\n' }), git)).toThrow('CHANGELOG.mdにバージョンが見つかりません')
  })

  it('指定バージョンが X.Y.Z でなければ InvalidVersionError（ReleaseError ではない）', () => {
    const { git } = scriptedGit([])
    expect(() => runPreflight(options({ version: 'v0.6.1' }), git)).toThrow(InvalidVersionError)
  })

  it('空文字列のバージョンは省略扱いにしない（検証で落ちる）', () => {
    const { git } = scriptedGit([])
    expect(() => runPreflight(options({ version: '' }), git)).toThrow(InvalidVersionError)
  })

  it('ローカルタグが既にあれば ReleaseError', () => {
    const { git } = scriptedGit(['v0.6.1'])
    expect(() => runPreflight(options(), git)).toThrow('タグ v0.6.1 はローカルに既に存在します')
  })

  it('tag -l の出力は行ごとに完全一致で比べる', () => {
    const { git } = scriptedGit(['v0.6.1-rc1\nv0.6.10\n', '', '', '1'])
    expect(runPreflight(options(), git).tagName).toBe('v0.6.1')
  })

  it('ローカルタグが複数行の中にあっても検出する', () => {
    const { git } = scriptedGit(['v0.6.0\nv0.6.1\n'])
    expect(() => runPreflight(options(), git)).toThrow('ローカルに既に存在します')
  })

  it('リモートタグが既にあれば ReleaseError', () => {
    const { git } = scriptedGit(['', 'abc123\trefs/tags/v0.6.1'])
    expect(() => runPreflight(options(), git)).toThrow('タグ v0.6.1 はリモートに既に存在します')
  })

  it('差分が 0 件なら ReleaseError', () => {
    const { git } = scriptedGit(['', '', '', '0'])
    expect(() => runPreflight(options(), git)).toThrow('origin/main と origin/develop-aist に差分がありません。リリースする変更がありません。')
  })

  it('tagPrefix なしの tagName は v<ver>', () => {
    const { git } = scriptedGit(['', '', '', '5'])
    expect(runPreflight(options(), git).tagName).toBe('v0.6.1')
  })

  it('tagPrefix 指定時の tagName は <prefix>-v<ver>。タグ検索も prefix 付きで行う', () => {
    const { git, calls } = scriptedGit(['', '', '', '5'])
    const result = runPreflight(options({ tagPrefix: 'pecot-workflow' }), git)
    expect(result.tagName).toBe('pecot-workflow-v0.6.1')
    expect(calls[0]).toContain('pecot-workflow-v0.6.1')
    expect(calls[1]).toContain('refs/tags/pecot-workflow-v0.6.1')
  })

  it('空文字列の tagPrefix は prefix なし扱い（Python の if tag_prefix と同じ）', () => {
    const { git } = scriptedGit(['', '', '', '5'])
    expect(runPreflight(options({ tagPrefix: '' }), git).tagName).toBe('v0.6.1')
  })

  it('指定バージョンが CHANGELOG に無ければ ReleaseError に包む', () => {
    const { git } = scriptedGit(['', '', '', '5'])
    expect(() => runPreflight(options({ version: '9.9.9' }), git)).toThrow(ReleaseError)
    expect(() => runPreflight(options({ version: '9.9.9' }), scriptedGit(['', '', '', '5']).git)).toThrow('バージョン 9.9.9 がCHANGELOG.mdに見つかりません')
  })

  it('git が非 0 で終わったら、コマンドと標準エラーを含む ReleaseError', () => {
    const { git } = scriptedGit(['', { exitCode: 128, stdout: '', stderr: '  fatal: no remote\n' }])
    expect(() => runPreflight(options(), git)).toThrow('git コマンド失敗: git ls-remote --tags origin refs/tags/v0.6.1\nfatal: no remote')
  })

  it('rev-list の出力が整数でなければ Python の int() と同じ文の InvalidValueError', () => {
    const { git } = scriptedGit(['', '', '', 'many'])
    expect(() => runPreflight(options(), git)).toThrow(InvalidValueError)
    expect(() => runPreflight(options(), scriptedGit(['', '', '', 'many']).git)).toThrow('invalid literal for int() with base 10: \'many\'')
  })

  it('rev-list の出力の前後の空白は落とす', () => {
    const { git } = scriptedGit(['  \n', ' \n', '', ' 12 \n'])
    expect(runPreflight(options(), git).diffCount).toBe(12)
  })
})

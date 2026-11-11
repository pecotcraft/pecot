import { describe, expect, it } from 'vitest'

import {
  CHANGELOG_FALLBACK_FILES,
  ChangelogError,
  ChangelogFileNotFoundError,
  changelogNotFoundMessage,
  DEFAULT_CHANGELOG_FILE,
  extractVersionReleaseNotes,
  getLatestVersion,
  InvalidVersionError,
  validateSemver,
  VersionNotFoundError,
} from '../changelog.js'
import { PecotError } from '../errors.js'

describe('例外クラス', () => {
  it('ChangelogError は PecotError であり、メッセージを持つ', () => {
    const error = new ChangelogError('テストエラー')
    expect(error).toBeInstanceOf(PecotError)
    expect(error.message).toBe('テストエラー')
  })

  it('InvalidVersionError は ChangelogError を継承する', () => {
    expect(new InvalidVersionError('無効なバージョン')).toBeInstanceOf(ChangelogError)
  })

  it('VersionNotFoundError は ChangelogError を継承する', () => {
    expect(new VersionNotFoundError('バージョンが見つかりません')).toBeInstanceOf(ChangelogError)
  })

  it('ChangelogFileNotFoundError は PecotError ではない（Python の FileNotFoundError に当たる）', () => {
    const error = new ChangelogFileNotFoundError('x')
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PecotError)
  })
})

describe('validateSemver', () => {
  it.each(['0.3.2', '1.0.0', '10.20.30'])('有効なバージョン形式 %s', (version) => {
    expect(() => {
      validateSemver(version)
    }).not.toThrow()
  })

  it.each(['v0.3.2', '0.3', 'abc', '1.2.3.4'])('無効なバージョン形式 %s', (version) => {
    expect(() => {
      validateSemver(version)
    }).toThrow(InvalidVersionError)
  })

  it('エラー文は版と案内を含む', () => {
    expect(() => {
      validateSemver('v1.2.3')
    }).toThrow('invalid version format: v1.2.3\nuse semantic versioning (X.Y.Z)')
  })

  // Python の `^\d+\.\d+\.\d+$` と同じ判定（`$` は末尾の改行の前でも合う。\d は Unicode の 10 進数字）
  it('末尾の改行 1 つは受ける', () => {
    expect(() => {
      validateSemver('1.2.3\n')
    }).not.toThrow()
  })

  it('末尾の改行 2 つは受けない', () => {
    expect(() => {
      validateSemver('1.2.3\n\n')
    }).toThrow(InvalidVersionError)
  })

  it('全角数字を受ける', () => {
    expect(() => {
      validateSemver('１.２.３')
    }).not.toThrow()
  })
})

describe('getLatestVersion', () => {
  it('最初の ## [X.Y.Z] を返す（Unreleased は飛ばす）', () => {
    const content = `# 変更履歴

## [Unreleased]

## [0.3.1] - 2026-01-19

### 追加

- 新機能

## [0.3.0] - 2026-01-18
`
    expect(getLatestVersion(content)).toBe('0.3.1')
  })

  it('バージョンが無ければ VersionNotFoundError', () => {
    const content = `# 変更履歴

## [Unreleased]

最初のリリース前
`
    expect(() => getLatestVersion(content)).toThrow(VersionNotFoundError)
    expect(() => getLatestVersion(content)).toThrow('no version found in CHANGELOG.md\nfor a first release, specify the version manually')
  })

  it('見出し記号とバージョンの間は空白 1 つ以上', () => {
    expect(getLatestVersion('##\t[1.2.3]')).toBe('1.2.3')
    expect(() => getLatestVersion('##[1.2.3]')).toThrow(VersionNotFoundError)
  })

  // 期待値は Python の get_latest_version の実出力
  it.each(['\u{3000}', '\u{1F}', '\u{A0}'])('見出し記号とバージョンの間の空白 %j は Python の \\s と同じく空白', (separator) => {
    expect(getLatestVersion(`##${separator}[1.2.3]`)).toBe('1.2.3')
  })

  it('見出し記号とバージョンの間の U+FEFF は Python の \\s と同じく空白ではない', () => {
    expect(() => getLatestVersion('##\u{FEFF}[1.2.3]')).toThrow(VersionNotFoundError)
  })

  it('全角数字のバージョンも拾う', () => {
    expect(getLatestVersion('## [１.２.３]')).toBe('１.２.３')
  })

  it('U+0085 も行の区切り', () => {
    expect(getLatestVersion('a\u{85}## [1.0.0]')).toBe('1.0.0')
  })

  it('行頭以外の ## は見ない', () => {
    expect(() => getLatestVersion(' ## [1.2.3]')).toThrow(VersionNotFoundError)
  })
})

describe('extractVersionReleaseNotes', () => {
  const content = `# 変更履歴

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

  it('存在するバージョンのリリースノートを抽出する', () => {
    expect(extractVersionReleaseNotes(content, '0.6.1')).toBe('### 追加\n\n- 新機能A\n- 新機能B\n\n### 修正\n\n- バグ修正')
  })

  it('古いバージョンのリリースノートを抽出する', () => {
    const notes = extractVersionReleaseNotes(content, '0.6.0')
    expect(notes).toContain('- 旧機能')
    expect(notes).not.toContain('- 新機能')
  })

  it('存在しないバージョンは VersionNotFoundError（バージョンを文に含む）', () => {
    expect(() => extractVersionReleaseNotes(content, '9.9.9')).toThrow(VersionNotFoundError)
    expect(() => extractVersionReleaseNotes(content, '9.9.9')).toThrow('version not found in CHANGELOG.md: 9.9.9')
  })

  it('空のリリースノートは空文字列', () => {
    expect(extractVersionReleaseNotes('# 変更履歴\n\n## [0.6.1] - 2026-02-20\n\n## [0.6.0] - 2026-02-15\n', '0.6.1')).toBe('')
  })

  it('最後のバージョン（後続セクションなし）', () => {
    expect(extractVersionReleaseNotes('# 変更履歴\n\n## [0.1.0] - 2026-01-01\n\n### 追加\n\n- 初回リリース\n', '0.1.0')).toContain('- 初回リリース')
  })

  it('### は次のセクションにならない', () => {
    expect(extractVersionReleaseNotes('## [1.0.0]\n### a\n## [0.9.0]\n', '1.0.0')).toBe('### a')
  })

  it('バージョンの `.` は正規表現として扱わない', () => {
    expect(() => extractVersionReleaseNotes('## [0x6x1]\nbody\n', '0.6.1')).toThrow(VersionNotFoundError)
  })

  it('splitlines と同じ区切りで行に分ける（U+2028 も改行）', () => {
    expect(extractVersionReleaseNotes('## [1.0.0]\u{2028}a\u{2028}## [0.9.0]\nb', '1.0.0')).toBe('a')
  })

  it('前後の空白は落とす', () => {
    expect(extractVersionReleaseNotes('## [1.0.0]\n\n\n  x  \n\n## [0.9.0]', '1.0.0')).toBe('x')
  })
})

describe('ファイル名を渡したときの文', () => {
  it('getLatestVersion のバージョン無しの文は、渡したファイル名を使う', () => {
    expect(() => getLatestVersion('## [Unreleased]', 'AIST-CHANGELOG.md')).toThrow('no version found in AIST-CHANGELOG.md\nfor a first release, specify the version manually')
  })

  it('extractVersionReleaseNotes のバージョン無しの文は、渡したファイル名を使う', () => {
    expect(() => extractVersionReleaseNotes('## [0.6.0]', '9.9.9', 'AIST-CHANGELOG.md')).toThrow('version not found in AIST-CHANGELOG.md: 9.9.9')
  })
})

describe('changelogNotFoundMessage', () => {
  it.each([
    ['/repo/CHANGELOG.md', 'CHANGELOG.md not found: /repo/CHANGELOG.md'],
    ['/repo/AIST-CHANGELOG.md', 'AIST-CHANGELOG.md not found: /repo/AIST-CHANGELOG.md'],
    ['docs/CUSTOM.md', 'CUSTOM.md not found: docs/CUSTOM.md'],
    ['CHANGELOG.md', 'CHANGELOG.md not found: CHANGELOG.md'],
  ])('パスが %s のとき、ファイル名つきの見つからない文を返す', (changelogPath, expected) => {
    expect(changelogNotFoundMessage(changelogPath)).toBe(expected)
  })
})

describe('定数', () => {
  it('値と整合性', () => {
    expect(DEFAULT_CHANGELOG_FILE).toBe('CHANGELOG.md')
    expect(CHANGELOG_FALLBACK_FILES).toContain('CHANGELOG.md')
    expect(CHANGELOG_FALLBACK_FILES).toContain('AIST-CHANGELOG.md')
    expect(CHANGELOG_FALLBACK_FILES[0]).toBe(DEFAULT_CHANGELOG_FILE)
    expect(new Set(CHANGELOG_FALLBACK_FILES).size).toBe(CHANGELOG_FALLBACK_FILES.length)
  })
})

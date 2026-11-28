import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { CHANGELOG_FALLBACK_FILES, ChangelogError, changelogNotFoundMessage, DEFAULT_CHANGELOG_FILE, extractVersionReleaseNotes, getLatestVersion, InvalidVersionError, validateSemver, VersionNotFoundError } from '../changelog.js'
import { PecotError } from '../errors.js'

describe('例外クラス', () => {
  it('ChangelogError は PecotError の一種で、渡したメッセージを持つ', async () => {
    await explains('変更履歴の例外クラス（`ChangelogError`）のテストです。`PecotError` のインスタンスであり、渡したメッセージを保持することを確認します。')
    const error = stepSync('`ChangelogError` を作る', () => new ChangelogError('テストエラー'))

    stepSync('結果を比べる', () => {
      expect(error).toBeInstanceOf(PecotError)
      expect(error.message).toBe('テストエラー')
    })
  })

  it('InvalidVersionError は ChangelogError を継承している', async () => {
    await explains('バージョンの形式が不正なときの例外クラス（`InvalidVersionError`）のテストです。`ChangelogError` のインスタンスであることを確認します。')
    stepSync('結果を比べる', () => {
      expect(new InvalidVersionError('無効なバージョン')).toBeInstanceOf(ChangelogError)
    })
  })

  it('VersionNotFoundError は ChangelogError を継承している', async () => {
    await explains('バージョンが存在しないときの例外クラス（`VersionNotFoundError`）のテストです。`ChangelogError` のインスタンスであることを確認します。')
    stepSync('結果を比べる', () => {
      expect(new VersionNotFoundError('バージョンが見つかりません')).toBeInstanceOf(ChangelogError)
    })
  })
})

describe('validateSemver', () => {
  it.each(['0.3.2', '1.0.0', '10.20.30'])('バージョンが %s の場合は、検証を通す', async (version) => {
    await explains('バージョンの形式を検証する関数（`validateSemver`）のテストです。`X.Y.Z` の形式のバージョンの場合に、例外を投げないことを確認します。')
    stepSync('`validateSemver` を呼び、結果を比べる', () => {
      expect(() => {
        validateSemver(version)
      }).not.toThrow()
    })
  })

  it.each(['v0.3.2', '0.3', 'abc', '1.2.3.4'])('バージョンが %s の場合は、InvalidVersionError を投げる', async (version) => {
    await explains('バージョンの形式を検証する関数（`validateSemver`）のテストです。先頭に `v` が付く場合や、要素の数が不足している場合など、`X.Y.Z` の形式ではないときに、`InvalidVersionError` の例外が発生することを確認します。')
    stepSync('`validateSemver` を呼び、結果を比べる', () => {
      expect(() => {
        validateSemver(version)
      }).toThrow(InvalidVersionError)
    })
  })

  it('エラーのメッセージには、バージョンと案内を含める', async () => {
    await explains('`X.Y.Z` の形式ではないバージョン（`v1.2.3`）を検証した場合のテストです。エラーのメッセージに、指定したバージョンと、セマンティックバージョニングを使う案内が含まれることを確認します。')
    stepSync('`validateSemver` を呼び、結果を比べる', () => {
      expect(() => {
        validateSemver('v1.2.3')
      }).toThrow('invalid version format: v1.2.3\nuse semantic versioning (X.Y.Z)')
    })
  })

  // Python の `^\d+\.\d+\.\d+$` と同じ判定（`$` は末尾の改行の前でも合う。\d は Unicode の 10 進数字）
  it('末尾に改行が 1 つ付いたバージョンは、受け付ける', async () => {
    await explains('末尾に改行が 1 つ付いたバージョン（`1.2.3\\n`）を検証した場合のテストです。Python の正規表現（`^\\d+\\.\\d+\\.\\d+$`）と同じく、例外を投げないことを確認します。')
    stepSync('`validateSemver` を呼び、結果を比べる', () => {
      expect(() => {
        validateSemver('1.2.3\n')
      }).not.toThrow()
    })
  })

  it('末尾に改行が 2 つ付いたバージョンは、受け付けない', async () => {
    await explains('末尾に改行が 2 つ付いたバージョン（`1.2.3\\n\\n`）を検証した場合のテストです。Python の正規表現と同じく、`InvalidVersionError` を投げることを確認します。')
    stepSync('`validateSemver` を呼び、結果を比べる', () => {
      expect(() => {
        validateSemver('1.2.3\n\n')
      }).toThrow(InvalidVersionError)
    })
  })

  it('全角数字のバージョンは、受け付ける', async () => {
    await explains('全角数字のバージョン（`１.２.３`）を検証した場合のテストです。Python の `\\d` が Unicode の 10 進数字に一致することと同じく、例外を投げないことを確認します。')
    stepSync('`validateSemver` を呼び、結果を比べる', () => {
      expect(() => {
        validateSemver('１.２.３')
      }).not.toThrow()
    })
  })
})

describe('getLatestVersion', () => {
  it('最初の ## [X.Y.Z] の見出しのバージョンを返し、Unreleased は読み飛ばす', async () => {
    await explains('変更履歴の最新のバージョンを求める関数（`getLatestVersion`）のテストです。`Unreleased` の見出しを読み飛ばし、最初に現れる `## [X.Y.Z]` の見出しのバージョン（`0.3.1`）を返すことを確認します。')
    const content = stepSync('入力を用意する', () => `# 変更履歴

## [Unreleased]

## [0.3.1] - 2026-01-19

### 追加

- 新機能

## [0.3.0] - 2026-01-18
`)

    stepSync('結果を比べる', () => {
      expect(getLatestVersion(content)).toBe('0.3.1')
    })
  })

  it('バージョンの見出しが存在しない場合は、VersionNotFoundError を投げる', async () => {
    await explains('`Unreleased` の見出ししかない変更履歴のテストです。`VersionNotFoundError` を投げ、最初のリリースでは手で指定するよう案内するメッセージを含めることを確認します。')
    const content = stepSync('入力を用意する', () => `# 変更履歴

## [Unreleased]

最初のリリース前
`)

    stepSync('結果を比べる', () => {
      expect(() => getLatestVersion(content)).toThrow(VersionNotFoundError)
      expect(() => getLatestVersion(content)).toThrow('no version found in CHANGELOG.md\nfor a first release, specify the version manually')
    })
  })

  it('見出し記号とバージョンの間に、空白が 1 つ以上ある場合だけ、バージョンとして読み取る', async () => {
    await explains('見出し記号（`##`）とバージョンの間の空白のテストです。タブが 1 つある場合はバージョンを返し、空白が存在しない場合は `VersionNotFoundError` を投げることを確認します。')
    stepSync('`getLatestVersion` を呼び、結果を比べる', () => {
      expect(getLatestVersion('##\t[1.2.3]')).toBe('1.2.3')
      expect(() => getLatestVersion('##[1.2.3]')).toThrow(VersionNotFoundError)
    })
  })

  // 期待値は Python の get_latest_version の実出力
  it.each(['\u{3000}', '\u{1F}', '\u{A0}'])('見出し記号とバージョンの間の %j は、Python の \\s と同じく空白として扱う', async (separator) => {
    await explains('見出し記号とバージョンの間に、全角空白などの文字が入る場合のテストです。Python の `\\s` と同じく空白として扱い、バージョンを返すことを確認します。')
    stepSync('`getLatestVersion` を呼び、結果を比べる', () => {
      expect(getLatestVersion(`##${separator}[1.2.3]`)).toBe('1.2.3')
    })
  })

  it('見出し記号とバージョンの間の U+FEFF は、Python の \\s と同じく空白として扱わない', async () => {
    await explains('見出し記号の後ろに `U+FEFF` が入る場合のテストです。Python の `\\s` では空白に当たらないため、`VersionNotFoundError` を投げることを確認します。')
    stepSync('`getLatestVersion` を呼び、結果を比べる', () => {
      expect(() => getLatestVersion('##\u{FEFF}[1.2.3]')).toThrow(VersionNotFoundError)
    })
  })

  it('全角数字のバージョンも、変更履歴から読み取る', async () => {
    await explains('見出しのバージョンが全角数字（`１.２.３`）の場合のテストです。全角数字のまま、そのバージョンを返すことを確認します。')
    stepSync('`getLatestVersion` を呼び、結果を比べる', () => {
      expect(getLatestVersion('## [１.２.３]')).toBe('１.２.３')
    })
  })

  it('U+0085 も、行の区切りとして扱う', async () => {
    await explains('`U+0085`（次行）の直後に見出しが続く場合のテストです。Python の `splitlines` と同じく行の区切りとして扱い、見出しのバージョン（`1.0.0`）を返すことを確認します。')
    stepSync('`getLatestVersion` を呼び、結果を比べる', () => {
      expect(getLatestVersion('a\u{85}## [1.0.0]')).toBe('1.0.0')
    })
  })

  it('行頭にない ## は、見出しとして扱わない', async () => {
    await explains('`##` の前に空白がある場合のテストです。行頭の見出しではないため、`VersionNotFoundError` を投げることを確認します。')
    stepSync('`getLatestVersion` を呼び、結果を比べる', () => {
      expect(() => getLatestVersion(' ## [1.2.3]')).toThrow(VersionNotFoundError)
    })
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

  it('存在するバージョンのリリースノートを抽出する', async () => {
    await explains('指定したバージョンのリリースノートを抽出する関数（`extractVersionReleaseNotes`）のテストです。`0.6.1` を指定した場合に、その見出しの次から、次のバージョンの見出しの手前までの本文を返すことを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '0.6.1')).toBe('### 追加\n\n- 新機能A\n- 新機能B\n\n### 修正\n\n- バグ修正')
    })
  })

  it('古いバージョンのリリースノートも抽出する', async () => {
    await explains('最新ではない古いバージョン（`0.6.0`）を指定した場合のテストです。そのバージョンの本文を返し、新しいバージョンの本文は含まないことを確認します。')
    const notes = stepSync('`extractVersionReleaseNotes` を呼ぶ', () => extractVersionReleaseNotes(content, '0.6.0'))

    stepSync('結果を比べる', () => {
      expect(notes).toContain('- 旧機能')
      expect(notes).not.toContain('- 新機能')
    })
  })

  it('存在しないバージョンを指定した場合は、バージョンを含めた VersionNotFoundError を投げる', async () => {
    await explains('変更履歴に存在しないバージョン（`9.9.9`）を指定した場合のテストです。`VersionNotFoundError` を投げ、メッセージに指定したバージョンが含まれることを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(() => extractVersionReleaseNotes(content, '9.9.9')).toThrow(VersionNotFoundError)
      expect(() => extractVersionReleaseNotes(content, '9.9.9')).toThrow('version not found in CHANGELOG.md: 9.9.9')
    })
  })

  it('リリースノートの本文が空の場合は、空文字列を返す', async () => {
    await explains('見出しの直後に、次のバージョンの見出しが続く変更履歴のテストです。本文が存在しないため、空文字列を返すことを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes('# 変更履歴\n\n## [0.6.1] - 2026-02-20\n\n## [0.6.0] - 2026-02-15\n', '0.6.1')).toBe('')
    })
  })

  it('最後のバージョンの場合は、後続の見出しが存在しないため、末尾までを本文として返す', async () => {
    await explains('変更履歴の最後のバージョンを指定した場合のテストです。後続の見出しが存在しないため、ファイルの末尾までを本文として返すことを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes('# 変更履歴\n\n## [0.1.0] - 2026-01-01\n\n### 追加\n\n- 初回リリース\n', '0.1.0')).toContain('- 初回リリース')
    })
  })

  it('### の見出しは、次のバージョンの区切りとして扱わない', async () => {
    await explains('バージョンの本文に `###` の見出しがある場合のテストです。`###` は次のバージョンの見出しではないため、本文に含めて返すことを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes('## [1.0.0]\n### a\n## [0.9.0]\n', '1.0.0')).toBe('### a')
    })
  })

  it('バージョンの `.` は、正規表現の任意の 1 文字として扱わない', async () => {
    await explains('バージョン（`0.6.1`）の `.` が、任意の 1 文字に一致しないことのテストです。`0x6x1` の見出しには一致せず、`VersionNotFoundError` を投げることを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(() => extractVersionReleaseNotes('## [0x6x1]\nbody\n', '0.6.1')).toThrow(VersionNotFoundError)
    })
  })

  it('Python の splitlines と同じ区切りで行に分ける（U+2028 も改行として扱う）', async () => {
    await explains('行の区切りが `U+2028`（行区切り）の変更履歴のテストです。Python の `splitlines` と同じく改行として扱い、`1.0.0` の本文（`a`）を返すことを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes('## [1.0.0]\u{2028}a\u{2028}## [0.9.0]\nb', '1.0.0')).toBe('a')
    })
  })

  it('CRLF の改行は区切り 1 つとして数え、LF の場合と同じリリースノートを返す', async () => {
    await explains('改行が CRLF の変更履歴のテストです。CRLF を 1 つの区切りとして扱い、改行が LF の場合と同じリリースノートを返すことを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content.replaceAll('\n', '\r\n'), '0.6.1')).toBe(extractVersionReleaseNotes(content, '0.6.1'))
    })
  })

  it('本文の前後の空白は、取り除いて返す', async () => {
    await explains('本文の前後に空行や空白がある変更履歴のテストです。前後の空白を取り除いた本文（`x`）を返すことを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes('## [1.0.0]\n\n\n  x  \n\n## [0.9.0]', '1.0.0')).toBe('x')
    })
  })
})

describe('extractVersionReleaseNotes のリンクと脚注の定義', () => {
  it('最後の版の節は、ファイル末尾の版の見出しのリンク定義を含めずに返す', async () => {
    await explains('Keep a Changelog の形で、ファイル末尾に版のリンク定義を置いた変更履歴のテストです。最後の版を指定した場合に、リンク定義を除いた本文だけを返すことを確認します。')
    const content = '# Changelog\n\n## [0.0.1] - 2026-11-28\n\n- 最初の版\n\n[0.0.1]: https://github.com/acme/demo/releases/tag/v0.0.1\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '0.0.1')).toBe('- 最初の版')
    })
  })

  it('最後の版の節は、本文が使う末尾の定義を残し、本文が使わない定義を除く', async () => {
    await explains('最後の版の本文が参照リンクを使い、その定義がファイル末尾にある変更履歴のテストです。使われる定義だけを本文に残すことを確認します。')
    const content = '## [Unreleased]\n\n## [0.0.1]\n\n- 最初の版。[docs][d]\n\n[unreleased]: https://example.com/compare\n[0.0.1]: https://example.com/v0.0.1\n[d]: https://example.com/docs\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '0.0.1')).toBe('- 最初の版。[docs][d]\n\n[d]: https://example.com/docs')
    })
  })

  it('最後でない版の節は、full・collapsed・shortcut の参照が使う末尾の定義を本文の末尾に加える', async () => {
    await explains('最後でない版の本文が、3 つの形の参照リンクでファイル末尾の定義を使う変更履歴のテストです。使われる定義をファイルでの順に本文の末尾へ加えることを確認します。')
    const content = '## [0.0.2]\n\n- [docs][d]・[guide][]・[faq]\n\n## [0.0.1]\n\n- 最初の版\n\n[0.0.2]: https://example.com/v0.0.2\n[faq]: https://example.com/faq\n[d]: https://example.com/docs\n[guide]: https://example.com/guide\n[unused]: https://example.com/unused\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '0.0.2')).toBe('- [docs][d]・[guide][]・[faq]\n\n[faq]: https://example.com/faq\n[d]: https://example.com/docs\n[guide]: https://example.com/guide')
    })
  })

  it('節の中の使わない定義は除き、使う定義はその位置に残す', async () => {
    await explains('版の節の中にリンク定義がある変更履歴のテストです。本文が使う定義は元の位置に残り、使わない定義は除かれることを確認します。')
    const content = '## [1.0.0]\n\n- [a]\n\n[a]: https://example.com/a\n[b]: https://example.com/b\n\n- 次の項目\n\n## [0.9.0]\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '1.0.0')).toBe('- [a]\n\n[a]: https://example.com/a\n\n- 次の項目')
    })
  })

  it('参照と定義のラベルの大文字・小文字と空白の違いは、同じラベルとして対応させる', async () => {
    await explains('参照と定義でラベルの大文字・小文字や空白の数が違う変更履歴のテストです。CommonMark と同じ正規化で同じラベルとみなし、定義を加えることを確認します。')
    const content = '## [1.0.0]\n\n- [Docs  Page]\n\n## [0.9.0]\n\n[docs page]: https://example.com/docs\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '1.0.0')).toBe('- [Docs  Page]\n\n[docs page]: https://example.com/docs')
    })
  })

  it('フェンスのコードブロックの中の定義の形の行は、定義とみなさずに残す', async () => {
    await explains('版の本文のコードブロックに、リンク定義と同じ形の行がある変更履歴のテストです。コードの中の行は定義ではないため、そのまま本文に残すことを確認します。')
    const content = '## [1.0.0]\n\n```markdown\n[x]: https://example.com/x\n```\n\n## [0.9.0]\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '1.0.0')).toBe('```markdown\n[x]: https://example.com/x\n```')
    })
  })

  it('脚注の参照が使う末尾の脚注の定義を加え、同じラベルのリンク定義は加えない', async () => {
    await explains('版の本文が脚注を使い、同じラベルのリンク定義もファイル末尾にある変更履歴のテストです。脚注の定義だけを空行で分けて加え、リンク定義は加えないことを確認します。')
    const content = '## [1.0.0]\n\n- 変更[^1]\n\n## [0.9.0]\n\n- 前の版\n\n[1]: https://example.com/one\n\n[^1]: 脚注の本文\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '1.0.0')).toBe('- 変更[^1]\n\n[^1]: 脚注の本文')
    })
  })

  it('リンクの参照は、同じラベルの脚注の定義を残さない', async () => {
    await explains('版の本文がリンクの参照を使い、同じラベルの脚注の定義が節の中にある変更履歴のテストです。脚注の定義は使われないため除くことを確認します。')
    const content = '## [1.0.0]\n\n- [1]\n\n[^1]: 脚注の本文\n\n## [0.9.0]\n\n[1]: https://example.com/one\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '1.0.0')).toBe('- [1]\n\n[1]: https://example.com/one')
    })
  })

  it('節の外から加える脚注の定義の中で使う定義も加え、除く脚注の定義の中の参照は数えない', async () => {
    await explains('脚注の定義の中に参照リンクがある変更履歴のテストです。加える脚注が使う定義は加え、除かれる脚注だけが使う定義は加えないことを確認します。')
    const content = '## [1.0.0]\n\n- 変更[^n]\n\n[^unused]: [other][o]\n\n## [0.9.0]\n\n[^n]: 詳しくは [docs][d]\n\n[d]: https://example.com/docs\n[o]: https://example.com/other\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '1.0.0')).toBe('- 変更[^n]\n\n[^n]: 詳しくは [docs][d]\n\n[d]: https://example.com/docs')
    })
  })

  it('同じラベルの定義が節の前と節の中にあるときは、節の中の定義を除き、節の前の定義を加える', async () => {
    await explains('同じラベルのリンク定義が 2 つある変更履歴のテストです。CommonMark と同じく最初の定義を使い、節の中の後の定義を除いて最初の定義を加えることを確認します。')
    const content = '## [1.0.0]\n\n- 前の版\n\n[d]: https://example.com/first\n\n## [0.9.0]\n\n- [d]\n\n[d]: https://example.com/second\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '0.9.0')).toBe('- [d]\n\n[d]: https://example.com/first')
    })
  })

  it('リストと引用の中の定義はそのまま残し、節の外の引用の中の定義は引用の印を付けずに加える', async () => {
    await explains('リストや引用の中にリンク定義がある変更履歴のテストです。節の中の入れ子の定義は印ごと残し、節の外から加える定義には引用の印を付けないことを確認します。')
    const content = '## [1.0.0]\n\n- [x]: https://example.com/x\n> [y]: https://example.com/y\n\n- [q]\n\n## [0.9.0]\n\n> [q]: https://example.com/q\n'

    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(extractVersionReleaseNotes(content, '1.0.0')).toBe('- [x]: https://example.com/x\n> [y]: https://example.com/y\n\n- [q]\n\n[q]: https://example.com/q')
    })
  })
})

describe('ファイル名を渡したときの文', () => {
  it('getLatestVersion のバージョンが存在しない場合のメッセージには、渡したファイル名を使う', async () => {
    await explains('ファイル名（`AIST-CHANGELOG.md`）を渡して、最新のバージョンを求めた場合のテストです。バージョンが存在しないときのエラーのメッセージに、渡したファイル名が使われることを確認します。')
    stepSync('`getLatestVersion` を呼び、結果を比べる', () => {
      expect(() => getLatestVersion('## [Unreleased]', 'AIST-CHANGELOG.md')).toThrow('no version found in AIST-CHANGELOG.md\nfor a first release, specify the version manually')
    })
  })

  it('extractVersionReleaseNotes のバージョンが存在しない場合のメッセージには、渡したファイル名を使う', async () => {
    await explains('ファイル名（`AIST-CHANGELOG.md`）を渡して、リリースノートを抽出した場合のテストです。バージョンが存在しないときのエラーのメッセージに、渡したファイル名が使われることを確認します。')
    stepSync('`extractVersionReleaseNotes` を呼び、結果を比べる', () => {
      expect(() => extractVersionReleaseNotes('## [0.6.0]', '9.9.9', 'AIST-CHANGELOG.md')).toThrow('version not found in AIST-CHANGELOG.md: 9.9.9')
    })
  })
})

describe('changelogNotFoundMessage', () => {
  it.each([
    ['/repo/CHANGELOG.md', 'CHANGELOG.md not found: /repo/CHANGELOG.md'],
    ['/repo/AIST-CHANGELOG.md', 'AIST-CHANGELOG.md not found: /repo/AIST-CHANGELOG.md'],
    ['docs/CUSTOM.md', 'CUSTOM.md not found: docs/CUSTOM.md'],
    ['CHANGELOG.md', 'CHANGELOG.md not found: CHANGELOG.md'],
  ])('パスが %s の場合は、ファイル名を含む「見つからない」メッセージを返す', async (changelogPath, expected) => {
    await explains('変更履歴のファイルが存在しないときのメッセージを作成する関数（`changelogNotFoundMessage`）のテストです。パスの末尾のファイル名と、パス全体を含むメッセージを返すことを確認します。')
    stepSync('`changelogNotFoundMessage` を呼び、結果を比べる', () => {
      expect(changelogNotFoundMessage(changelogPath)).toBe(expected)
    })
  })
})

describe('定数', () => {
  it('既定の変更履歴のファイル名を CHANGELOG.md とし、それを先頭にした、重複のない候補の一覧を持つ', async () => {
    await explains('変更履歴のファイル名の定数のテストです。既定のファイル名は `CHANGELOG.md` で、候補の一覧は `CHANGELOG.md` を先頭にして `AIST-CHANGELOG.md` を含み、重複がないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(DEFAULT_CHANGELOG_FILE).toBe('CHANGELOG.md')
      expect(CHANGELOG_FALLBACK_FILES).toContain('CHANGELOG.md')
      expect(CHANGELOG_FALLBACK_FILES).toContain('AIST-CHANGELOG.md')
      expect(CHANGELOG_FALLBACK_FILES[0]).toBe(DEFAULT_CHANGELOG_FILE)
      expect(new Set(CHANGELOG_FALLBACK_FILES).size).toBe(CHANGELOG_FALLBACK_FILES.length)
    })
  })
})

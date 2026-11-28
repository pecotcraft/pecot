import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import { formatHinted } from '../command-hint.js'
import { InvalidValueError } from '../errors.js'
import { createIssueReference, issueReferenceKey, issueReferenceToCliReference, issueReferenceToString, parseIssueReference, parsePullRequestReference, ReferenceParseError } from '../reference-parser.js'
import { validationErrorTextOutput } from '../../../tests/_helpers/python-output.js'
import { createRepositoryReference } from '../repository-resolver.js'

const base = createRepositoryReference('o', 'r')

function thrownBy(action: () => unknown): ReferenceParseError {
  try {
    action()
  }
  catch (error: unknown) {
    if (error instanceof ReferenceParseError) return error
    throw error
  }
  throw new Error('例外が出なかった')
}

describe('parseIssueReference', () => {
  it('issue 参照に owner/repo/N を渡すと、リポジトリと番号に分けて返す', async () => {
    await explains('Issue 参照を解析する `parseIssueReference` のテストです。`owner/repo/123` の形の文字列を渡した場合に、リポジトリと番号に分けて返すことを確認します。')
    const reference = stepSync('parseIssueReference を呼ぶ', () => parseIssueReference('owner/repo/123'))
    stepSync('結果を比べる', () => {
      expect(reference).toEqual({ repository: { owner: 'owner', repository: 'repo' }, number: 123 })
    })
  })

  it.each([
    ['my-org/my-repo/456', 'my-org', 'my-repo', 456],
    ['my_org/my_repo/789', 'my_org', 'my_repo', 789],
    ['owner/repo.name/123', 'owner', 'repo.name', 123],
    ['owner/repo/5', 'owner', 'repo', 5],
  ])('%j を渡すと、基準リポジトリを指定せずに、owner・repository・番号に分けて返す', async (raw, owner, repository, number) => {
    await explains(`\`parseIssueReference\` のテストです。記号を含む名前を持つ \`${raw}\` を、基準リポジトリを指定せずに渡した場合、owner・repository・番号に分けて返すことを確認します。`)
    stepSync('結果を比べる', () => {
      expect(parseIssueReference(raw)).toEqual({ repository: { owner, repository }, number })
    })
  })

  it('owner/repo/N の形の参照では、基準リポジトリを指定しても無視する', async () => {
    await explains('`owner/repo/N` の形の参照を渡すときの、`parseIssueReference` のテストです。別の基準リポジトリも渡した場合に、基準リポジトリは使わず、参照に書かれたリポジトリを返すことを確認します。')
    const reference = stepSync('parseIssueReference を呼ぶ', () => parseIssueReference('owner/repo/456', createRepositoryReference('other', 'repo')))
    stepSync('結果を比べる', () => {
      expect(reference.repository).toEqual({ owner: 'owner', repository: 'repo' })
    })
  })

  it('短縮形 N は、基準リポジトリで補って返す', async () => {
    await explains('短縮形の参照を渡すときの、`parseIssueReference` のテストです。番号だけを基準リポジトリとともに渡した場合に、基準リポジトリの Issue として返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseIssueReference('123', base)).toEqual({ repository: base, number: 123 })
    })
  })

  it('基準リポジトリを指定せずに短縮形 N を渡すと、フル形式だけを案内する例外が発生する', async () => {
    await explains('基準リポジトリを指定せずに、短縮形の参照を渡す場合のテストです。参照エラーの例外が発生し、メッセージが Python と同じ文でフル形式の `owner/repo/N` だけを案内することを確認します。')
    const error = stepSync('参照の解析で出る例外を受け取る', () => thrownBy(() => parseIssueReference('123')))
    stepSync('結果を比べる', () => {
      expect(error.reference).toBe('123')
      expect(error.message).toBe('the short form \'N\' is not accepted here: use the full form \'owner/repo/N\'')
    })
  })

  it('repo で解決するツールで基準リポジトリが指定されていないと、入力 repo の指定も案内する例外が発生する', async () => {
    await explains('入力 `repo` でリポジトリを解決するツールで、基準リポジトリが指定されていない場合のテストです。参照エラーの例外が発生し、メッセージが `repo:` の指定とフル形式の両方を案内することを確認します。')
    const error = stepSync('参照の解析で出る例外を受け取る', () => thrownBy(() => parseIssueReference('123', undefined, { repositoryFlag: true })))
    stepSync('結果を比べる', () => {
      expect(error.message).toBe('the short form \'N\' needs a base_repo: pass repo: <owner/repo> or use the full form \'owner/repo/N\'')
      expect(formatHinted(error.hintedText ?? error.message)).toBe('the short form \'N\' needs a base_repo: pass repo: <owner/repo> or use the full form \'owner/repo/N\'')
    })
  })

  it('短縮形 N に全角数字や丸数字を渡すと、例外が発生する', async () => {
    await explains('短縮形の参照に使える文字のテストです。全角の数字や丸数字を渡した場合に、ASCII の数字ではないため、参照エラーの例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseIssueReference('\u{FF11}\u{FF12}\u{FF13}', base)).toThrow(ReferenceParseError)
      expect(() => parseIssueReference('\u{2460}', base)).toThrow(ReferenceParseError)
    })
  })

  it.each(['#5', 'owner/repo/abc', 'owner//5', 'not-a-valid-ref', 'owner/repo#', 'owner/repo#abc'])('%j を渡すと、形式が不正として例外が発生する', async (raw) => {
    await explains('形式が不正な参照を渡した場合の、`parseIssueReference` のテストです。`#5` や `owner//5` などの不正な文字列を渡すと、参照エラーの例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseIssueReference(raw)).toThrow(ReferenceParseError)
    })
  })

  it('例外が、渡した元の入力を保持する', async () => {
    await explains('参照エラーの例外のテストです。不正な参照を渡した場合に、例外の `reference` に、渡した元の文字列が入っていることを確認します。')
    stepSync('結果を比べる', () => {
      expect(thrownBy(() => parseIssueReference('invalid')).reference).toBe('invalid')
    })
  })

  it('形式が不正な参照を渡すと、受理する 2 種類の形式を並べた例外メッセージを返す', async () => {
    await explains('形式が不正な参照を渡した場合のメッセージのテストです。受理する形式として、フル形式と短縮形の 2 種類が並び、`owner/repo#N` は含まれないことを、Python の実際の出力と同じ文で確認します。')
    stepSync('結果を比べる', () => {
      expect(thrownBy(() => parseIssueReference('owner//5')).message)
        .toBe('invalid reference: owner//5\naccepted forms:\n  - full: \'owner/repo/N\'\n  - short: \'N\' (with a base repository)')
    })
  })

  it('末尾に改行がある参照も、Python の $ と同じように受理する', async () => {
    await explains('末尾に改行がある参照のテストです。`owner/repo/7` の後ろに改行を付けて渡した場合も、Python の正規表現の `$` と同じように受理し、番号 7 を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseIssueReference('owner/repo/7\n').number).toBe(7)
    })
  })

  it('番号が全角数字でも、Python の int() と同じように数値として読む', async () => {
    await explains('全角数字の番号のテストです。番号が全角数字の `１２` でも、Python の `int()` と同じように数値の 12 として読むことを確認します。')
    stepSync('結果を比べる', () => {
      expect(parseIssueReference('o/r/\u{FF11}\u{FF12}').number).toBe(12)
    })
  })

  it('番号に 0 を渡すと、Python と同じ検証エラーの文で例外が発生する', async () => {
    await explains('番号に 0 を渡した場合のテストです。0 は 1 以上ではないため、Python の実際の出力と同じ検証エラーの文で、例外が発生することを確認します。')
    stepSync('結果を比べる', () => {
      expect(thrownBy(() => parseIssueReference('owner/repo/0')).message).toBe([
        '1 validation error for IssueRef',
        'number',
        '  Input should be greater than 0 [type=greater_than, input_value=0, input_type=int]',
        '    For further information visit https://errors.pydantic.dev/2.14/v/greater_than',
      ].join('\n'))
    })
  })

  it('owner が不正な場合は、検証エラーの文を参照エラーに包んで例外を発生させる', async () => {
    await explains('owner が不正な参照のテストです。検証エラーの文を参照エラーに包んで例外を発生させ、元の入力も保持することを、Python の実際の出力と同じ文で確認します。')
    const { input, message } = stepSync('検証エラーの出力を用意する', () => validationErrorTextOutput('issue-ref-bad-owner'))
    const error = stepSync('参照の解析で出る例外を受け取る', () => thrownBy(() => parseIssueReference(input)))
    stepSync('結果を比べる', () => {
      expect(error.reference).toBe(input)
      expect(error.message).toBe(message)
    })
  })

  it('短縮形に 0 を渡すと、参照エラーではなく検証エラーの例外が発生する', async () => {
    await explains('短縮形に 0 を渡した場合のテストです。Python と同じく、参照エラーではなく、検証エラーの例外がそのまま発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parseIssueReference('0', base)).toThrow(InvalidValueError)
      expect(() => parseIssueReference('0', base)).not.toThrow(ReferenceParseError)
    })
  })
})

describe('parsePullRequestReference', () => {
  it('owner/repo/N を渡すと、リポジトリと番号に分けて返す', async () => {
    await explains('Pull Request の参照を解析する `parsePullRequestReference` のテストです。`owner/repo/456` の形の文字列を渡した場合に、リポジトリと番号に分けて返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(parsePullRequestReference('owner/repo/456')).toEqual({ repository: { owner: 'owner', repository: 'repo' }, number: 456 })
    })
  })

  it('N だけと基準リポジトリを渡すと、基準リポジトリの番号として返す', async () => {
    await explains('短縮形で Pull Request の参照を渡す場合のテストです。番号だけを基準リポジトリとともに渡した場合に、基準リポジトリの Pull Request の番号として返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(parsePullRequestReference('7', base)).toEqual({ repository: base, number: 7 })
    })
  })

  it('形式が不正な参照を渡すと、参照エラーの例外が発生する', async () => {
    await explains('`parsePullRequestReference` に、形式が不正な参照を渡した場合のテストです。参照エラーの例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => parsePullRequestReference('invalid-format')).toThrow(ReferenceParseError)
    })
  })
})

describe('issueReferenceKey', () => {
  it('リポジトリ名の大文字と小文字を区別しないキーを返す', async () => {
    await explains('Issue 参照のキーを作る `issueReferenceKey` のテストです。リポジトリ名の大文字と小文字だけが異なる 2 つの参照が、同じ小文字のキー `acme/app#3` になることを確認します。')
    const upper = stepSync('大文字のリポジトリの Issue 参照を作る', () => createIssueReference(createRepositoryReference('ACME', 'App'), 3))
    const lower = stepSync('小文字のリポジトリの Issue 参照を作る', () => createIssueReference(createRepositoryReference('acme', 'app'), 3))
    stepSync('結果を比べる', () => {
      expect(issueReferenceKey(upper)).toBe('acme/app#3')
      expect(issueReferenceKey(lower)).toBe(issueReferenceKey(upper))
    })
  })
})

describe('IssueReference', () => {
  const reference = createIssueReference(createRepositoryReference('o', 'r'), 42)

  it('Issue 参照を文字列にすると、o/r#42 の形になる', async () => {
    await explains('Issue 参照を文字列にする `issueReferenceToString` のテストです。リポジトリ `o/r` の 42 番の参照が、`o/r#42` の形で出力されることを確認します。')
    stepSync('結果を比べる', () => {
      expect(issueReferenceToString(reference)).toBe('o/r#42')
    })
  })

  it('Issue 参照を CLI 用の参照にすると、o/r/42 の形になる', async () => {
    await explains('Issue 参照から CLI 用の参照を作る `issueReferenceToCliReference` のテストです。リポジトリ `o/r` の 42 番の参照を、`o/r/42` の形で出力することを確認します。')
    stepSync('結果を比べる', () => {
      expect(issueReferenceToCliReference(reference)).toBe('o/r/42')
    })
  })

  it.each([0, -1])('番号に %d を渡すと、検証エラーの例外が発生する', async (number) => {
    await explains('Issue 参照を作る `createIssueReference` のテストです。番号に 0 や負の数を渡した場合に、検証エラーの例外が発生することを確認します。')
    stepSync('例外を確かめる', () => {
      expect(() => createIssueReference(createRepositoryReference('o', 'r'), number)).toThrow(InvalidValueError)
    })
  })
})

import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { formatHinted } from '../command-hint.js'
import { InvalidValueError } from '../errors.js'
import {
  createIssueReference,
  extractReferencesIssueNumbers as extractReferencesIssueNumbers,
  issueReferenceKey,
  issueReferenceToCliReference,
  issueReferenceToString,
  parseIssueReference,
  parsePullRequestReference,
  parseRepositoryReference,
  ReferenceParseError,
} from '../reference-parser.js'
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
    const reference = parseIssueReference('owner/repo/123')
    expect(reference).toEqual({ repository: { owner: 'owner', repository: 'repo' }, number: 123 })
  })

  it.each([
    ['my-org/my-repo/456', 'my-org', 'my-repo', 456],
    ['my_org/my_repo/789', 'my_org', 'my_repo', 789],
    ['owner/repo.name/123', 'owner', 'repo.name', 123],
    ['owner/repo/5', 'owner', 'repo', 5],
  ])('%j を渡すと、基準リポジトリを指定せずに、owner・repository・番号に分けて返す', async (raw, owner, repository, number) => {
    await explains(`\`parseIssueReference\` のテストです。記号を含む名前を持つ \`${raw}\` を、基準リポジトリを指定せずに渡した場合、owner・repository・番号に分けて返すことを確認します。`)
    expect(parseIssueReference(raw)).toEqual({ repository: { owner, repository }, number })
  })

  it('owner/repo/N の形の参照では、基準リポジトリを指定しても無視する', async () => {
    await explains('`owner/repo/N` の形の参照を渡すときの、`parseIssueReference` のテストです。別の基準リポジトリも渡した場合に、基準リポジトリは使わず、参照に書かれたリポジトリを返すことを確認します。')
    const reference = parseIssueReference('owner/repo/456', createRepositoryReference('other', 'repo'))
    expect(reference.repository).toEqual({ owner: 'owner', repository: 'repo' })
  })

  it('短縮形 N は、基準リポジトリで補って返す', async () => {
    await explains('短縮形の参照を渡すときの、`parseIssueReference` のテストです。番号だけを基準リポジトリとともに渡した場合に、基準リポジトリの Issue として返すことを確認します。')
    expect(parseIssueReference('123', base)).toEqual({ repository: base, number: 123 })
  })

  it('基準リポジトリを指定せずに短縮形 N を渡すと、フル形式だけを案内する例外が発生する', async () => {
    await explains('基準リポジトリを指定せずに、短縮形の参照を渡す場合のテストです。参照エラーの例外が発生し、メッセージが Python と同じ文でフル形式の `owner/repo/N` だけを案内することを確認します。')
    const error = thrownBy(() => parseIssueReference('123'))
    expect(error.reference).toBe('123')
    expect(error.message).toBe('the short form \'N\' is not accepted here: use the full form \'owner/repo/N\'')
  })

  it('repo で解決するツールで基準リポジトリが指定されていないと、入力 repo の指定も案内する例外が発生する', async () => {
    await explains('入力 `repo` でリポジトリを解決するツールで、基準リポジトリが指定されていない場合のテストです。参照エラーの例外が発生し、メッセージが `repo:` の指定とフル形式の両方を案内することを確認します。')
    const error = thrownBy(() => parseIssueReference('123', undefined, { repositoryFlag: true }))
    expect(error.message).toBe('the short form \'N\' needs a base_repo: pass repo: <owner/repo> or use the full form \'owner/repo/N\'')
    expect(formatHinted(error.hintedText ?? error.message)).toBe('the short form \'N\' needs a base_repo: pass repo: <owner/repo> or use the full form \'owner/repo/N\'')
  })

  it('短縮形 N に全角数字や丸数字を渡すと、例外が発生する', async () => {
    await explains('短縮形の参照に使える文字のテストです。全角の数字や丸数字を渡した場合に、ASCII の数字ではないため、参照エラーの例外が発生することを確認します。')
    expect(() => parseIssueReference('\u{FF11}\u{FF12}\u{FF13}', base)).toThrow(ReferenceParseError)
    expect(() => parseIssueReference('\u{2460}', base)).toThrow(ReferenceParseError)
  })

  it.each(['#5', 'owner/repo/abc', 'owner//5', 'not-a-valid-ref', 'owner/repo#', 'owner/repo#abc'])('%j を渡すと、形式が不正として例外が発生する', async (raw) => {
    await explains('形式が不正な参照を渡した場合の、`parseIssueReference` のテストです。`#5` や `owner//5` などの不正な文字列を渡すと、参照エラーの例外が発生することを確認します。')
    expect(() => parseIssueReference(raw)).toThrow(ReferenceParseError)
  })

  it('例外が、渡した元の入力を保持する', async () => {
    await explains('参照エラーの例外のテストです。不正な参照を渡した場合に、例外の `reference` に、渡した元の文字列が入っていることを確認します。')
    expect(thrownBy(() => parseIssueReference('invalid')).reference).toBe('invalid')
  })

  it('形式が不正な参照を渡すと、受理する 2 種類の形式を並べた例外メッセージを返す', async () => {
    await explains('形式が不正な参照を渡した場合のメッセージのテストです。受理する形式として、フル形式と短縮形の 2 種類が並び、`owner/repo#N` は含まれないことを、Python の実際の出力と同じ文で確認します。')
    expect(thrownBy(() => parseIssueReference('owner//5')).message)
      .toBe('invalid reference: owner//5\naccepted forms:\n  - full: \'owner/repo/N\'\n  - short: \'N\' (with a base repository)')
  })

  it('末尾に改行がある参照も、Python の $ と同じように受理する', async () => {
    await explains('末尾に改行がある参照のテストです。`owner/repo/7` の後ろに改行を付けて渡した場合も、Python の正規表現の `$` と同じように受理し、番号 7 を返すことを確認します。')
    expect(parseIssueReference('owner/repo/7\n').number).toBe(7)
  })

  it('番号が全角数字でも、Python の int() と同じように数値として読む', async () => {
    await explains('全角数字の番号のテストです。番号が全角数字の `１２` でも、Python の `int()` と同じように数値の 12 として読むことを確認します。')
    expect(parseIssueReference('o/r/\u{FF11}\u{FF12}').number).toBe(12)
  })

  it('番号に 0 を渡すと、Python と同じ検証エラーの文で例外が発生する', async () => {
    await explains('番号に 0 を渡した場合のテストです。0 は 1 以上ではないため、Python の実際の出力と同じ検証エラーの文で、例外が発生することを確認します。')
    expect(thrownBy(() => parseIssueReference('owner/repo/0')).message).toBe([
      '1 validation error for IssueRef',
      'number',
      '  Input should be greater than 0 [type=greater_than, input_value=0, input_type=int]',
      '    For further information visit https://errors.pydantic.dev/2.14/v/greater_than',
    ].join('\n'))
  })

  it('owner が不正な場合は、検証エラーの文を参照エラーに包んで例外を発生させる', async () => {
    await explains('owner が不正な参照のテストです。検証エラーの文を参照エラーに包んで例外を発生させ、元の入力も保持することを、Python の実際の出力と同じ文で確認します。')
    const { input, message } = validationErrorTextOutput('issue-ref-bad-owner')
    const error = thrownBy(() => parseIssueReference(input))
    expect(error.reference).toBe(input)
    expect(error.message).toBe(message)
  })

  it('短縮形に 0 を渡すと、参照エラーではなく検証エラーの例外が発生する', async () => {
    await explains('短縮形に 0 を渡した場合のテストです。Python と同じく、参照エラーではなく、検証エラーの例外がそのまま発生することを確認します。')
    expect(() => parseIssueReference('0', base)).toThrow(InvalidValueError)
    expect(() => parseIssueReference('0', base)).not.toThrow(ReferenceParseError)
  })
})

describe('parsePullRequestReference', () => {
  it('owner/repo/N を渡すと、リポジトリと番号に分けて返す', async () => {
    await explains('Pull Request の参照を解析する `parsePullRequestReference` のテストです。`owner/repo/456` の形の文字列を渡した場合に、リポジトリと番号に分けて返すことを確認します。')
    expect(parsePullRequestReference('owner/repo/456')).toEqual({ repository: { owner: 'owner', repository: 'repo' }, number: 456 })
  })

  it('N だけと基準リポジトリを渡すと、基準リポジトリの番号として返す', async () => {
    await explains('短縮形で Pull Request の参照を渡す場合のテストです。番号だけを基準リポジトリとともに渡した場合に、基準リポジトリの Pull Request の番号として返すことを確認します。')
    expect(parsePullRequestReference('7', base)).toEqual({ repository: base, number: 7 })
  })

  it('形式が不正な参照を渡すと、参照エラーの例外が発生する', async () => {
    await explains('`parsePullRequestReference` に、形式が不正な参照を渡した場合のテストです。参照エラーの例外が発生することを確認します。')
    expect(() => parsePullRequestReference('invalid-format')).toThrow(ReferenceParseError)
  })
})

describe('parseRepositoryReference', () => {
  it.each([
    ['owner/repo', 'owner', 'repo'],
    ['my-org/my-repo', 'my-org', 'my-repo'],
    ['owner/repo.name', 'owner', 'repo.name'],
  ])('%j のとき、owner と repository に分ける', async (raw, owner, repository) => {
    await explains('リポジトリの参照を解析する `parseRepositoryReference` のテストです。`owner/repo` の形の文字列を渡した場合に、owner と repository に分けて返すことを確認します。')
    expect(parseRepositoryReference(raw)).toEqual({ owner, repository })
  })

  it.each(['owner/repo/123', 'ownerrepo', ''])('%j を渡すと、参照エラーの例外が発生する', async (raw) => {
    await explains('`parseRepositoryReference` に、`owner/repo` の形ではない文字列を渡した場合のテストです。区切りが多い場合や存在しない場合、空文字の場合に、参照エラーの例外が発生することを確認します。')
    expect(() => parseRepositoryReference(raw)).toThrow(ReferenceParseError)
  })

  it('セグメントが不正な場合も、参照エラーに包み、元の入力を保持する', async () => {
    await explains('owner や repository の部分が不正な場合のテストです。検証エラーを参照エラーに包んで例外を発生させ、元の入力を保持することを、Python の実際の出力と同じ文で確認します。')
    const error = thrownBy(() => parseRepositoryReference('a b/c'))
    expect(error.reference).toBe('a b/c')
    expect(error.message).toContain('1 validation error for RepoRef\nowner\n')
  })
})

describe('issueReferenceKey', () => {
  it('リポジトリ名の大文字と小文字を区別しないキーを返す', async () => {
    await explains('Issue 参照のキーを作る `issueReferenceKey` のテストです。リポジトリ名の大文字と小文字だけが異なる 2 つの参照が、同じ小文字のキー `acme/app#3` になることを確認します。')
    const upper = createIssueReference(createRepositoryReference('ACME', 'App'), 3)
    const lower = createIssueReference(createRepositoryReference('acme', 'app'), 3)
    expect(issueReferenceKey(upper)).toBe('acme/app#3')
    expect(issueReferenceKey(lower)).toBe(issueReferenceKey(upper))
  })
})

describe('IssueReference', () => {
  const reference = createIssueReference(createRepositoryReference('o', 'r'), 42)

  it('Issue 参照を文字列にすると、o/r#42 の形になる', async () => {
    await explains('Issue 参照を文字列にする `issueReferenceToString` のテストです。リポジトリ `o/r` の 42 番の参照が、`o/r#42` の形で出力されることを確認します。')
    expect(issueReferenceToString(reference)).toBe('o/r#42')
  })

  it('Issue 参照を CLI 用の参照にすると、o/r/42 の形になる', async () => {
    await explains('Issue 参照から CLI 用の参照を作る `issueReferenceToCliReference` のテストです。リポジトリ `o/r` の 42 番の参照を、`o/r/42` の形で出力することを確認します。')
    expect(issueReferenceToCliReference(reference)).toBe('o/r/42')
  })

  it.each([0, -1])('番号に %d を渡すと、検証エラーの例外が発生する', async (number) => {
    await explains('Issue 参照を作る `createIssueReference` のテストです。番号に 0 や負の数を渡した場合に、検証エラーの例外が発生することを確認します。')
    expect(() => createIssueReference(createRepositoryReference('o', 'r'), number)).toThrow(InvalidValueError)
  })
})

describe('extractReferencesIssueNumbers', () => {
  const pullRepository = createRepositoryReference('acme-labs', 'aist-plugin')
  const extract = (body: string | undefined): readonly number[] => [...extractReferencesIssueNumbers(body, pullRepository)].toSorted((a, b) => a - b)

  it('Refs #N の行から Issue 番号を取り出す', async () => {
    await explains('本文から Issue 番号を取り出す `extractReferencesIssueNumbers` のテストです。`Refs #935` の行がある本文を渡した場合に、Issue 番号の 935 を返すことを確認します。')
    expect(extract('変更内容\n\nRefs #935')).toEqual([935])
  })

  it('Refs を複数行に並べると、すべての番号を返す', async () => {
    await explains('`Refs` の行が複数ある本文のテストです。複数の行に並んだ `Refs` から、すべての番号を返すことを確認します。')
    expect(extract('Refs #100\nRefs #200')).toEqual([100, 200])
  })

  it('Ref と単数形で書いても、番号を返す', async () => {
    await explains('単数形の `Ref` で書いた参照のテストです。`Ref #42` と書いた場合も、番号を返すことを確認します。')
    expect(extract('Ref #42')).toEqual([42])
  })

  it('大文字と小文字を区別せずに、Refs を取り出す', async () => {
    await explains('`Refs` の大文字と小文字のテストです。小文字の `refs #10` と書いた場合も、番号を返すことを確認します。')
    expect(extract('refs #10')).toEqual([10])
  })

  it('Refs が存在しなければ、空を返す', async () => {
    await explains('`Refs` が存在しない本文のテストです。`Refs` を含まない本文を渡した場合に、空の配列を返すことを確認します。')
    expect(extract('本文のみ')).toEqual([])
  })

  it('本文が undefined か空文字なら、空を返す', async () => {
    await explains('本文が存在しない場合のテストです。本文が `undefined` の場合と空文字の場合に、どちらも空の配列を返すことを確認します。')
    expect(extract(undefined)).toEqual([])
    expect(extract('')).toEqual([])
  })

  it('Fixes は、番号を取り出さない', async () => {
    await explains('`Fixes` を使った参照のテストです。`Fixes #123` と書いた場合は、`Refs` ではないため、空の配列を返すことを確認します。')
    expect(extract('Fixes #123')).toEqual([])
  })

  it('文の途中にある Refs からも、番号を返す', async () => {
    await explains('文の途中にある `Refs` のテストです。文章の中に `Refs #55` を書いた場合も、番号を返すことを確認します。')
    expect(extract('この変更は Refs #55 に関連')).toEqual([55])
  })

  it('Refs の直前が空白や行頭でない場合は、番号を取り出さない', async () => {
    await explains('`Refs` の直前の文字のテストです。`xRefs #7` のように、直前が空白や行頭でない `Refs` からは、番号を返さないことを確認します。')
    expect(extract('xRefs #7')).toEqual([])
  })

  it('Refs の直後にコロンがあっても、番号を返す', async () => {
    await explains('`Refs` の直後に付くコロンのテストです。`Refs: #171` のように、`Refs` の直後にコロンがある場合も、番号を返すことを確認します。')
    expect(extract('Refs: #171')).toEqual([171])
    expect(extract('Refs: #251 (Epic: #43)')).toEqual([251])
  })

  it('同じリポジトリを owner/repo#N や owner/repo/N で書くと、番号を返す', async () => {
    await explains('同じリポジトリを書き方を変えて参照した場合のテストです。`owner/repo#N` の形と `owner/repo/N` の形のどちらでも、番号を返すことを確認します。')
    expect(extract('Refs: acme-labs/aist-plugin#227')).toEqual([227])
    expect(extract('Refs acme-labs/aist-plugin/228')).toEqual([228])
  })

  it('同じリポジトリの判定では、大文字と小文字を区別しない', async () => {
    await explains('同じリポジトリかどうかの判定のテストです。参照に書かれたリポジトリ名の大文字と小文字が異なる場合も、同じリポジトリとみなして番号を返すことを確認します。')
    expect(extract('Refs ACme-labs/AIST-Plugin#9')).toEqual([9])
  })

  it('他のリポジトリの参照は、無視する', async () => {
    await explains('他のリポジトリの参照のテストです。別のリポジトリを指す `Refs` は、`owner/repo#N` の形でも `owner/repo/N` の形でも、番号を返さないことを確認します。')
    expect(extract('Refs acme-labs/pecot-presentation#264\nRefs other/aist-plugin/5')).toEqual([])
  })

  it('書式の違う参照を混ぜると、同じリポジトリの番号だけを返す', async () => {
    await explains('書き方の異なる参照が混在する本文のテストです。同じリポジトリの参照だけを選び、別のリポジトリの参照は除いて、番号を返すことを確認します。')
    expect(extract('Refs #1\nRef: acme-labs/aist-plugin#2\nRefs other/repo#3\nrefs acme-labs/aist-plugin/4')).toEqual([1, 2, 4])
  })

  it('# と owner/repo のどちらも付いていない番号は、取り出さない', async () => {
    await explains('番号だけを書いた参照のテストです。`Refs 12` のように、`#` と `owner/repo` のどちらも付いていない番号からは、空の配列を返すことを確認します。')
    expect(extract('Refs 12')).toEqual([])
  })
})

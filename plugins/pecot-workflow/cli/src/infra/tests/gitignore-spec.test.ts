import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { compileGitIgnoreSpec, GitIgnorePatternError, patternToRegex } from '../gitignore-spec.js'
import { GITIGNORE_CASES } from './gitignore-spec-cases.js'

describe('compileGitIgnoreSpec（pathspec 1.1.1 の GitIgnoreSpec と同じ判定）', () => {
  const judged = GITIGNORE_CASES.filter(testCase => testCase.results !== undefined)

  it.each(judged)('$patterns を渡すと、各ファイルの一致が期待の判定になる', async (testCase) => {
    await explains('`.gitignore` のパターンを組み立てる `compileGitIgnoreSpec` のテストです。パターンの一覧を渡した場合に、有効なパターンの数と、各ファイルが除外の対象かどうかの判定が、期待どおりになることを確認します。')
    const spec = compileGitIgnoreSpec(testCase.patterns)
    expect(spec.matchablePatternCount).toBe(testCase.matchable)
    const actual = (testCase.results ?? []).map(([file]) => [file, spec.matchFile(file)])
    expect(actual).toEqual(testCase.results)
  })

  it.each(GITIGNORE_CASES.filter(testCase => testCase.error !== undefined))('不正なパターン $patterns を渡すと、GitIgnorePatternError を送出する', async (testCase) => {
    await explains('不正なパターンを渡した場合の `compileGitIgnoreSpec` のテストです。`GitIgnorePatternError` が、期待するメッセージで発生することを確認します。')
    expect(() => compileGitIgnoreSpec(testCase.patterns)).toThrow(GitIgnorePatternError)
    expect(() => compileGitIgnoreSpec(testCase.patterns)).toThrow(testCase.error)
  })

  it('.nx/ に否定パターンを組み合わせると、version-plans だけを除外の対象から外す', async () => {
    await explains('`.nx/` を除外して `!.nx/version-plans/` で例外にしたパターンのテストです。`.nx/workspace-data/cache.db` は除外の対象になり、`.nx/version-plans/my-plan.md` は対象にならないことを確認します。')
    const spec = compileGitIgnoreSpec(['.nx/', '!.nx/version-plans/'])
    expect(spec.matchFile('.nx/workspace-data/cache.db')).toBe(true)
    expect(spec.matchFile('.nx/version-plans/my-plan.md')).toBe(false)
  })

  it('dir/ に否定パターンを組み合わせると、keep.txt だけを除外の対象から外す', async () => {
    await explains('`dir/` を除外して `!dir/keep.txt` で例外にしたパターンのテストです。`dir/x.txt` は除外の対象になり、`dir/keep.txt` は対象にならないことを確認します。')
    const spec = compileGitIgnoreSpec(['dir/', '!dir/keep.txt'])
    expect(spec.matchFile('dir/x.txt')).toBe(true)
    expect(spec.matchFile('dir/keep.txt')).toBe(false)
  })

  it('先頭の / と ./ を取り除いて判定する', async () => {
    await explains('パターン `/a/b` の判定のテストです。`a/b`・`/a/b`・`./a/b` のどれも一致し、`x/a/b` は一致しないことを確認します。')
    const spec = compileGitIgnoreSpec(['/a/b'])
    expect(spec.matchFile('a/b')).toBe(true)
    expect(spec.matchFile('/a/b')).toBe(true)
    expect(spec.matchFile('./a/b')).toBe(true)
    expect(spec.matchFile('x/a/b')).toBe(false)
  })

  it('空の行・空白のみの行・コメント行・/ だけの行は、有効なパターンの数に含めない', async () => {
    await explains('有効なパターンの数（`matchablePatternCount`）のテストです。空の行・空白のみの行・コメント行・`/` だけの行は数えず、`a` や `b` のような一致しうるパターンだけを数えることを確認します。')
    expect(compileGitIgnoreSpec(['', '  ', '# c', '/']).matchablePatternCount).toBe(0)
    expect(compileGitIgnoreSpec(['a', '', 'b']).matchablePatternCount).toBe(2)
  })
})

describe('patternToRegex', () => {
  it.each(['', ' '.repeat(3), '# comment', '/', '[a', '[!'])('パターン %j は、どのファイルにも一致しないため undefined を返す', async (line) => {
    await explains('パターンを正規表現に変換する `patternToRegex` のテストです。空の行・空白だけの行・コメント行・`/`・閉じていない括弧式を渡した場合に、`undefined` を返すことを確認します。')
    expect(patternToRegex(line)).toBeUndefined()
  })

  it('否定パターンは include が false、通常のパターンは true になる', async () => {
    await explains('パターンを正規表現に変換する `patternToRegex` のテストです。`!a` のような否定パターンは `include` が `false`、`a` のような通常のパターンは `true` になることを確認します。')
    expect(patternToRegex('!a')?.include).toBe(false)
    expect(patternToRegex('a')?.include).toBe(true)
  })

  it('パターンを、JavaScript の正規表現の source にして返す', async () => {
    await explains('パターンを正規表現に変換する `patternToRegex` のテストです。`foo/` や `/foo`、`*`、`a/*/` などのパターンを、Python の `pathspec` と同じ意味の JavaScript の正規表現の `source` にして返すことを確認します。')
    expect(patternToRegex('foo/')).toEqual({ source: String.raw`^(?:[^\n]+/)?foo(?<ps_d>/)`, include: true })
    expect(patternToRegex('/foo')).toEqual({ source: '^foo(?:(?<ps_d>/)|$)', include: true })
    expect(patternToRegex('*')).toEqual({ source: '.', include: true })
    expect(patternToRegex('**/')).toEqual({ source: '(?<ps_d>/)', include: true })
    expect(patternToRegex('*/')).toEqual({ source: '(?<ps_d>/)', include: true })
    expect(patternToRegex('a/*/')).toEqual({ source: '^a/[^/]+(?<ps_d>/)', include: true })
  })

  it('括弧式の先頭の ] は、空の文字クラスにならないようにエスケープする', async () => {
    await explains('括弧式を含むパターンの `patternToRegex` のテストです。`[]a]x` と `[!]a]x` のように先頭に `]` がある場合に、`]` をエスケープして文字クラスに含めることを確認します。')
    expect(patternToRegex('[]a]x')?.source).toBe(String.raw`^(?:[^\n]+/)?[\]a]x(?:(?<ps_d>/)|$)`)
    expect(patternToRegex('[!]a]x')?.source).toBe(String.raw`^(?:[^\n]+/)?[^\]a]x(?:(?<ps_d>/)|$)`)
  })

  it('バックスラッシュは括弧式の中でも文字として扱う', async () => {
    await explains('括弧式を含むパターンの `patternToRegex` のテストです。括弧式の中のバックスラッシュを、エスケープの記号でなく通常の文字として扱い、正規表現の `source` でエスケープすることを確認します。')
    expect(patternToRegex(String.raw`[\]x`)?.source).toBe(String.raw`^(?:[^\n]+/)?[\\]x(?:(?<ps_d>/)|$)`)
  })

  it('正規表現の記号はエスケープする', async () => {
    await explains('正規表現の記号を含むパターンの `patternToRegex` のテストです。`a+b(c)` の `+` や `(` `)` が、`source` ではエスケープされることを確認します。')
    expect(patternToRegex('a+b(c)')?.source).toBe(String.raw`^(?:[^\n]+/)?a\+b\(c\)(?:(?<ps_d>/)|$)`)
  })

  it('末尾のバックスラッシュ付きの空白は残し、バックスラッシュのない空白は取り除く', async () => {
    await explains('末尾に空白があるパターンの `patternToRegex` のテストです。バックスラッシュ付きの空白は `source` に残し、バックスラッシュのない空白は取り除くことを確認します。')
    expect(patternToRegex(String.raw`trail\ `)?.source).toBe(String.raw`^(?:[^\n]+/)?trail (?:(?<ps_d>/)|$)`)
    expect(patternToRegex('trail   ')?.source).toBe(String.raw`^(?:[^\n]+/)?trail(?:(?<ps_d>/)|$)`)
  })

  it.each([
    ['!', 'Invalid git pattern: \'!\''],
    ['\\', String.raw`Invalid git pattern: '\\'`],
    ['a\\', String.raw`Invalid git pattern: 'a\\'`],
  ])('不正なパターン %j を渡すと、GitIgnorePatternError を送出する', async (line, message) => {
    await explains('不正なパターンを渡した場合の `patternToRegex` のテストです。`!` やバックスラッシュで終わるパターンのときに、`Invalid git pattern` で始まる `GitIgnorePatternError` が発生することを確認します。')
    expect(() => patternToRegex(line)).toThrow(GitIgnorePatternError)
    expect(() => patternToRegex(line)).toThrow(message)
  })

  it('範囲が逆の括弧式 [z-a] を渡すと、SyntaxError を送出する', async () => {
    await explains('範囲が逆の括弧式を含むパターンの `compileGitIgnoreSpec` のテストです。`[z-a]` を渡した場合に、正規表現の生成で `SyntaxError` が発生することを確認します。')
    expect(() => compileGitIgnoreSpec(['[z-a]'])).toThrow(SyntaxError)
  })
})

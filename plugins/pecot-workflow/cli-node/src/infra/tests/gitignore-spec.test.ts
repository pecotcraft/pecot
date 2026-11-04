import { describe, expect, it } from 'vitest'

import { compileGitIgnoreSpec, GitIgnorePatternError, patternToRegex } from '../gitignore-spec.js'
import { GITIGNORE_CASES } from './gitignore-spec-cases.js'

describe('compileGitIgnoreSpec（pathspec 1.1.1 の GitIgnoreSpec と同じ判定）', () => {
  const judged = GITIGNORE_CASES.filter(testCase => testCase.results !== undefined)

  it.each(judged)('パターン $patterns', (testCase) => {
    const spec = compileGitIgnoreSpec(testCase.patterns)
    expect(spec.matchablePatternCount).toBe(testCase.matchable)
    const actual = (testCase.results ?? []).map(([file]) => [file, spec.matchFile(file)])
    expect(actual).toEqual(testCase.results)
  })

  it.each(GITIGNORE_CASES.filter(testCase => testCase.error !== undefined))('不正なパターン $patterns は GitIgnorePatternError', (testCase) => {
    expect(() => compileGitIgnoreSpec(testCase.patterns)).toThrow(GitIgnorePatternError)
    expect(() => compileGitIgnoreSpec(testCase.patterns)).toThrow(testCase.error)
  })

  it('.nx/ に否定パターンを組むと、version-plans だけを除外から救う', () => {
    const spec = compileGitIgnoreSpec(['.nx/', '!.nx/version-plans/'])
    expect(spec.matchFile('.nx/workspace-data/cache.db')).toBe(true)
    expect(spec.matchFile('.nx/version-plans/my-plan.md')).toBe(false)
  })

  it('dir/ に否定パターンを組むと、keep.txt だけを除外から救う', () => {
    const spec = compileGitIgnoreSpec(['dir/', '!dir/keep.txt'])
    expect(spec.matchFile('dir/x.txt')).toBe(true)
    expect(spec.matchFile('dir/keep.txt')).toBe(false)
  })

  it('先頭の / と ./ は落として判定する', () => {
    const spec = compileGitIgnoreSpec(['/a/b'])
    expect(spec.matchFile('a/b')).toBe(true)
    expect(spec.matchFile('/a/b')).toBe(true)
    expect(spec.matchFile('./a/b')).toBe(true)
    expect(spec.matchFile('x/a/b')).toBe(false)
  })

  it('空の行は数えない。空白だけの行は、何にも当たらないパターンとして数えない', () => {
    expect(compileGitIgnoreSpec(['', '  ', '# c', '/']).matchablePatternCount).toBe(0)
    expect(compileGitIgnoreSpec(['a', '', 'b']).matchablePatternCount).toBe(2)
  })
})

describe('patternToRegex', () => {
  it.each(['', ' '.repeat(3), '# comment', '/', '[a', '[!'])('パターン %j は何にも当たらない', (line) => {
    expect(patternToRegex(line)).toBeUndefined()
  })

  it('否定パターンは include が false', () => {
    expect(patternToRegex('!a')?.include).toBe(false)
    expect(patternToRegex('a')?.include).toBe(true)
  })

  it('Python の正規表現を JS の書式にした source を作る', () => {
    expect(patternToRegex('foo/')).toEqual({ source: String.raw`^(?:[^\n]+/)?foo(?<ps_d>/)`, include: true })
    expect(patternToRegex('/foo')).toEqual({ source: '^foo(?:(?<ps_d>/)|$)', include: true })
    expect(patternToRegex('*')).toEqual({ source: '.', include: true })
    expect(patternToRegex('**/')).toEqual({ source: '(?<ps_d>/)', include: true })
    expect(patternToRegex('*/')).toEqual({ source: '(?<ps_d>/)', include: true })
    expect(patternToRegex('a/*/')).toEqual({ source: '^a/[^/]+(?<ps_d>/)', include: true })
  })

  it('括弧式の先頭の ] は、空の文字クラスにならないよう escape する', () => {
    expect(patternToRegex('[]a]x')?.source).toBe(String.raw`^(?:[^\n]+/)?[\]a]x(?:(?<ps_d>/)|$)`)
    expect(patternToRegex('[!]a]x')?.source).toBe(String.raw`^(?:[^\n]+/)?[^\]a]x(?:(?<ps_d>/)|$)`)
  })

  it('バックスラッシュは括弧式の中でも文字として扱う', () => {
    expect(patternToRegex(String.raw`[\]x`)?.source).toBe(String.raw`^(?:[^\n]+/)?[\\]x(?:(?<ps_d>/)|$)`)
  })

  it('正規表現の記号は escape する', () => {
    expect(patternToRegex('a+b(c)')?.source).toBe(String.raw`^(?:[^\n]+/)?a\+b\(c\)(?:(?<ps_d>/)|$)`)
  })

  it('末尾のバックスラッシュ付き空白は残し、ただの空白は落とす', () => {
    expect(patternToRegex(String.raw`trail\ `)?.source).toBe(String.raw`^(?:[^\n]+/)?trail (?:(?<ps_d>/)|$)`)
    expect(patternToRegex('trail   ')?.source).toBe(String.raw`^(?:[^\n]+/)?trail(?:(?<ps_d>/)|$)`)
  })

  it.each([
    ['!', 'Invalid git pattern: \'!\''],
    ['\\', String.raw`Invalid git pattern: '\\'`],
    ['a\\', String.raw`Invalid git pattern: 'a\\'`],
  ])('不正なパターン %j は GitIgnorePatternError（文は Python と同じ）', (line, message) => {
    expect(() => patternToRegex(line)).toThrow(GitIgnorePatternError)
    expect(() => patternToRegex(line)).toThrow(message)
  })

  it('範囲が逆の括弧式は、Python の re.error と同じく例外（SyntaxError）で落ちる', () => {
    expect(() => compileGitIgnoreSpec(['[z-a]'])).toThrow(SyntaxError)
  })
})

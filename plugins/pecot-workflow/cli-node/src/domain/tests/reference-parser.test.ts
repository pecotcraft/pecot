import { describe, expect, it } from 'vitest'

import { InvalidValueError } from '../errors.js'
import {
  createIssueReference,
  extractReferencesIssueNumbers as extractReferencesIssueNumbers,
  issueReferenceToCliReference,
  issueReferenceToString,
  parseIssueReference,
  parsePullRequestReference,
  parseRepositoryReference,
  ReferenceParseError,
} from '../reference-parser.js'
import { validationErrorTextOutput } from '../../tests/_helpers/python-output.js'
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
  it('主軸形式 owner/repo/N', () => {
    const reference = parseIssueReference('owner/repo/123')
    expect(reference).toEqual({ repository: { owner: 'owner', repository: 'repo' }, number: 123 })
  })

  it.each([
    ['my-org/my-repo/456', 'my-org', 'my-repo', 456],
    ['my_org/my_repo/789', 'my_org', 'my_repo', 789],
    ['owner/repo.name/123', 'owner', 'repo.name', 123],
    ['owner/repo/5', 'owner', 'repo', 5],
  ])('%j の特殊文字・基準リポ無し', (raw, owner, repository, number) => {
    expect(parseIssueReference(raw)).toEqual({ repository: { owner, repository }, number })
  })

  it('主軸形式があれば基準リポは無視される', () => {
    const reference = parseIssueReference('owner/repo/456', createRepositoryReference('other', 'repo'))
    expect(reference.repository).toEqual({ owner: 'owner', repository: 'repo' })
  })

  it('短縮形 N は基準リポで補う', () => {
    expect(parseIssueReference('123', base)).toEqual({ repository: base, number: 123 })
  })

  it('短縮形 N で基準リポが無いと例外。文は Python と同じ', () => {
    const error = thrownBy(() => parseIssueReference('123'))
    expect(error.reference).toBe('123')
    expect(error.message).toBe('短縮形 \'N\' は base_repo が必須です。--repo <owner/repo> を指定するか、主軸形式 \'owner/repo/N\' で指定してください。')
  })

  it('短縮形は ASCII の数字だけ（全角・丸数字は不可）', () => {
    expect(() => parseIssueReference('\u{FF11}\u{FF12}\u{FF13}', base)).toThrow(ReferenceParseError)
    expect(() => parseIssueReference('\u{2460}', base)).toThrow(ReferenceParseError)
  })

  it.each(['#5', 'owner/repo/abc', 'owner//5', 'not-a-valid-ref', 'owner/repo#', 'owner/repo#abc'])('%j は形式不正', (raw) => {
    expect(() => parseIssueReference(raw)).toThrow(ReferenceParseError)
  })

  it('エラーは元の入力を持つ', () => {
    expect(thrownBy(() => parseIssueReference('invalid')).reference).toBe('invalid')
  })

  it('不正形式のエラー文に受理形式 2 種類が並び、owner/repo#N は含まれない（Python の実出力）', () => {
    expect(thrownBy(() => parseIssueReference('owner//5')).message)
      .toBe('不正な参照形式: owner//5\n受理形式:\n  - 主軸: \'owner/repo/N\'\n  - 短縮形: \'N\'（基準リポと併用）')
  })

  it('末尾に改行があっても Python の $ と同じく受理する', () => {
    expect(parseIssueReference('owner/repo/7\n').number).toBe(7)
  })

  it('全角数字の番号も int() で読む', () => {
    expect(parseIssueReference('o/r/\u{FF11}\u{FF12}').number).toBe(12)
  })

  it('番号 0 は検証エラーの文（Python の実出力）', () => {
    expect(thrownBy(() => parseIssueReference('owner/repo/0')).message).toBe([
      '1 validation error for IssueRef',
      'number',
      '  Input should be greater than 0 [type=greater_than, input_value=0, input_type=int]',
      '    For further information visit https://errors.pydantic.dev/2.14/v/greater_than',
    ].join('\n'))
  })

  it('owner が不正なら検証エラーの文を参照エラーに包む（Python の実出力）', () => {
    const { input, message } = validationErrorTextOutput('issue-ref-bad-owner')
    const error = thrownBy(() => parseIssueReference(input))
    expect(error.reference).toBe(input)
    expect(error.message).toBe(message)
  })

  it('短縮形で 0 を渡すと参照エラーではなく検証エラーがそのまま出る（Python と同じ）', () => {
    expect(() => parseIssueReference('0', base)).toThrow(InvalidValueError)
    expect(() => parseIssueReference('0', base)).not.toThrow(ReferenceParseError)
  })
})

describe('parsePullRequestReference', () => {
  it('主軸形式', () => {
    expect(parsePullRequestReference('owner/repo/456')).toEqual({ repository: { owner: 'owner', repository: 'repo' }, number: 456 })
  })

  it('短縮形', () => {
    expect(parsePullRequestReference('7', base)).toEqual({ repository: base, number: 7 })
  })

  it('不正は拒否', () => {
    expect(() => parsePullRequestReference('invalid-format')).toThrow(ReferenceParseError)
  })
})

describe('parseRepositoryReference', () => {
  it.each([
    ['owner/repo', 'owner', 'repo'],
    ['my-org/my-repo', 'my-org', 'my-repo'],
    ['owner/repo.name', 'owner', 'repo.name'],
  ])('%j', (raw, owner, repository) => {
    expect(parseRepositoryReference(raw)).toEqual({ owner, repository })
  })

  it.each(['owner/repo/123', 'ownerrepo', ''])('%j は拒否', (raw) => {
    expect(() => parseRepositoryReference(raw)).toThrow(ReferenceParseError)
  })

  it('セグメントが不正でも参照エラーに包み、元の入力を持つ（Python の実出力）', () => {
    const error = thrownBy(() => parseRepositoryReference('a b/c'))
    expect(error.reference).toBe('a b/c')
    expect(error.message).toContain('1 validation error for RepoRef\nowner\n')
  })
})

describe('IssueReference', () => {
  const reference = createIssueReference(createRepositoryReference('o', 'r'), 42)

  it('文字列表現は o/r#42', () => {
    expect(issueReferenceToString(reference)).toBe('o/r#42')
  })

  it('CLI 用の参照は o/r/42', () => {
    expect(issueReferenceToCliReference(reference)).toBe('o/r/42')
  })

  it.each([0, -1])('番号 %d は検証エラー', (number) => {
    expect(() => createIssueReference(createRepositoryReference('o', 'r'), number)).toThrow(InvalidValueError)
  })
})

describe('extractReferencesIssueNumbers', () => {
  const pullRepository = createRepositoryReference('acme-labs', 'aist-plugin')
  const extract = (body: string | undefined): readonly number[] => [...extractReferencesIssueNumbers(body, pullRepository)].toSorted((a, b) => a - b)

  it('Refs #N', () => {
    expect(extract('変更内容\n\nRefs #935')).toEqual([935])
  })

  it('複数', () => {
    expect(extract('Refs #100\nRefs #200')).toEqual([100, 200])
  })

  it('Ref（単数）', () => {
    expect(extract('Ref #42')).toEqual([42])
  })

  it('大文字小文字を区別しない', () => {
    expect(extract('refs #10')).toEqual([10])
  })

  it('Refs が無ければ空', () => {
    expect(extract('本文のみ')).toEqual([])
  })

  it('本文が undefined・空なら空', () => {
    expect(extract(undefined)).toEqual([])
    expect(extract('')).toEqual([])
  })

  it('Fixes は拾わない', () => {
    expect(extract('Fixes #123')).toEqual([])
  })

  it('文中の Refs', () => {
    expect(extract('この変更は Refs #55 に関連')).toEqual([55])
  })

  it('Refs の直前が空白・行頭でなければ拾わない', () => {
    expect(extract('xRefs #7')).toEqual([])
  })

  it('コロン付き', () => {
    expect(extract('Refs: #171')).toEqual([171])
    expect(extract('Refs: #251 (Epic: #43)')).toEqual([251])
  })

  it('同じリポの owner/repo#N・owner/repo/N', () => {
    expect(extract('Refs: acme-labs/aist-plugin#227')).toEqual([227])
    expect(extract('Refs acme-labs/aist-plugin/228')).toEqual([228])
  })

  it('同じリポの判定は大文字小文字を区別しない', () => {
    expect(extract('Refs ACme-labs/AIST-Plugin#9')).toEqual([9])
  })

  it('他リポの参照は無視', () => {
    expect(extract('Refs acme-labs/pecot-presentation#264\nRefs other/aist-plugin/5')).toEqual([])
  })

  it('形式の混在', () => {
    expect(extract('Refs #1\nRef: acme-labs/aist-plugin#2\nRefs other/repo#3\nrefs acme-labs/aist-plugin/4')).toEqual([1, 2, 4])
  })

  it('# と owner/repo のどちらも無い番号は拾わない', () => {
    expect(extract('Refs 12')).toEqual([])
  })
})

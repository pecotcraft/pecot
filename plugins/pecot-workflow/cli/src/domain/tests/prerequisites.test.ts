import { describe, expect, it } from 'vitest'

import { InvalidValueError } from '../errors.js'
import { readWaitsForMerge, removeWaitsForMerge, upsertWaitsForMerge, WAITS_FOR_MERGE_HEADING } from '../prerequisites.js'
import { createIssueReference } from '../reference-parser.js'
import { createRepositoryReference } from '../repository-resolver.js'

const repository_ = createRepositoryReference('acme', 'app')
const other = createRepositoryReference('acme', 'other')
const reference = (number: number, repository = repository_): ReturnType<typeof createIssueReference> => createIssueReference(repository, number)

function sectionBody(...lines: readonly string[]): string {
  return [WAITS_FOR_MERGE_HEADING, '', ...lines].join('\n')
}

function section(lines: string): string {
  return `${WAITS_FOR_MERGE_HEADING}\r\n\r\n${lines}`
}

function lineOf(number: number, reason: string, repository = repository_): { ref: ReturnType<typeof reference>, reason: string } {
  return { ref: reference(number, repository), reason }
}

describe('readWaitsForMerge', () => {
  it('節が無い本文は absent を返す', () => {
    expect(readWaitsForMerge('## Goal\n\ntext', repository_)).toEqual({ kind: 'absent' })
    expect(readWaitsForMerge('', repository_)).toEqual({ kind: 'absent' })
  })

  it('同じリポは #N、別のリポは owner/repo#N で読む', () => {
    const body = sectionBody('- #1: 理由 A', '- acme/other#12: 理由 B')
    expect(readWaitsForMerge(body, repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, '理由 A'), lineOf(12, '理由 B', other)] })
  })

  it('同じリポを owner/repo#N で書いた行も読む', () => {
    expect(readWaitsForMerge(sectionBody('- acme/app#3: 理由'), repository_)).toEqual({ kind: 'ok', lines: [lineOf(3, '理由')] })
  })

  it('空行は読み飛ばし、見出しだけの節は行が空の ok になる', () => {
    expect(readWaitsForMerge(`${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n\n- #2: b\n`, repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, 'a'), lineOf(2, 'b')] })
    expect(readWaitsForMerge(WAITS_FOR_MERGE_HEADING, repository_)).toEqual({ kind: 'ok', lines: [] })
  })

  it('理由は最初の ": " で分け、後ろの ": " は理由に含める', () => {
    expect(readWaitsForMerge(sectionBody('- #1: a: b'), repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, 'a: b')] })
  })

  it('次の ## の見出しで節が終わり、### では終わらない', () => {
    const body = `${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n### 小見出し\n- #2: b\n## Next\n- not a line\n`
    expect(readWaitsForMerge(body, repository_).kind).toBe('malformed')
    const ended = `${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n## Next\nfree text\n`
    expect(readWaitsForMerge(ended, repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, 'a')] })
  })

  it('\\r\\n の本文も同じように読む', () => {
    const body = `## Goal\r\n\r\n${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #1: a\r\n- #2: b\r\n`
    expect(readWaitsForMerge(body, repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, 'a'), lineOf(2, 'b')] })
  })

  it.for([
    { name: '箇条書きでない行', line: 'text' },
    { name: '": " の無い行', line: '- #1' },
    { name: '": " の後ろが無い行', line: '- #1:' },
    { name: '理由が空白だけの行', line: '- #1:  ' },
    { name: '参照が # だけの行', line: '- #: a' },
    { name: '全角数字の参照', line: '- #１: a' },
    { name: '0 番の参照', line: '- #0: a' },
    { name: '安全な整数を超える番号', line: '- #99999999999999999999: a' },
    { name: 'owner だけの参照', line: '- acme/app: a' },
    { name: 'リポ名が . の参照', line: '- acme/.#1: a' },
  ])('$name があると malformed を返す', ({ line }) => {
    expect(readWaitsForMerge(sectionBody(line), repository_).kind).toBe('malformed')
  })

  it('同じ参照が 2 行あると malformed を返す', () => {
    expect(readWaitsForMerge(sectionBody('- #1: a', '- acme/app#1: b'), repository_).kind).toBe('malformed')
  })

  it('見出しが 2 つあると malformed を返す', () => {
    const body = `${sectionBody('- #1: a')}\n\n${sectionBody('- #2: b')}`
    expect(readWaitsForMerge(body, repository_).kind).toBe('malformed')
  })

  it('見出しと違う行は節の見出しとして扱わない', () => {
    expect(readWaitsForMerge('## Waits for merge now\n- text', repository_)).toEqual({ kind: 'absent' })
  })
})

describe('upsertWaitsForMerge', () => {
  it('節の無い本文は末尾に空行を挟んで節を足す', () => {
    expect(upsertWaitsForMerge('## Goal\n\ntext\n', repository_, reference(5), '理由')).toBe(`## Goal\n\ntext\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #5: 理由\n`)
  })

  it('末尾に改行の無い本文にも節を足す', () => {
    expect(upsertWaitsForMerge('text', repository_, reference(5), '理由')).toBe(`text\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #5: 理由\n`)
  })

  it('末尾が空行の本文には空行を足さない', () => {
    expect(upsertWaitsForMerge('text\n\n', repository_, reference(5), '理由')).toBe(`text\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #5: 理由\n`)
  })

  it('空の本文は節だけの本文になる', () => {
    expect(upsertWaitsForMerge('', repository_, reference(5), '理由')).toBe(`${WAITS_FOR_MERGE_HEADING}\n\n- #5: 理由\n`)
  })

  it('\\r\\n の本文には \\r\\n で足す', () => {
    expect(upsertWaitsForMerge('text\r\n', repository_, reference(5), '理由')).toBe(`text\r\n\r\n${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #5: 理由\r\n`)
  })

  it('別のリポの参照は owner/repo#N で書く', () => {
    expect(upsertWaitsForMerge('', repository_, reference(5, other), '理由')).toBe(`${WAITS_FOR_MERGE_HEADING}\n\n- acme/other#5: 理由\n`)
  })

  it('節がある本文は、最後の行の後ろに足し、後ろの節と空行は動かさない', () => {
    const before = `## Goal\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n## Artifacts\n\nend`
    const after = upsertWaitsForMerge(before, repository_, reference(2), 'b')
    expect(after).toBe(`## Goal\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n- #2: b\n\n## Artifacts\n\nend`)
  })

  it('見出しだけの節には見出しの直後に足す', () => {
    expect(upsertWaitsForMerge(`${WAITS_FOR_MERGE_HEADING}\n\n## Next\n`, repository_, reference(2), 'b')).toBe(`${WAITS_FOR_MERGE_HEADING}\n- #2: b\n\n## Next\n`)
  })

  it('節が本文の末尾で改行が無いときは、足した行も改行なしで終える', () => {
    expect(upsertWaitsForMerge(sectionBody('- #1: a'), repository_, reference(2), 'b')).toBe(sectionBody('- #1: a', '- #2: b'))
    expect(upsertWaitsForMerge(WAITS_FOR_MERGE_HEADING, repository_, reference(2), 'b')).toBe(`${WAITS_FOR_MERGE_HEADING}\n- #2: b`)
  })

  it('\\r\\n の節には \\r\\n で足す', () => {
    const before = `${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #1: a\r\n`
    expect(upsertWaitsForMerge(before, repository_, reference(2), 'b')).toBe(`${before}- #2: b\r\n`)
  })

  it('既にある参照を足すと、その行の理由を書き換える', () => {
    const before = `intro\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n- acme/other#2: b\n`
    expect(upsertWaitsForMerge(before, repository_, reference(1), 'new')).toBe(`intro\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: new\n- acme/other#2: b\n`)
  })

  it('owner/repo#N で書かれた同じリポの行も、同じ参照として書き換える', () => {
    expect(upsertWaitsForMerge(sectionBody('- acme/app#1: a'), repository_, reference(1), 'new')).toBe(sectionBody('- #1: new'))
  })

  it('節の外は 1 文字も変えない', () => {
    const head = '## Goal\r\n\r\ntext  \r\n\r\n'
    const tail = '\r\n## Artifacts\r\n\r\n- [ ] a \r\nend'
    const after = upsertWaitsForMerge(`${head}${section('- #1: a\r\n')}${tail}`, repository_, reference(2), 'b')
    expect(after.startsWith(head)).toBe(true)
    expect(after.endsWith(tail)).toBe(true)
    expect(after).toBe(`${head}${section('- #1: a\r\n- #2: b\r\n')}${tail}`)
  })

  it.for([
    { name: '空の理由', reason: '' },
    { name: '空白だけの理由', reason: '  ' },
    { name: '改行を含む理由', reason: 'a\nb' },
  ])('$name は拒否する', ({ reason }) => {
    expect(() => upsertWaitsForMerge('', repository_, reference(1), reason)).toThrow(InvalidValueError)
  })

  it('読めない節のある本文は書き換えずに拒否する', () => {
    expect(() => upsertWaitsForMerge(sectionBody('broken'), repository_, reference(1), 'a')).toThrow(InvalidValueError)
  })
})

describe('removeWaitsForMerge', () => {
  it('その参照の行だけを外す', () => {
    const before = `intro\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n- #2: b\n\n## Next\n`
    expect(removeWaitsForMerge(before, repository_, reference(1))).toBe(`intro\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #2: b\n\n## Next\n`)
  })

  it('末尾に改行の無い最後の行を外すと、前の行の改行も落とす', () => {
    expect(removeWaitsForMerge(sectionBody('- #1: a', '- #2: b'), repository_, reference(2))).toBe(sectionBody('- #1: a'))
  })

  it('最後の 1 行を外すと節ごと消し、本文の末尾なら手前の空行も消す', () => {
    expect(removeWaitsForMerge(`text\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n`, repository_, reference(1))).toBe('text\n')
  })

  it('節の後ろに別の節があるときは、その節の手前の空行を残して節だけを消す', () => {
    const before = `text\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n## Next\n\nend`
    expect(removeWaitsForMerge(before, repository_, reference(1))).toBe('text\n\n## Next\n\nend')
  })

  it('節だけの本文は空になる', () => {
    expect(removeWaitsForMerge(sectionBody('- #1: a'), repository_, reference(1))).toBe('')
  })

  it('無い参照を外しても本文を変えない', () => {
    const body = `x\n\n${sectionBody('- #1: a')}\n`
    expect(removeWaitsForMerge(body, repository_, reference(9))).toBe(body)
  })

  it('節が無い本文は変えない', () => {
    expect(removeWaitsForMerge('text', repository_, reference(1))).toBe('text')
  })

  it('\\r\\n の本文でも節の外を変えない', () => {
    const head = 'text\r\n\r\n'
    const tail = '## Next\r\nend'
    const before = `${head}${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #1: a\r\n- #2: b\r\n\r\n${tail}`
    expect(removeWaitsForMerge(before, repository_, reference(1))).toBe(`${head}${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #2: b\r\n\r\n${tail}`)
  })

  it('読めない節のある本文は拒否する', () => {
    expect(() => removeWaitsForMerge(sectionBody('broken'), repository_, reference(1))).toThrow(InvalidValueError)
  })
})

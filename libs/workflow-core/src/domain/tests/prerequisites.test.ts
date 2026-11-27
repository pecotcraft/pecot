import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
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
  it('節が存在しない本文を渡すと、absent を返す', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。本文に節が存在しない場合と、本文が空の場合に、`kind` が `absent` の結果を返すことを確認します。')
    expect(readWaitsForMerge('## Goal\n\ntext', repository_)).toEqual({ kind: 'absent' })
    expect(readWaitsForMerge('', repository_)).toEqual({ kind: 'absent' })
  })

  it('同じリポジトリの Issue は #N、別のリポジトリの Issue は owner/repo#N の形で読む', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。同じリポジトリの Issue を `#1`、別のリポジトリの Issue を `acme/other#12` の形で書いた場合に、それぞれ参照と理由を読み取ることを確認します。')
    const body = sectionBody('- #1: 理由 A', '- acme/other#12: 理由 B')
    expect(readWaitsForMerge(body, repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, '理由 A'), lineOf(12, '理由 B', other)] })
  })

  it('同じリポジトリの Issue を owner/repo#N の形で書いた行も読む', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。同じリポジトリの Issue を `acme/app#3` の形で書いた場合にも、参照と理由を読み取ることを確認します。')
    expect(readWaitsForMerge(sectionBody('- acme/app#3: 理由'), repository_)).toEqual({ kind: 'ok', lines: [lineOf(3, '理由')] })
  })

  it('空行は読み飛ばし、見出しだけの節は行が空の ok として返す', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。行の間に空行がある場合は無視して読み取り、見出しだけの節の場合は、`kind` が `ok` で `lines` が空の結果を返すことを確認します。')
    expect(readWaitsForMerge(`${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n\n- #2: b\n`, repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, 'a'), lineOf(2, 'b')] })
    expect(readWaitsForMerge(WAITS_FOR_MERGE_HEADING, repository_)).toEqual({ kind: 'ok', lines: [] })
  })

  it('理由は最初の ": " で区切り、後ろの ": " は理由に含める', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。`- #1: a: b` のように `: ` が複数ある行の場合に、最初の `: ` で参照と理由を区切り、残りを理由として読み取ることを確認します。')
    expect(readWaitsForMerge(sectionBody('- #1: a: b'), repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, 'a: b')] })
  })

  it('節は次の ## の見出しで終わり、### の見出しでは終わらない', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読み取る、`readWaitsForMerge` のテストです。次の `##` の見出しで節が終わって行が空になり、`###` の見出しは節の続きとして扱われて、箇条書きでない行として `malformed` になることを確認します。')
    const body = `${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n### 小見出し\n- #2: b\n## Next\n- not a line\n`
    expect(readWaitsForMerge(body, repository_).kind).toBe('malformed')
    const ended = `${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n## Next\nfree text\n`
    expect(readWaitsForMerge(ended, repository_)).toEqual({ kind: 'ok', lines: [lineOf(1, 'a')] })
  })

  it('改行が \\r\\n の本文も、同じように読む', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。改行が `\\r\\n` の本文の場合にも、`\\n` の本文と同じように行を読み取ることを確認します。')
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
  ])('$name がある場合は、malformed を返す', async ({ name, line }) => {
    await explains(`Issue の本文の \`## Waits for merge\` 節を読む、\`readWaitsForMerge\` のテストです。節に${name}がある場合に、\`kind\` が \`malformed\` の結果を返すことを確認します。`)
    expect(readWaitsForMerge(sectionBody(line), repository_).kind).toBe('malformed')
  })

  it('同じ参照の行が 2 行ある場合は、malformed を返す', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。`#1` と `acme/app#1` のように、同じ Issue を指す行が 2 行ある場合に、`kind` が `malformed` の結果を返すことを確認します。')
    expect(readWaitsForMerge(sectionBody('- #1: a', '- acme/app#1: b'), repository_).kind).toBe('malformed')
  })

  it('見出しが 2 つある場合は、malformed を返す', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。`## Waits for merge` の見出しが 2 つある場合に、`kind` が `malformed` の結果を返すことを確認します。')
    const body = `${sectionBody('- #1: a')}\n\n${sectionBody('- #2: b')}`
    expect(readWaitsForMerge(body, repository_).kind).toBe('malformed')
  })

  it('見出しと異なる行は、節の見出しとして扱わない', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。`## Waits for merge now` のように見出しの後ろへ文字が続く行は、節として扱わず、`absent` を返すことを確認します。')
    expect(readWaitsForMerge('## Waits for merge now\n- text', repository_)).toEqual({ kind: 'absent' })
  })
})

describe('upsertWaitsForMerge', () => {
  it('節が存在しない本文には、末尾に空行を挟んで節を追加する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。節が存在しない本文に行を追加する場合に、本文の末尾に空行を挟んで、見出しと追加した行を持つ節を追加することを確認します。')
    expect(upsertWaitsForMerge('## Goal\n\ntext\n', repository_, reference(5), '理由')).toBe(`## Goal\n\ntext\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #5: 理由\n`)
  })

  it('末尾に改行がない本文に追加した節は、改行なしで終える', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。末尾に改行がない本文に節を追加する場合に、追加した節の最後にも改行を付けないことを確認します。')
    expect(upsertWaitsForMerge('text', repository_, reference(5), '理由')).toBe(`text\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #5: 理由`)
  })

  it('末尾が空行の本文には、空行を追加しない', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。本文の末尾がすでに空行の場合に、節の前へ空行を重ねて追加しないことを確認します。')
    expect(upsertWaitsForMerge('text\n\n', repository_, reference(5), '理由')).toBe(`text\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #5: 理由\n`)
  })

  it('本文が空の場合は、節だけの本文にする', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。本文が空の場合に、見出しと追加した行だけの本文になることを確認します。')
    expect(upsertWaitsForMerge('', repository_, reference(5), '理由')).toBe(`${WAITS_FOR_MERGE_HEADING}\n\n- #5: 理由\n`)
  })

  it('改行が \\r\\n の本文には、\\r\\n で追加する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。改行が `\\r\\n` の本文に節を追加する場合に、追加する部分の改行も `\\r\\n` にすることを確認します。')
    expect(upsertWaitsForMerge('text\r\n', repository_, reference(5), '理由')).toBe(`text\r\n\r\n${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #5: 理由\r\n`)
  })

  it('別のリポジトリの Issue は、owner/repo#N の形で追加する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。別のリポジトリの Issue を追加する場合に、`- acme/other#5: 理由` のように owner とリポジトリ名を付けた形で書くことを確認します。')
    expect(upsertWaitsForMerge('', repository_, reference(5, other), '理由')).toBe(`${WAITS_FOR_MERGE_HEADING}\n\n- acme/other#5: 理由\n`)
  })

  it('節がある本文では、最後の行の後ろに追加し、後ろの節と空行を変更しない', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。節の後ろに別の節がある本文に行を追加する場合に、既存の最後の行の直後に追加し、後ろの節と空行をそのまま残すことを確認します。')
    const before = `## Goal\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n## Artifacts\n\nend`
    const after = upsertWaitsForMerge(before, repository_, reference(2), 'b')
    expect(after).toBe(`## Goal\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n- #2: b\n\n## Artifacts\n\nend`)
  })

  it('見出しだけの節には、見出しの直後に追加する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。行が 1 つもない節に行を追加する場合に、見出しの直後に追加することを確認します。')
    expect(upsertWaitsForMerge(`${WAITS_FOR_MERGE_HEADING}\n\n## Next\n`, repository_, reference(2), 'b')).toBe(`${WAITS_FOR_MERGE_HEADING}\n- #2: b\n\n## Next\n`)
  })

  it('節が改行なしで本文の末尾にある場合は、追加した行も改行なしで終える', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。節が本文の末尾にあり、末尾に改行がない場合に、追加した行の最後にも改行を付けないことを確認します。')
    expect(upsertWaitsForMerge(sectionBody('- #1: a'), repository_, reference(2), 'b')).toBe(sectionBody('- #1: a', '- #2: b'))
    expect(upsertWaitsForMerge(WAITS_FOR_MERGE_HEADING, repository_, reference(2), 'b')).toBe(`${WAITS_FOR_MERGE_HEADING}\n- #2: b`)
  })

  it('改行が \\r\\n の節には、\\r\\n で追加する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。改行が `\\r\\n` の節に行を追加する場合に、追加する行の改行も `\\r\\n` にすることを確認します。')
    const before = `${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #1: a\r\n`
    expect(upsertWaitsForMerge(before, repository_, reference(2), 'b')).toBe(`${before}- #2: b\r\n`)
  })

  it('節に存在する参照を追加した場合は、その行の理由を書き換える', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。すでに節に存在する Issue の参照を追加した場合に、行を増やさず、その行の理由だけを書き換えることを確認します。')
    const before = `intro\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n- acme/other#2: b\n`
    expect(upsertWaitsForMerge(before, repository_, reference(1), 'new')).toBe(`intro\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: new\n- acme/other#2: b\n`)
  })

  it('同じリポジトリを owner/repo#N の形で書いた行も、同じ参照として書き換える', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。`acme/app#1` の形で書かれた行に対して `#1` を追加した場合に、同じ Issue の行として理由を書き換え、行の書式を `#1` の形にそろえることを確認します。')
    expect(upsertWaitsForMerge(sectionBody('- acme/app#1: a'), repository_, reference(1), 'new')).toBe(sectionBody('- #1: new'))
  })

  it('節の外の本文は、変更しない', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。前後に別の節や空白を含む本文に行を追加する場合に、節より前と後ろの本文が 1 文字も変わらないことを確認します。')
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
  ])('$name の場合は、例外が発生する', async ({ name, reason }) => {
    await explains(`Issue の本文の \`## Waits for merge\` 節へ行を追加する、\`upsertWaitsForMerge\` のテストです。${name}を指定した場合に、\`InvalidValueError\` の例外が発生することを確認します。`)
    expect(() => upsertWaitsForMerge('', repository_, reference(1), reason)).toThrow(InvalidValueError)
  })

  it('読み取れない節がある本文は、書き換えずに例外が発生する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。節に箇条書きでない行があり、読み取れない場合に、本文を書き換えず `InvalidValueError` の例外が発生することを確認します。')
    expect(() => upsertWaitsForMerge(sectionBody('broken'), repository_, reference(1), 'a')).toThrow(InvalidValueError)
  })
})

describe('足して外すと元の本文に戻る', () => {
  it.for(['text\n', 'text\r\n', '', 'text', 'a\n\nb\n', 'a\r\n\r\nb'])('本文 %j に行を追加してから削除すると、元の本文に戻る', async (before) => {
    await explains(`Issue の本文の \`## Waits for merge\` 節へ行を追加する、\`upsertWaitsForMerge\` のテストです。本文 \`${JSON.stringify(before)}\` に行を追加し、続けて \`removeWaitsForMerge\` で同じ行を削除した場合に、元の本文に戻ることを確認します。`)
    const added = upsertWaitsForMerge(before, repository_, reference(1), 'a')
    expect(removeWaitsForMerge(added, repository_, reference(1))).toBe(before)
  })
})

describe('upsertWaitsForMerge の改行', () => {
  it('LF の本文に \\r\\n の行が含まれていても、追加位置の隣の行の改行で追加する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節へ行を追加する、`upsertWaitsForMerge` のテストです。改行が `\\n` の本文に `\\r\\n` の行が 1 つ含まれている場合に、追加する行の改行を追加位置の隣の行にそろえることを確認します。')
    const before = `${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n## Next\r\nnote\r\n`
    expect(upsertWaitsForMerge(before, repository_, reference(2), 'b')).toBe(`${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n- #2: b\n\n## Next\r\nnote\r\n`)
  })
})

describe('節の見出しの見分け', () => {
  it('コードフェンスの中の見出しも、節として読む', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。コードフェンスの中に見出しがある場合に、フェンスの行を箇条書きでない行として扱い、`malformed` を返すことを確認します。')
    const body = '```\n' + sectionBody('- #1: a') + '\n```\n'
    expect(readWaitsForMerge(body, repository_)).toEqual({ kind: 'malformed', reason: 'not a list item: ```' })
  })

  it('見出しの末尾に空白がある場合は、節として扱わず、追加すると別の節を作成する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節を読む、`readWaitsForMerge` のテストです。見出しの末尾に空白がある場合に、`absent` を返し、行を追加するときは既存の部分を残したまま新しい節を作成することを確認します。')
    const body = `${WAITS_FOR_MERGE_HEADING} \n\n- #1: a\n`
    expect(readWaitsForMerge(body, repository_)).toEqual({ kind: 'absent' })
    expect(upsertWaitsForMerge(body, repository_, reference(2), 'b')).toBe(`${body}\n${WAITS_FOR_MERGE_HEADING}\n\n- #2: b\n`)
  })
})

describe('removeWaitsForMerge', () => {
  it('指定した参照の行だけを削除する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。節に複数の行がある場合に、指定した参照の行だけを削除し、ほかの行と本文を変更しないことを確認します。')
    const before = `intro\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n- #2: b\n\n## Next\n`
    expect(removeWaitsForMerge(before, repository_, reference(1))).toBe(`intro\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #2: b\n\n## Next\n`)
  })

  it('末尾に改行がない最後の行を削除した場合は、前の行の改行も削除する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。末尾に改行がない最後の行を削除する場合に、前の行の末尾の改行も削除し、本文の末尾を改行なしにそろえることを確認します。')
    expect(removeWaitsForMerge(sectionBody('- #1: a', '- #2: b'), repository_, reference(2))).toBe(sectionBody('- #1: a'))
  })

  it('最後の 1 行を削除した場合は、節ごと削除し、本文の末尾なら手前の空行も削除する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。節の最後の行を削除した場合に、見出しを含む節全体を削除し、節が本文の末尾にあるときは手前の空行も削除することを確認します。')
    expect(removeWaitsForMerge(`text\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n`, repository_, reference(1))).toBe('text\n')
  })

  it('節の後ろに別の節がある場合は、後ろの節の手前の空行を残して、節だけを削除する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。節の後ろに別の節がある本文で最後の行を削除した場合に、節だけを削除し、後ろの節の手前の空行を残すことを確認します。')
    const before = `text\n\n${WAITS_FOR_MERGE_HEADING}\n\n- #1: a\n\n## Next\n\nend`
    expect(removeWaitsForMerge(before, repository_, reference(1))).toBe('text\n\n## Next\n\nend')
  })

  it('節だけの本文から最後の行を削除すると、本文が空になる', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。本文が節だけで、その最後の行を削除した場合に、本文が空文字になることを確認します。')
    expect(removeWaitsForMerge(sectionBody('- #1: a'), repository_, reference(1))).toBe('')
  })

  it('存在しない参照を指定しても、本文を変更しない', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。節に存在しない参照を指定した場合に、本文をそのまま返すことを確認します。')
    const body = `x\n\n${sectionBody('- #1: a')}\n`
    expect(removeWaitsForMerge(body, repository_, reference(9))).toBe(body)
  })

  it('節が存在しない本文は、変更しない', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。本文に節が存在しない場合に、本文をそのまま返すことを確認します。')
    expect(removeWaitsForMerge('text', repository_, reference(1))).toBe('text')
  })

  it('改行が \\r\\n の本文でも、節の外を変更しない', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。改行が `\\r\\n` の本文から行を削除した場合に、節より前と後ろの本文が変わらないことを確認します。')
    const head = 'text\r\n\r\n'
    const tail = '## Next\r\nend'
    const before = `${head}${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #1: a\r\n- #2: b\r\n\r\n${tail}`
    expect(removeWaitsForMerge(before, repository_, reference(1))).toBe(`${head}${WAITS_FOR_MERGE_HEADING}\r\n\r\n- #2: b\r\n\r\n${tail}`)
  })

  it('読み取れない節がある本文は、例外が発生する', async () => {
    await explains('Issue の本文の `## Waits for merge` 節から行を削除する、`removeWaitsForMerge` のテストです。節に箇条書きでない行があり、読み取れない場合に、`InvalidValueError` の例外が発生することを確認します。')
    expect(() => removeWaitsForMerge(sectionBody('broken'), repository_, reference(1))).toThrow(InvalidValueError)
  })
})

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import { bulletSection, definitionSection, examplesSection, HELP_OPTION, helpWidth, paragraph, usageLines } from '../help-layout.js'
import { cellLength } from '@pecot/workflow-core/commands-shared/rich-panel.js'

describe('definitionSection', () => {
  const rows = [
    { name: '-b, --base <str>', description: 'Base branch (default: chosen by readiness, else develop_branch from the config)' },
    { name: '-F, --force-overwrite-active', description: 'Disable the guard' },
  ]

  it('名前の列を、字下げ 2 桁・最長の名前・間 2 桁で取り、説明を並べる', async () => {
    await explains('名前と説明を 2 列に並べる `definitionSection` のテストです。幅 80 の場合に、名前の列の幅を最長の名前に合わせ、説明を同じ位置から並べ、長い説明は列の位置で折り返すことを確認します。')
    expect(definitionSection('Options', rows, 80)).toBe([
      'Options:',
      '  -b, --base <str>              Base branch (default: chosen by readiness, else',
      '                                develop_branch from the config)',
      '  -F, --force-overwrite-active  Disable the guard',
    ].join('\n'))
  })

  it('説明の幅が 32 桁を下回る場合は、節のすべての項目で説明を次の行（6 桁字下げ）に表示する', async () => {
    await explains('幅 40 で表示した `definitionSection` のテストです。説明の幅が 32 桁を下回るため、節のすべての項目で説明を名前の次の行に 6 桁字下げして表示することを確認します。')
    expect(definitionSection('Options', rows, 40)).toBe([
      'Options:',
      '  -b, --base <str>',
      '      Base branch (default: chosen by',
      '      readiness, else develop_branch',
      '      from the config)',
      '  -F, --force-overwrite-active',
      '      Disable the guard',
    ].join('\n'))
  })

  it('説明の幅がちょうど 32 桁の場合は、名前と説明を同じ行に並べる', async () => {
    await explains('説明の幅が 32 桁になる境界のテストです。全体の幅が 39 の場合は名前と説明を同じ行に並べ、38 の場合は説明を次の行に表示することを確認します。')
    const exact = [{ name: 'abc', description: 'x'.repeat(32) }]
    // 2 + 3 + 2 + 32 = 39
    expect(definitionSection('T', exact, 39)).toBe(`T:\n  abc  ${'x'.repeat(32)}`)
    expect(definitionSection('T', exact, 38)).toBe(`T:\n  abc\n      ${'x'.repeat(32)}`)
  })

  it('説明が空の場合は、行末に空白を付けず、名前だけの行にする', async () => {
    await explains('説明が空の項目を持つ `definitionSection` のテストです。その項目が名前だけの行になり、行末に空白が含まれないことを確認します。')
    expect(definitionSection('T', [{ name: 'a', description: '' }, { name: 'bb', description: 'x' }], 80)).toBe('T:\n  a\n  bb  x')
    expect(definitionSection('T', [{ name: 'a', description: '' }], 20)).toBe('T:\n  a')
  })

  it('全角文字の説明は、表示の幅で数えて折り返す', async () => {
    await explains('全角文字の説明を持つ `definitionSection` のテストです。幅 40 の場合に、全角文字を 2 桁として数え、どの行も 40 桁以内に折り返し、文字が欠けないことを確認します。')
    const text = definitionSection('T', [{ name: 'a', description: 'あ'.repeat(30) }], 40)
    const lines = text.split('\n').slice(1)
    expect(lines.every(line => cellLength(line) <= 40)).toBe(true)
    expect(lines.join('').replaceAll(' ', '')).toBe(`a${'あ'.repeat(30)}`)
  })

  it('幅に収まらない名前は切り捨てず、説明を次の行に表示して、名前を幅で折り返す', async () => {
    await explains('幅 30 に収まらない長い名前を持つ `definitionSection` のテストです。名前を切り捨てずに幅で折り返し、どの行も 30 桁以内で、名前と説明の文字がすべて残ることを確認します。')
    const text = definitionSection('T', [{ name: `--${'x'.repeat(50)}`, description: 'd' }], 30)
    expect(text.split('\n').every(line => line.length <= 30)).toBe(true)
    expect(text.replaceAll(/\s/gu, '')).toBe(`T:--${'x'.repeat(50)}d`)
  })

  it('--help の行は、共通の名前と説明を持つ', async () => {
    await explains('共通で使う `--help` の定義 `HELP_OPTION` のテストです。名前が `--help`、説明が `Show this message and exit.` であることを確認します。')
    expect(HELP_OPTION).toEqual({ name: '--help', description: 'Show this message and exit.' })
  })
})

describe('usageLines', () => {
  it('幅に収まる場合は、Usage を 1 行で表示する', async () => {
    await explains('Usage の行を作成する `usageLines` のテストです。幅 80 に収まる場合は、`Usage: pecot a [OPTIONS]` の 1 行になることを確認します。')
    expect(usageLines('pecot a [OPTIONS]', 80)).toBe('Usage: pecot a [OPTIONS]')
  })

  it('幅に収まらない場合は、続きの行を 7 桁字下げして折り返す', async () => {
    await explains('Usage の行を作成する `usageLines` のテストです。幅 40 に収まらない場合は、続きの行を 7 桁字下げして折り返すことを確認します。')
    expect(usageLines('pecot session start [OPTIONS] <issue_ref> <branch_name>', 40)).toBe('Usage: pecot session start [OPTIONS]\n       <issue_ref> <branch_name>')
  })
})

describe('paragraph', () => {
  it('幅で折り返し、行末に空白を含めない', async () => {
    await explains('文章を幅で折り返す `paragraph` のテストです。幅 8 の場合に、`aaa bbb ccc` が `aaa bbb` と `ccc` の 2 行になり、行末に空白が残らないことを確認します。')
    expect(paragraph('aaa bbb ccc', 8)).toBe('aaa bbb\nccc')
  })
})

describe('bulletSection', () => {
  it('"- " の箇条書きにし、折り返した続きの行を 4 桁字下げする', async () => {
    await explains('箇条書きの節を作成する `bulletSection` のテストです。各項目を `- ` で始め、折り返した続きの行を 4 桁字下げすることを確認します。')
    expect(bulletSection('Details', ['one two three four', 'five'], 14)).toBe('Details:\n  - one two\n    three four\n  - five')
  })
})

describe('examplesSection', () => {
  it('実行するコマンドは折り返さず、説明を 6 桁字下げして折り返す', async () => {
    await explains('実行例の節を作成する `examplesSection` のテストです。幅 40 を超えるコマンドは折り返さず、説明は 6 桁字下げして折り返すことを確認します。')
    const run = 'pecot session start example-org/my-repo/123 feat/my-change --dry-run'
    expect(examplesSection([{ run, note: 'Show what would be created without writing anything.' }], 40)).toBe([
      'Examples:',
      `  ${run}`,
      '      Show what would be created without',
      '      writing anything.',
    ].join('\n'))
  })
})

describe('幅より長い語の折り返し', () => {
  const status = '(backlog/pending/blocked/ready/active/in_review/archived)'

  it('`/` の後ろを折り返せる位置にして、語の途中では折り返さない', async () => {
    await explains('幅より長い語を含む文章を折り返す `paragraph` のテストです。`(backlog/pending/…)` のような語を、`/` の直後で折り返し、語の途中では折り返さないことを確認します。')
    expect(paragraph(`Status ${status} Decided by the type`, 30)).toBe([
      'Status',
      '(backlog/pending/blocked/',
      'ready/active/in_review/',
      'archived) Decided by the type',
    ].join('\n'))
  })

  it('幅より長い語が先頭にある場合は、前に空行を入れない', async () => {
    await explains('幅より長い語だけの文章を折り返す `paragraph` のテストです。語が行頭にある場合は、空行を入れず、`/` の直後で折り返すことを確認します。')
    expect(paragraph(status, 30)).toBe('(backlog/pending/blocked/\nready/active/in_review/\narchived)')
  })

  it('`/` で区切った塊を幅まで詰め、それでも入らない塊と、`/` を含まない語だけを幅で折り返す', async () => {
    await explains('`/` で区切った塊を含む語を折り返す `paragraph` のテストです。塊は行の幅までまとめて並べ、1 つで幅を超える塊と `/` を含まない長い語だけを、幅で折り返すことを確認します。')
    expect(paragraph(`a/${'x'.repeat(12)}/b`, 8)).toBe(`a/\n${'x'.repeat(8)}\n${'x'.repeat(4)}/\nb`)
    expect(paragraph('y'.repeat(12), 8)).toBe(`${'y'.repeat(8)}\n${'y'.repeat(4)}`)
  })

  it('幅に収まる語は、`/` を含んでいても折り返さない', async () => {
    await explains('`/` を含む短い語を折り返す `paragraph` のテストです。幅 80 に収まる場合は、`a/b c/d` を折り返さず、そのまま返すことを確認します。')
    expect(paragraph('a/b c/d', 80)).toBe('a/b c/d')
  })

  it('definitionSection の説明も、paragraph と同じ折り返し方にする', async () => {
    await explains('長い語を含む説明を持つ `definitionSection` のテストです。説明を `/` の直後で折り返し、どの行も幅 60 以内になることを確認します。')
    const text = definitionSection('Options', [{ name: '--status <str>', description: `Status ${status} Decided by the type` }], 60)
    expect(text.split('\n').slice(1).every(line => line.length <= 60)).toBe(true)
    expect(text).toContain('(backlog/pending/blocked/ready/active/\n')
  })
})

describe('空の要素', () => {
  it('bulletSection の空の項目は、行末に空白を含めない', async () => {
    await explains('空の項目を持つ `bulletSection` のテストです。その項目が `  -` の行になり、行末に空白が含まれないことを確認します。')
    expect(bulletSection('T', [''], 80)).toBe('T:\n  -')
  })

  it('examplesSection の空の note は、説明の行を表示しない', async () => {
    await explains('説明（`note`）が空の例を持つ `examplesSection` のテストです。空の `note` の説明の行を表示せず、コマンドの行だけを表示することを確認します。')
    expect(examplesSection([{ run: 'pecot a', note: '' }, { run: 'pecot b', note: 'B.' }], 80)).toBe('Examples:\n  pecot a\n  pecot b\n      B.')
  })
})

describe('helpWidth', () => {
  it('ヘルプの幅は、40 を下限にする', async () => {
    await explains('ヘルプの幅を決める `helpWidth` のテストです。`5` を渡すと `40` を返し、`40` と `120` はそのままの値を返すことを確認します。')
    expect(helpWidth(5)).toBe(40)
    expect(helpWidth(40)).toBe(40)
    expect(helpWidth(120)).toBe(120)
  })
})

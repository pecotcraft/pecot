import { describe, expect, it } from 'vitest'

import { bulletSection, definitionSection, examplesSection, HELP_OPTION, paragraph, usageLines } from '../help-layout.js'
import { cellLength } from '../rich-panel.js'

describe('definitionSection', () => {
  const rows = [
    { name: '-b, --base <str>', description: 'Base branch (default: develop_branch from the config)' },
    { name: '-F, --force-overwrite-active', description: 'Disable the guard' },
  ]

  it('名前の列を「字下げ 2 + 最長の名前 + 間 2」で取り、説明を並べる', () => {
    expect(definitionSection('Options', rows, 80)).toBe([
      'Options:',
      '  -b, --base <str>              Base branch (default: develop_branch from the',
      '                                config)',
      '  -F, --force-overwrite-active  Disable the guard',
    ].join('\n'))
  })

  it('説明の幅が 32 桁を切るなら、節の全行で説明を次の行（字下げ 6）に下げる', () => {
    expect(definitionSection('Options', rows, 40)).toBe([
      'Options:',
      '  -b, --base <str>',
      '      Base branch (default:',
      '      develop_branch from the config)',
      '  -F, --force-overwrite-active',
      '      Disable the guard',
    ].join('\n'))
  })

  it('説明の幅がちょうど 32 桁なら列のまま並べる', () => {
    const exact = [{ name: 'abc', description: 'x'.repeat(32) }]
    // 2 + 3 + 2 + 32 = 39
    expect(definitionSection('T', exact, 39)).toBe(`T:\n  abc  ${'x'.repeat(32)}`)
    expect(definitionSection('T', exact, 38)).toBe(`T:\n  abc\n      ${'x'.repeat(32)}`)
  })

  it('説明が空なら名前だけの行にする（行末の空白なし）', () => {
    expect(definitionSection('T', [{ name: 'a', description: '' }, { name: 'bb', description: 'x' }], 80)).toBe('T:\n  a\n  bb  x')
    expect(definitionSection('T', [{ name: 'a', description: '' }], 20)).toBe('T:\n  a')
  })

  it('全角の説明も幅で数えて折り返す', () => {
    const text = definitionSection('T', [{ name: 'a', description: 'あ'.repeat(30) }], 40)
    const lines = text.split('\n').slice(1)
    expect(lines.every(line => cellLength(line) <= 40)).toBe(true)
    expect(lines.join('').replaceAll(' ', '')).toBe(`a${'あ'.repeat(30)}`)
  })

  it('入らない名前も切らない。説明を下げた形で、名前を幅で折る', () => {
    const text = definitionSection('T', [{ name: `--${'x'.repeat(50)}`, description: 'd' }], 30)
    expect(text.split('\n').every(line => line.length <= 30)).toBe(true)
    expect(text.replaceAll(/\s/gu, '')).toBe(`T:--${'x'.repeat(50)}d`)
  })

  it('--help の行は共通', () => {
    expect(HELP_OPTION).toEqual({ name: '--help', description: 'Show this message and exit.' })
  })
})

describe('usageLines', () => {
  it('収まれば 1 行', () => {
    expect(usageLines('pecot a [OPTIONS]', 80)).toBe('Usage: pecot a [OPTIONS]')
  })

  it('続きの行を 7 桁下げる', () => {
    expect(usageLines('pecot create-branch [OPTIONS] <issue_ref> <branch_name>', 40)).toBe('Usage: pecot create-branch [OPTIONS]\n       <issue_ref> <branch_name>')
  })
})

describe('paragraph', () => {
  it('幅で折り返し、行末の空白を残さない', () => {
    expect(paragraph('aaa bbb ccc', 8)).toBe('aaa bbb\nccc')
  })
})

describe('bulletSection', () => {
  it('"- " の箇条書きにし、続きの行を 4 桁下げる', () => {
    expect(bulletSection('Details', ['one two three four', 'five'], 14)).toBe('Details:\n  - one two\n    three four\n  - five')
  })
})

describe('examplesSection', () => {
  it('打つ形は折り返さず、説明を字下げ 6 で折り返す', () => {
    const run = 'pecot create-branch example-org/my-repo/123 feat/my-change --allow-cross-repo'
    expect(examplesSection([{ run, note: 'Create the branch from a directory that is not a checkout.' }], 40)).toBe([
      'Examples:',
      `  ${run}`,
      '      Create the branch from a directory',
      '      that is not a checkout.',
    ].join('\n'))
  })
})

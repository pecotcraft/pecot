import { describe, expect, it } from 'vitest'

import { readGolden, scenarioIds } from '../../../tests/parity/scenario.js'
import { InvalidValueError } from '../../domain/errors.js'
import { parseOwnerRepository } from '../../domain/repository-resolver.js'
import { invalidRepositoryMessage } from '../global-options.js'
import { cellLength, outputWidth, renderPanel, wrapText } from '../rich-panel.js'
import {
  formatUsageError,
  invalidValueMessage,
  missingArgumentMessage,
  missingOptionMessage,
  noSuchCommandMessage,
  noSuchOptionMessage,
  optionRequiresArgumentMessage,
  optionTakesNoValueMessage,
  UsageError,
} from '../usage-error.js'

const ROOT = { commandPath: [], synopsis: '[OPTIONS] COMMAND [ARGS]...' }

describe('golden の usage エラー', () => {
  // グローバルオプションの誤り（global-）は文が複数行になるので、下の個別のケースで確かめる
  const ids = scenarioIds().filter(id => !id.startsWith('global-') && readGolden(id).stderr.startsWith('Usage: '))

  it('golden から 16 件を読む', () => {
    expect(ids).toHaveLength(16)
  })

  it.for(ids)('%s の stderr を文字単位で再現する', (id) => {
    const { stderr } = readGolden(id)
    const lines = stderr.split('\n', 4)
    const program = (lines.at(0) ?? '').replace(/^Usage: /u, '').split(' ')
    const optionsAt = program.indexOf('[OPTIONS]')
    const message = (lines.at(3) ?? '').replace(/^│ /u, '').replace(/ *│$/u, '')
    const error = new UsageError(message, {
      commandPath: program.slice(1, optionsAt),
      synopsis: program.slice(optionsAt).join(' '),
    })
    expect(program.at(0)).toBe('pecot')
    expect(formatUsageError(error)).toBe(stderr)
  })
})

describe('メッセージ', () => {
  it('click の文言になる', () => {
    expect(missingArgumentMessage('ISSUE_REF')).toBe('Missing argument \'ISSUE_REF\'.')
    expect(missingOptionMessage(['--directory', '-D'])).toBe('Missing option \'--directory\' / \'-D\'.')
    expect(missingOptionMessage(['--suffix'])).toBe('Missing option \'--suffix\'.')
    expect(noSuchOptionMessage('--bogus')).toBe('No such option: --bogus')
    expect(noSuchOptionMessage('--show-rep', ['--show-repo', '--repo', '--help'])).toBe('No such option: --show-rep (Possible options: --help, --repo, --show-repo)')
    expect(noSuchCommandMessage('nosuch')).toBe('No such command \'nosuch\'.')
    expect(noSuchCommandMessage('reed', ['read', 'reopen', 'create'])).toBe('No such command \'reed\'. Did you mean \'read\', \'reopen\', \'create\'?')
    expect(optionRequiresArgumentMessage('--repo')).toBe('Option \'--repo\' requires an argument.')
    expect(optionTakesNoValueMessage('--version')).toBe('Option \'--version\' does not take a value.')
    expect(invalidValueMessage('--repo', 'x')).toBe('Invalid value for \'--repo\': x')
    expect(invalidValueMessage(['--comment-limit', '-c'], 'x')).toBe('Invalid value for \'--comment-limit\' / \'-c\': x')
  })
})

// 括弧の中の文は、domain の解析が投げた例外の文をそのまま使う。期待値は Python の実出力（golden）
function repositoryError(value: string): string {
  try {
    parseOwnerRepository(value)
  }
  catch (error: unknown) {
    if (error instanceof InvalidValueError) return formatUsageError(new UsageError(invalidRepositoryMessage(error.message), ROOT))
    throw error
  }
  throw new Error('例外が投げられませんでした')
}

describe('formatUsageError', () => {
  it('context が無ければ枠だけを出す', () => {
    const error = new UsageError(optionRequiresArgumentMessage('--repo'))
    expect(formatUsageError(error)).toBe(`╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ Option '--repo' requires an argument.                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
`)
  })

  it('グループの Usage 行を出す', () => {
    const error = new UsageError(noSuchCommandMessage('nosuch'), { commandPath: ['issue'], synopsis: '[OPTIONS] COMMAND [ARGS]...' })
    expect(formatUsageError(error).split('\n').slice(0, 2)).toEqual([
      'Usage: pecot issue [OPTIONS] COMMAND [ARGS]...',
      'Try \'pecot issue --help\' for help.',
    ])
  })

  it.for([
    ['global-usage-bad-repo', 'bad'],
    ['global-usage-bad-repo-segment', '日本語/b'],
    ['global-usage-bad-repo-folded', `${Array.from({ length: 45 }, (_, index) => String.fromCodePoint(0x1_F6_00 + (index % 40))).join('')}/b`],
  ])('--repo の不正な値は枠の中で折り返す: %s', ([id = '', value = '']) => {
    expect(repositoryError(value)).toBe(readGolden(id).stderr)
  })
})

describe('rich-panel', () => {
  it('cellLength は全角を 2、結合文字を 0 で数える', () => {
    expect(cellLength('abc')).toBe(3)
    expect(cellLength('日本')).toBe(4)
    expect(cellLength('é')).toBe(1)
    expect(cellLength('\u{200B}')).toBe(0)
    expect(cellLength('😀')).toBe(2)
  })

  it('wrapText は幅に収まる単語を次の行へ送る。後ろの空白は幅の中なら残す', () => {
    expect(wrapText('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
    expect(wrapText('aaa bbb ccc', 8)).toEqual(['aaa bbb ', 'ccc'])
    expect(wrapText('', 7)).toEqual([''])
    expect(wrapText('a\n\nb', 7)).toEqual(['a', '', 'b'])
  })

  it('wrapText は先頭の空白を語に含める', () => {
    expect(wrapText('  abc def', 6)).toEqual(['  abc ', 'def'])
  })

  it('wrapText は長い語を幅で折り、全角が半端に入らなければ次の行へ送る', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapText('日本語', 5)).toEqual(['日本', '語'])
  })

  it('wrapText は行の途中の長い語の前で改行する', () => {
    expect(wrapText('ab cdefghij', 4)).toEqual(['ab ', 'cdef', 'ghij'])
  })

  // 期待値は rich 15 の cell_len と Text.wrap の実出力
  it('cellLength は rich の表と同じ。主な範囲の外の文字も数える', () => {
    expect(cellLength('\u{26A1}')).toBe(2)
    expect(cellLength('\u{1F7E0}')).toBe(2)
    expect(cellLength('\u{00AD}')).toBe(1)
    expect(cellLength('a\u{00AD}b')).toBe(3)
    expect(cellLength('\u{7}')).toBe(0)
  })

  it('cellLength は異体字セレクタで 2 セルになる文字と、ゼロ幅接合子でつないだ絵文字を数える', () => {
    expect(cellLength('\u{2764}')).toBe(1)
    expect(cellLength('\u{2764}\u{FE0F}')).toBe(2)
    expect(cellLength('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).toBe(2)
  })

  it('cellLength は先頭の異体字セレクタ・末尾のゼロ幅接合子・結合文字を数える', () => {
    expect(cellLength('\u{200D}')).toBe(0)
    expect(cellLength('\u{FE0F}a')).toBe(1)
    expect(cellLength('a\u{200D}')).toBe(1)
    expect(cellLength('\u{301}a')).toBe(1)
    expect(cellLength('\u{4E2D}\u{FE0F}')).toBe(2)
    expect(cellLength('x\u{2764}\u{FE0F}\u{2764}\u{FE0F}y')).toBe(6)
  })

  it('wrapText は字素ごとに折る', () => {
    expect(wrapText('x\u{2764}\u{FE0F}\u{2764}\u{FE0F}y', 2)).toEqual(['x', '\u{2764}\u{FE0F}', '\u{2764}\u{FE0F}', 'y'])
    expect(wrapText('a\u{301}b', 1)).toEqual(['a\u{301}', 'b'])
    expect(wrapText('\u{301}\u{301}a', 1)).toEqual(['\u{301}\u{301}a'])
    expect(wrapText('\u{FE0F}a', 1)).toEqual(['\u{FE0F}a'])
    expect(wrapText('a\u{200D}', 1)).toEqual(['a\u{200D}'])
  })

  it('wrapText は 2 セルの字素が 1 セルに入らなければ空白にする', () => {
    expect(wrapText('\u{2764}\u{FE0F}', 1)).toEqual([' '])
    expect(wrapText('日', 1)).toEqual([' '])
  })

  it('wrapText の ellipsis は、長すぎる語を切って末尾を … にする。2 セルの文字の途中なら空白で埋める', () => {
    expect(wrapText('あいう', 4, 'ellipsis')).toEqual(['あ …'])
    expect(wrapText('a\u{2764}\u{FE0F}b', 3, 'ellipsis')).toEqual(['a …'])
    expect(wrapText('abc', 1, 'ellipsis')).toEqual(['…'])
    expect(wrapText('ab cdefghij kl', 5, 'ellipsis')).toEqual(['ab ', 'cdef…', 'kl'])
  })

  it('wrapText は幅を超える末尾の空白だけを落とす', () => {
    expect(wrapText('abc   ', 4)).toEqual(['abc '])
    expect(wrapText('abcd  ', 4)).toEqual(['abcd'])
  })

  it('outputWidth は TERMINAL_WIDTH、COLUMNS、端末の幅、80 の順で決める', () => {
    expect(outputWidth({ TERMINAL_WIDTH: '60', COLUMNS: '50' }, 40)).toBe(60)
    expect(outputWidth({ COLUMNS: '50' }, 40)).toBe(50)
    expect(outputWidth({}, 40)).toBe(40)
    expect(outputWidth({}, undefined)).toBe(80)
    expect(outputWidth({ COLUMNS: 'abc', TERMINAL_WIDTH: '0' }, undefined)).toBe(80)
    expect(outputWidth({ COLUMNS: '3' }, undefined)).toBe(10)
  })

  it('renderPanel は本文を幅まで空白で埋める', () => {
    expect(renderPanel('T', 'ab', 12)).toBe('╭─ T ──────╮\n│ ab       │\n╰──────────╯\n')
  })
})

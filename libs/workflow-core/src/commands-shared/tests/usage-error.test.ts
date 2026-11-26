// usage エラーの文と枠、枠の中の折り返し（rich の規則）を確かめる。golden と並べる確かめは cli の usage-error.test.ts にある
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

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

describe('メッセージ', () => {
  it('usage エラーのメッセージは、Python の CLI ライブラリ click と同じ文言で作成する', async () => {
    await explains('usage エラーのメッセージを作成する関数群のテストです。引数・オプション・コマンドの不足や誤りに対して、click と同じ英語の文言が作成されることを確認します。')
    expect(missingArgumentMessage('issue_ref')).toBe('Missing argument \'issue_ref\'.')
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

describe('formatUsageError', () => {
  it('context を指定しない場合は、Usage 行を付けず、枠だけを出力する', async () => {
    await explains('`formatUsageError` で `context` を指定しない場合のテストです。`Usage:` の行を付けず、`Error` の枠に囲んだメッセージだけを出力することを確認します。')
    const error = new UsageError(optionRequiresArgumentMessage('--repo'))
    expect(formatUsageError(error)).toBe(`╭─ Error ──────────────────────────────────────────────────────────────────────╮
│ Option '--repo' requires an argument.                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
`)
  })

  it('context にコマンドのパスを指定した場合は、Usage 行と --help の案内を出力する', async () => {
    await explains('コマンドのパス（`issue`）と synopsis を指定した場合のテストです。出力の先頭 2 行が、`Usage: pecot issue …` の行と `--help` の案内になることを確認します。')
    const error = new UsageError(noSuchCommandMessage('nosuch'), { commandPath: ['issue'], synopsis: '[OPTIONS] COMMAND [ARGS]...' })
    expect(formatUsageError(error).split('\n').slice(0, 2)).toEqual([
      'Usage: pecot issue [OPTIONS] COMMAND [ARGS]...',
      'Try \'pecot issue --help\' for help.',
    ])
  })
})

describe('rich-panel', () => {
  it('cellLength は、全角の文字を 2 セル、結合文字を 0 セルとして数える', async () => {
    await explains('文字列の表示幅を求める関数（`cellLength`）のテストです。半角は 1 セル、全角と絵文字は 2 セル、結合文字とゼロ幅の文字は 0 セルになることを確認します。')
    expect(cellLength('abc')).toBe(3)
    expect(cellLength('日本')).toBe(4)
    expect(cellLength('é')).toBe(1)
    expect(cellLength('\u{200B}')).toBe(0)
    expect(cellLength('😀')).toBe(2)
  })

  it('wrapText は、幅を超える単語を次の行へ送り、行末の空白は幅に収まる場合だけ残す', async () => {
    await explains('文字列を指定した幅で折り返す関数（`wrapText`）のテストです。幅を超える単語が次の行へ移り、行末の空白は幅に収まる場合だけ残り、空文字と空行が保持されることを確認します。')
    expect(wrapText('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
    expect(wrapText('aaa bbb ccc', 8)).toEqual(['aaa bbb ', 'ccc'])
    expect(wrapText('', 7)).toEqual([''])
    expect(wrapText('a\n\nb', 7)).toEqual(['a', '', 'b'])
  })

  it('wrapText は、先頭の空白を単語の一部として扱う', async () => {
    await explains('先頭に空白がある文字列を、`wrapText` で折り返す場合のテストです。先頭の空白が最初の単語に含まれて折り返されることを確認します。')
    expect(wrapText('  abc def', 6)).toEqual(['  abc ', 'def'])
  })

  it('wrapText は、幅より長い単語を幅で折り返し、全角の文字が行末に収まらない場合は次の行へ送る', async () => {
    await explains('幅より長い単語を折り返す場合のテストです。単語が幅ごとに分割され、全角の文字が行末に収まらないときは次の行へ送られることを確認します。')
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapText('日本語', 5)).toEqual(['日本', '語'])
  })

  it('wrapText は、行の途中にある長い単語の前で改行する', async () => {
    await explains('行の途中に幅より長い単語がある場合のテストです。その単語の前で改行し、単語が幅ごとに分割されることを確認します。')
    expect(wrapText('ab cdefghij', 4)).toEqual(['ab ', 'cdef', 'ghij'])
  })

  // 期待値は rich 15 の cell_len と Text.wrap の実出力
  it('cellLength は、主な範囲の外の文字についても、Python の rich の表と同じ幅を返す', async () => {
    await explains('表示幅を求める関数（`cellLength`）のテストです。絵文字・ソフトハイフン・制御文字など主な範囲の外の文字について、rich の `cell_len` と同じ値を返すことを確認します。')
    expect(cellLength('\u{26A1}')).toBe(2)
    expect(cellLength('\u{1F7E0}')).toBe(2)
    expect(cellLength('\u{00AD}')).toBe(1)
    expect(cellLength('a\u{00AD}b')).toBe(3)
    expect(cellLength('\u{7}')).toBe(0)
  })

  it('cellLength は、異体字セレクタで 2 セルになる文字と、ゼロ幅接合子でつないだ絵文字の幅を求める', async () => {
    await explains('異体字セレクタとゼロ幅接合子を含む文字列のテストです。異体字セレクタで 2 セルになる文字と、ゼロ幅接合子でつないだ絵文字が、それぞれ 2 セルとして数えられることを確認します。')
    expect(cellLength('\u{2764}')).toBe(1)
    expect(cellLength('\u{2764}\u{FE0F}')).toBe(2)
    expect(cellLength('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).toBe(2)
  })

  it('cellLength は、先頭の異体字セレクタ・末尾のゼロ幅接合子・結合文字を含む文字列の幅を求める', async () => {
    await explains('位置が特殊な異体字セレクタ・ゼロ幅接合子・結合文字を含む文字列のテストです。文字列の先頭や末尾に置いた場合でも、期待する幅を返すことを確認します。')
    expect(cellLength('\u{200D}')).toBe(0)
    expect(cellLength('\u{FE0F}a')).toBe(1)
    expect(cellLength('a\u{200D}')).toBe(1)
    expect(cellLength('\u{301}a')).toBe(1)
    expect(cellLength('\u{4E2D}\u{FE0F}')).toBe(2)
    expect(cellLength('x\u{2764}\u{FE0F}\u{2764}\u{FE0F}y')).toBe(6)
  })

  it('wrapText は、字素（見た目の 1 文字）を分割せずに折り返す', async () => {
    await explains('結合文字や異体字セレクタを含む文字列を折り返す場合のテストです。見た目の 1 文字（字素）の途中では分割されないことを確認します。')
    expect(wrapText('x\u{2764}\u{FE0F}\u{2764}\u{FE0F}y', 2)).toEqual(['x', '\u{2764}\u{FE0F}', '\u{2764}\u{FE0F}', 'y'])
    expect(wrapText('a\u{301}b', 1)).toEqual(['a\u{301}', 'b'])
    expect(wrapText('\u{301}\u{301}a', 1)).toEqual(['\u{301}\u{301}a'])
    expect(wrapText('\u{FE0F}a', 1)).toEqual(['\u{FE0F}a'])
    expect(wrapText('a\u{200D}', 1)).toEqual(['a\u{200D}'])
  })

  it('wrapText は、2 セルの字素が 1 セルの幅に収まらない場合は、空白に置き換える', async () => {
    await explains('幅が 1 セルのときに、2 セルの字素（異体字セレクタ付きの記号や全角の文字）を折り返す場合のテストです。字素を空白 1 つに置き換えることを確認します。')
    expect(wrapText('\u{2764}\u{FE0F}', 1)).toEqual([' '])
    expect(wrapText('日', 1)).toEqual([' '])
  })

  it('wrapText は、行末の空白のうち幅を超える分だけを取り除く', async () => {
    await explains('行末に空白が続く文字列を折り返す場合のテストです。幅に収まる空白は残り、幅を超える空白だけが取り除かれることを確認します。')
    expect(wrapText('abc   ', 4)).toEqual(['abc '])
    expect(wrapText('abcd  ', 4)).toEqual(['abcd'])
  })

  it('outputWidth は、TERMINAL_WIDTH・COLUMNS・端末の幅・80 の順に優先して出力の幅を決める', async () => {
    await explains('出力の幅を決める関数（`outputWidth`）のテストです。環境変数 `TERMINAL_WIDTH`・`COLUMNS`、端末の幅、既定値 80 の順に優先され、不正な値は無視されて、最小の幅は 10 になることを確認します。')
    expect(outputWidth({ TERMINAL_WIDTH: '60', COLUMNS: '50' }, 40)).toBe(60)
    expect(outputWidth({ COLUMNS: '50' }, 40)).toBe(50)
    expect(outputWidth({}, 40)).toBe(40)
    expect(outputWidth({}, undefined)).toBe(80)
    expect(outputWidth({ COLUMNS: 'abc', TERMINAL_WIDTH: '0' }, undefined)).toBe(80)
    expect(outputWidth({ COLUMNS: '3' }, undefined)).toBe(10)
  })

  it('renderPanel は、本文を指定した幅まで空白で埋めた枠を作成する', async () => {
    await explains('枠を作成する関数（`renderPanel`）のテストです。短い本文を渡した場合に、指定した幅まで空白で埋めた枠が作成されることを確認します。')
    expect(renderPanel('T', 'ab', 12)).toBe('╭─ T ──────╮\n│ ab       │\n╰──────────╯\n')
  })
})

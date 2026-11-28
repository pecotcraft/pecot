// 案内のデータを MCP のツールの呼び方にする。ツールの形は registry.ts の登録を使う
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { formatHint, formatHinted, hintedTextOf } from '../../domain/command-hint.js'
import { commandHint, globalRepositoryHint, hinted, inputHint, inputNameHint, joinHinted, placeholder, RUN, RUN_COLON, runAgain } from '../command-hint.js'
import '../../../tests/_helpers/hint-commands.js'

describe('formatHint のツール', () => {
  it.for([
    { name: '複数の入力', hint: commandHint(['project', 'link'], { repo: 'o/r', develop_branch: 'develop' }), expected: 'project_link with repo: "o/r", develop_branch: "develop"' },
    { name: '入力を持たない案内', hint: commandHint(['project', 'list']), expected: 'project_list' },
    { name: '利用者が値を入力するプレースホルダー', hint: commandHint(['project', 'activate'], { project: placeholder('PROJECT') }), expected: 'project_activate with project: <PROJECT>' },
    { name: '真偽の入力', hint: commandHint(['pr', 'restack'], { continue: true }), expected: 'pr_restack with continue: true' },
    { name: '空白と引用符を含む値', hint: commandHint(['issue', 'dependency', 'check'], { owner: 'o', repo: 'r', issue_number: 1, wait: 'merge', reason: 'needs it\'s API' }), expected: 'issue_dependency_check with owner: "o", repo: "r", issue_number: 1, wait: "merge", reason: "needs it\'s API"' },
    { name: '文字列の配列', hint: commandHint(['project', 'check'], { lanes: ['cli', 'docs'] }), expected: 'project_check with lanes: ["cli","docs"]' },
  ])('ツールの案内（$name）は、ツール名と入力の呼び方に整形される', async ({ name, hint, expected }) => {
    await explains(`ツールの案内を MCP のツールの呼び方に整形する処理のテストです。${name}の場合に、ツール名と入力が期待どおりの文字列になることを確認します。`)
    expect(formatHint(hint)).toBe(expected)
  })

  it('入力は、渡した順に並べる', async () => {
    await explains('複数の入力を持つ案内のテストです。入力が、案内へ渡した順で並ぶことを確認します。')
    expect(formatHint(commandHint(['session', 'finish'], { repo: 'o/r', pr_ref: 'o/r/5' }))).toBe('session_finish with repo: "o/r", pr_ref: "o/r/5"')
  })
})

describe('formatHint の入力', () => {
  it.for([
    { name: '値を持つ入力', hint: inputHint(['session', 'start'], 'base', 'main'), expected: 'base: "main"' },
    { name: '真偽の入力', hint: inputHint(['pr', 'restack'], 'continue'), expected: 'continue: true' },
    { name: '名前だけの入力', hint: inputNameHint(['issue', 'comment', 'check'], 'comment_id'), expected: 'comment_id' },
    { name: '共通の repo の名前', hint: globalRepositoryHint(), expected: 'repo' },
    { name: '共通の repo と値', hint: globalRepositoryHint(placeholder('owner/repo')), expected: 'repo: <owner/repo>' },
  ])('入力の案内（$name）は、入力のキーに整形される', async ({ name, hint, expected }) => {
    await explains(`入力の案内を MCP の入力のキーに整形する処理のテストです。${name}の場合に、期待どおりの文字列になることを確認します。`)
    expect(formatHint(hint)).toBe(expected)
  })
})

describe('案内の誤り', () => {
  it.for([
    { name: '定義に存在しないツール', make: () => commandHint(['issue', 'quick']), message: '案内のツール \'issue_quick\' が定義に無い' },
    { name: '定義に存在しない入力', make: () => commandHint(['project', 'link'], { owner_repo: 'o/r' }), message: '案内の入力 \'owner_repo\' が \'project_link\' の定義に無い' },
    { name: '入力名だけの指定で、定義に存在しない入力名', make: () => inputNameHint(['issue', 'comment', 'check'], 'issue'), message: '案内の入力 \'issue\' が \'issue_comment_check\' の定義に無い' },
    { name: 'ツールに無い dry_run', make: () => inputHint(['board', 'show'], 'dry_run'), message: '案内の入力 \'dry_run\' が \'board_show\' の定義に無い' },
  ])('案内に $name を指定して整形すると、TypeError が発生する', async ({ name, make, message }) => {
    await explains(`案内の整形で、入力の誤りを検出する処理のテストです。${name}を指定した場合に、原因を示すメッセージの \`TypeError\` が発生することを確認します。`)
    expect(() => formatHint(make())).toThrow(new TypeError(message))
  })
})

describe('hinted と joinHinted', () => {
  it('文の中の案内を、ツールの呼び方に整形する', async () => {
    await explains('テンプレートリテラルに埋め込んだ案内（`hinted`）のテストです。文を整形すると、案内の部分だけがツールの呼び方の文字列になることを確認します。')
    const text = hinted`no active project\n${RUN_COLON}${commandHint(['project', 'activate'], { project: placeholder('PROJECT') })}`
    expect(formatHinted(text)).toBe('no active project\ncall project_activate with project: <PROJECT>')
  })

  it('joinHinted は、文字列と案内の文を改行でつなぐ', async () => {
    await explains('文字列と案内の文を結合する関数（`joinHinted`）のテストです。複数の要素が改行で連結され、案内がツールの入力の形に整形されることを確認します。')
    const text = joinHinted(['first', hinted`pass ${inputHint(['pr', 'restack'], 'continue')}`])
    expect(formatHinted(text)).toBe('first\npass continue: true')
  })

  it('案内を含まない文字列は、そのまま返す', async () => {
    await explains('案内を含まない文字列のテストです。整形しても、文字列が変更されずに返ることを確認します。')
    expect(formatHinted('plain')).toBe('plain')
  })
})

describe('hintedTextOf', () => {
  it('例外の hintedText が案内の文の場合は、その文を返し、それ以外の場合は undefined を返す', async () => {
    await explains('例外から案内の文を取り出す関数（`hintedTextOf`）のテストです。`hintedText` が案内の文の場合だけその文を返し、数値の配列を持つ例外や、`hintedText` を持たない例外と文字列では `undefined` を返すことを確認します。')
    const text = hinted`${RUN} ${commandHint(['project', 'list'])}`
    const withHint = Object.assign(new Error('x'), { hintedText: text })
    const withNumbers = Object.assign(new Error('x'), { hintedText: [1] })
    expect(hintedTextOf(withHint)).toBe(text)
    expect(hintedTextOf(withNumbers)).toBeUndefined()
    expect(hintedTextOf(new Error('x'))).toBeUndefined()
    expect(hintedTextOf('x')).toBeUndefined()
  })
})

describe('案内の動詞', () => {
  it('RUN_COLON の後ろに、ツール名と入力が続く', async () => {
    await explains('ツールの案内の前に置く定数（`RUN_COLON`）のテストです。`call` の後ろにツール名と入力が続く文になることを確認します。')
    expect(formatHinted(hinted`then ${RUN_COLON}${commandHint(['pr', 'restack'], { continue: true })}`)).toBe('then call pr_restack with continue: true')
  })

  it('RUN は、文の中の動詞を call にする', async () => {
    await explains('文の中で動詞になる定数（`RUN`）のテストです。`call` の後ろにツール名が続く文になることを確認します。')
    expect(formatHinted(hinted`${RUN} ${commandHint(['pr', 'restack'])} later`)).toBe('call pr_restack later')
  })

  it('runAgain は、call とツール名と again になる', async () => {
    await explains('再実行を促す案内（`runAgain`）のテストです。`call` の後ろにツール名と `again` が続くことを確認します。')
    const again = runAgain(commandHint(['pr', 'restack']))
    expect(formatHinted(hinted`push was rejected\n${again}`)).toBe('push was rejected\ncall pr_restack again')
  })
})

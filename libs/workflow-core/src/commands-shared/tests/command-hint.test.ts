// 案内のデータを CLI の行と MCP のツールの呼び方にする。コマンドの形は registry.ts の登録を使う
import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'

import { formatHint, formatHinted, hintedTextOf } from '../../domain/command-hint.js'
import { cliOnlyText, commandHint, globalRepositoryHint, hinted, inputHint, inputNameHint, joinHinted, placeholder, RUN, RUN_COLON, runAgain, surfaceText } from '../command-hint.js'
import '../../../tests/_helpers/hint-commands.js'

describe('formatHint のコマンド', () => {
  it.for([
    {
      name: '位置引数とオプション',
      hint: commandHint(['project', 'link'], { repo: 'o/r', develop_branch: 'develop' }),
      cli: 'pecot project link o/r --develop-branch develop',
      mcp: 'project_link with repo: "o/r", develop_branch: "develop"',
    },
    {
      name: '入力を持たない案内',
      hint: commandHint(['project', 'init']),
      cli: 'pecot project init',
      mcp: 'project_init',
    },
    {
      name: '利用者が値を入力するプレースホルダー',
      hint: commandHint(['project', 'activate'], { project: placeholder('PROJECT') }),
      cli: 'pecot project activate <PROJECT>',
      mcp: 'project_activate with project: <PROJECT>',
    },
    {
      name: '真偽のオプション',
      hint: commandHint(['pr', 'restack'], { continue: true }),
      cli: 'pecot pr restack --continue',
      mcp: 'pr_restack with continue: true',
    },
    {
      name: '空白を含む値',
      hint: commandHint(['issue', 'block'], { issue_ref: 'o/r/1', by: 'o/r/2', wait: 'merge', reason: 'needs it\'s API' }),
      cli: 'pecot issue block o/r/1 --by o/r/2 --wait merge --reason \'needs it\'\\\'\'s API\'',
      mcp: 'issue_block with issue_ref: "o/r/1", by: "o/r/2", wait: "merge", reason: "needs it\'s API"',
    },
    {
      name: '自分の --repo を持たないコマンドの repo',
      hint: commandHint(['board', 'add'], { repo: 'o/r', issue_ref: '5' }),
      cli: 'pecot --repo o/r board add 5',
      mcp: 'board_add with issue_ref: "5", repo: "o/r"',
    },
  ])('コマンドの案内（$name）は、CLI の行と MCP のツールの呼び方に整形される', async ({ name, hint, cli, mcp }) => {
    await explains(`コマンドの案内を CLI の行と MCP のツールの呼び方に整形する処理のテストです。${name}の場合に、CLI と MCP のそれぞれの形で期待どおりの文字列になることを確認します。`)
    expect([formatHint(hint, 'cli'), formatHint(hint, 'mcp')]).toEqual([cli, mcp])
  })

  it('入力は、位置引数を先に、あとは渡した順に並べる', async () => {
    await explains('位置引数と通常のオプションが混在する入力のテストです。位置引数が先に並び、そのほかの入力が渡した順に並ぶことを確認します。')
    const hint = commandHint(['project', 'link'], { develop_branch: 'develop', repo: 'o/r' })
    expect(formatHint(hint, 'cli')).toBe('pecot project link o/r --develop-branch develop')
  })
})

describe('formatHint の入力', () => {
  it.for([
    { name: '値を持つ入力', hint: inputHint(['session', 'start'], 'base', 'main'), cli: '--base main', mcp: 'base: "main"' },
    { name: '真偽の入力', hint: inputHint(['pr', 'restack'], 'continue'), cli: '--continue', mcp: 'continue: true' },
    { name: '名前だけの入力', hint: inputNameHint(['issue', 'comment'], 'issue_ref'), cli: '--issue-ref', mcp: 'issue_ref' },
    { name: 'グローバルの repo の名前', hint: globalRepositoryHint(), cli: '--repo', mcp: 'repo' },
    { name: 'グローバルの repo と値', hint: globalRepositoryHint(placeholder('owner/repo')), cli: '--repo <owner/repo>', mcp: 'repo: <owner/repo>' },
  ])('入力の案内（$name）は、CLI のオプションと MCP のキーに整形される', async ({ name, hint, cli, mcp }) => {
    await explains(`入力の案内を CLI のオプションと MCP のキーに整形する処理のテストです。${name}の場合に、CLI と MCP のそれぞれの形で期待どおりの文字列になることを確認します。`)
    expect([formatHint(hint, 'cli'), formatHint(hint, 'mcp')]).toEqual([cli, mcp])
  })
})

describe('案内の誤り', () => {
  it.for([
    { name: '定義に存在しないコマンド', make: () => commandHint(['issue', 'quick']), message: '案内のコマンド \'issue quick\' が定義に無い' },
    { name: '定義に存在しない入力', make: () => commandHint(['project', 'link'], { owner_repo: 'o/r' }), message: '案内の入力 \'owner_repo\' が \'project link\' の定義に無い' },
    { name: '入力名だけの指定で、定義に存在しない入力名', make: () => inputNameHint(['issue', 'comment'], 'issue'), message: '案内の入力 \'issue\' が \'issue comment\' の定義に無い' },
    { name: 'false の真偽値', make: () => inputHint(['pr', 'restack'], 'continue', false), message: '案内の入力 \'continue\' に false は出せない' },
  ])('案内に $name を指定して CLI の行に整形すると、TypeError が発生する', async ({ name, make, message }) => {
    await explains(`案内の整形で、入力の誤りを検出する処理のテストです。${name}を指定した場合に、原因を示すメッセージの \`TypeError\` が発生することを確認します。`)
    expect(() => formatHint(make(), 'cli')).toThrow(new TypeError(message))
  })

  it.for([
    { name: 'コマンドの案内', make: () => commandHint(['board', 'sync'], { dry_run: true }), cli: 'pecot board sync --dry-run' },
    { name: '入力の案内', make: () => inputHint(['board', 'sync'], 'dry_run'), cli: '--dry-run' },
  ])('CLI 専用の入力を含む案内（$name）は、MCP の形では TypeError が発生し、CLI の形では整形できる', async ({ name, make, cli }) => {
    await explains(`CLI だけで使える入力（\`dry_run\`）を含む案内のテストです。${name}を MCP の形に整形すると \`TypeError\` が発生し、CLI の形には整形できることを確認します。`)
    expect(formatHint(make(), 'cli')).toBe(cli)
    expect(() => formatHint(make(), 'mcp')).toThrow(new TypeError('案内の入力 \'dry_run\' は \'board sync\' の CLI だけの入力で、MCP に出せない'))
  })
})

describe('hinted と joinHinted', () => {
  it('文の中の案内を、CLI と MCP のそれぞれの形で整形する', async () => {
    await explains('テンプレートリテラルに埋め込んだ案内（`hinted`）のテストです。同じ文を CLI の形と MCP の形へ整形すると、案内の部分だけが各形式の文字列になることを確認します。')
    const text = hinted`no active project\nrun: ${commandHint(['project', 'activate'], { project: placeholder('PROJECT') })}`
    expect(formatHinted(text, 'cli')).toBe('no active project\nrun: pecot project activate <PROJECT>')
    expect(formatHinted(text, 'mcp')).toBe('no active project\nrun: project_activate with project: <PROJECT>')
  })

  it('joinHinted は、文字列と案内の文を改行でつなぐ', async () => {
    await explains('文字列と案内の文を結合する関数（`joinHinted`）のテストです。複数の要素が改行で連結され、CLI と MCP のそれぞれの形に整形できることを確認します。')
    const text = joinHinted(['first', hinted`pass ${inputHint(['pr', 'restack'], 'continue')}`])
    expect(formatHinted(text, 'cli')).toBe('first\npass --continue')
    expect(formatHinted(text, 'mcp')).toBe('first\npass continue: true')
  })

  it('案内を含まない文字列は、そのまま返す', async () => {
    await explains('案内を含まない文字列のテストです。整形しても、文字列が変更されずに返ることを確認します。')
    expect(formatHinted('plain', 'mcp')).toBe('plain')
  })
})

describe('hintedTextOf', () => {
  it('例外の hintedText が案内の文の場合は、その文を返し、それ以外の場合は undefined を返す', async () => {
    await explains('例外から案内の文を取り出す関数（`hintedTextOf`）のテストです。`hintedText` が案内の文の場合だけその文を返し、数値の配列を持つ例外や、`hintedText` を持たない例外と文字列では `undefined` を返すことを確認します。')
    const text = hinted`run ${commandHint(['project', 'init'])}`
    const withHint = Object.assign(new Error('x'), { hintedText: text })
    const withNumbers = Object.assign(new Error('x'), { hintedText: [1] })
    expect(hintedTextOf(withHint)).toBe(text)
    expect(hintedTextOf(withNumbers)).toBeUndefined()
    expect(hintedTextOf(new Error('x'))).toBeUndefined()
    expect(hintedTextOf('x')).toBeUndefined()
  })
})

describe('出し先で変わる文', () => {
  it('surfaceText を使った文は、CLI と MCP でそれぞれ別の文に整形される', async () => {
    await explains('出力先ごとに文を切り替える関数（`surfaceText`）のテストです。CLI の形では 1 つ目の文、MCP の形では 2 つ目の文になることを確認します。')
    const text = hinted`fix it and ${surfaceText('run the command', 'call the tool')} again`
    expect(formatHinted(text, 'cli')).toBe('fix it and run the command again')
    expect(formatHinted(text, 'mcp')).toBe('fix it and call the tool again')
  })

  it('cliOnlyText の中の文は、CLI の形では出力し、MCP の形では空にする', async () => {
    await explains('CLI だけに出力する文（`cliOnlyText`）のテストです。CLI の形では括弧内の案内を出力し、MCP の形では何も出力しないことを確認します。')
    const text = hinted`run ${commandHint(['board', 'sync'])}${cliOnlyText(hinted` (${inputHint(['board', 'sync'], 'dry_run')} to preview)`)}`
    expect(formatHinted(text, 'cli')).toBe('run pecot board sync (--dry-run to preview)')
    expect(formatHinted(text, 'mcp')).toBe('run board_sync')
  })

  it('RUN_COLON は、CLI では run: とコマンド、MCP では call とツール名になる', async () => {
    await explains('コマンドの案内の前に置く定数（`RUN_COLON`）のテストです。CLI の形では `run:` の後ろにコマンド、MCP の形では `call` の後ろにツール名と入力が続く文になることを確認します。')
    const text = hinted`then ${RUN_COLON}${commandHint(['pr', 'restack'], { continue: true })}`
    expect(formatHinted(text, 'cli')).toBe('then run: pecot pr restack --continue')
    expect(formatHinted(text, 'mcp')).toBe('then call pr_restack with continue: true')
  })

  it('RUN は、文の中の動詞を CLI では run、MCP では call にする', async () => {
    await explains('文の中で動詞になる定数（`RUN`）のテストです。CLI の形では `run`、MCP の形では `call` になることを確認します。')
    const text = hinted`${RUN} ${commandHint(['board', 'sync'])} later`
    expect(formatHinted(text, 'cli')).toBe('run pecot board sync later')
    expect(formatHinted(text, 'mcp')).toBe('call board_sync later')
  })

  it('runAgain は、CLI では run again: とコマンド、MCP では call とツール名と again になる', async () => {
    await explains('再実行を促す案内（`runAgain`）のテストです。CLI の形では `run again:` の後ろにコマンド、MCP の形では `call` の後ろにツール名と `again` が続くことを確認します。')
    const text = hinted`push was rejected\n${runAgain(commandHint(['pr', 'restack']))}`
    expect(formatHinted(text, 'cli')).toBe('push was rejected\nrun again: pecot pr restack')
    expect(formatHinted(text, 'mcp')).toBe('push was rejected\ncall pr_restack again')
  })
})

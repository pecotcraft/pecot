// 案内のデータを CLI の行と MCP のツールの呼び方にする。コマンドの形は registry.ts の登録を使う
import { describe, expect, it } from 'vitest'

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
      name: '入力の無い案内',
      hint: commandHint(['project', 'init']),
      cli: 'pecot project init',
      mcp: 'project_init',
    },
    {
      name: '利用者が埋める値',
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
  ])('$name は、CLI の行と MCP の呼び方になる', ({ hint, cli, mcp }) => {
    expect([formatHint(hint, 'cli'), formatHint(hint, 'mcp')]).toEqual([cli, mcp])
  })

  it('入力は、位置引数を先に、あとは渡した順に並べる', () => {
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
  ])('$name は、CLI のオプションと MCP のキーになる', ({ hint, cli, mcp }) => {
    expect([formatHint(hint, 'cli'), formatHint(hint, 'mcp')]).toEqual([cli, mcp])
  })
})

describe('案内の誤り', () => {
  it.for([
    { name: '定義に無いコマンド', make: () => commandHint(['issue', 'quick']), message: '案内のコマンド \'issue quick\' が定義に無い' },
    { name: '定義に無い入力', make: () => commandHint(['project', 'link'], { owner_repo: 'o/r' }), message: '案内の入力 \'owner_repo\' が \'project link\' の定義に無い' },
    { name: '定義に無い入力名', make: () => inputNameHint(['issue', 'comment'], 'issue'), message: '案内の入力 \'issue\' が \'issue comment\' の定義に無い' },
    { name: '偽の真偽値', make: () => inputHint(['pr', 'restack'], 'continue', false), message: '案内の入力 \'continue\' に false は出せない' },
  ])('$name を描くと、TypeError で止まる', ({ make, message }) => {
    expect(() => formatHint(make(), 'cli')).toThrow(new TypeError(message))
  })

  it.for([
    { name: 'コマンドの案内', make: () => commandHint(['board', 'sync'], { dry_run: true }), cli: 'pecot board sync --dry-run' },
    { name: '入力の案内', make: () => inputHint(['board', 'sync'], 'dry_run'), cli: '--dry-run' },
  ])('CLI だけの入力を $name で MCP に描くと、TypeError で止まり、CLI には描ける', ({ make, cli }) => {
    expect(formatHint(make(), 'cli')).toBe(cli)
    expect(() => formatHint(make(), 'mcp')).toThrow(new TypeError('案内の入力 \'dry_run\' は \'board sync\' の CLI だけの入力で、MCP に出せない'))
  })
})

describe('hinted と joinHinted', () => {
  it('文の中の案内を、出し先の形で描く', () => {
    const text = hinted`no active project\nrun: ${commandHint(['project', 'activate'], { project: placeholder('PROJECT') })}`
    expect(formatHinted(text, 'cli')).toBe('no active project\nrun: pecot project activate <PROJECT>')
    expect(formatHinted(text, 'mcp')).toBe('no active project\nrun: project_activate with project: <PROJECT>')
  })

  it('joinHinted は、文字列と案内の文を区切りでつなぐ', () => {
    const text = joinHinted(['first', hinted`pass ${inputHint(['pr', 'restack'], 'continue')}`])
    expect(formatHinted(text, 'cli')).toBe('first\npass --continue')
    expect(formatHinted(text, 'mcp')).toBe('first\npass continue: true')
  })

  it('文字列はそのまま返す', () => {
    expect(formatHinted('plain', 'mcp')).toBe('plain')
  })
})

describe('hintedTextOf', () => {
  it('例外の hintedText が案内の文なら返し、それ以外は undefined', () => {
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
  it('surfaceText は、CLI と MCP で別の文になる', () => {
    const text = hinted`fix it and ${surfaceText('run the command', 'call the tool')} again`
    expect(formatHinted(text, 'cli')).toBe('fix it and run the command again')
    expect(formatHinted(text, 'mcp')).toBe('fix it and call the tool again')
  })

  it('cliOnlyText は、CLI では中の文を描き、MCP では空になる', () => {
    const text = hinted`run ${commandHint(['board', 'sync'])}${cliOnlyText(hinted` (${inputHint(['board', 'sync'], 'dry_run')} to preview)`)}`
    expect(formatHinted(text, 'cli')).toBe('run pecot board sync (--dry-run to preview)')
    expect(formatHinted(text, 'mcp')).toBe('run board_sync')
  })

  it('RUN_COLON は、CLI では run: とコマンド、MCP では call とツール名になる', () => {
    const text = hinted`then ${RUN_COLON}${commandHint(['pr', 'restack'], { continue: true })}`
    expect(formatHinted(text, 'cli')).toBe('then run: pecot pr restack --continue')
    expect(formatHinted(text, 'mcp')).toBe('then call pr_restack with continue: true')
  })

  it('RUN は、文の中の動詞を CLI では run、MCP では call にする', () => {
    const text = hinted`${RUN} ${commandHint(['board', 'sync'])} later`
    expect(formatHinted(text, 'cli')).toBe('run pecot board sync later')
    expect(formatHinted(text, 'mcp')).toBe('call board_sync later')
  })

  it('runAgain は、CLI では run again: とコマンド、MCP では call とツール名と again になる', () => {
    const text = hinted`push was rejected\n${runAgain(commandHint(['pr', 'restack']))}`
    expect(formatHinted(text, 'cli')).toBe('push was rejected\nrun again: pecot pr restack')
    expect(formatHinted(text, 'mcp')).toBe('push was rejected\ncall pr_restack again')
  })
})

// スキル・エージェント・hooks のテンプレートの本文に出るツール名が、COMMANDS に実在することを確かめる。
// あわせて、`pecot <サブコマンド>` の書き方（R-19）が本文に残らないことを確かめる。
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { COMMAND_GROUPS } from '../../src/commands/names.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { compareStrings } from '../parity/baseline.js'
import { pluginRoot, readDocuments, toolInputs } from './_helpers/documents.js'

// 利用者が端末で打つコマンドの説明として、本文に残してよい `pecot <サブコマンド>`。
// 書式は `<プラグインからの相対パス>:<行>`。載せるのは、w-help の、利用者が端末か `!` で打つ説明だけ。
const TERMINAL_COMMANDS: readonly string[] = ['skills/w-help/SKILL.md:60', 'skills/w-help/SKILL.md:62']

// ツール名に似るが、入力の値や概念を指す語。TOOL_LIKE に合う語だけを置く
const NOT_TOOLS: ReadonlySet<string> = new Set(['release_type', 'release_branch', 'session_id', 'workflow_dispatch'])

const GROUP_WORDS = COMMAND_GROUPS.map(group => group.name).join('|')
// 1 語目がグループの語の名前を拾う。pecot-workflow__ の続きは除く。
// eslint-disable-next-line security/detect-non-literal-regexp -- 語は COMMAND_GROUPS から作る
const TOOL_LIKE = new RegExp(String.raw`(?<![\w-])(?:${GROUP_WORDS})_[a-z_]+\b`, 'gu')
// コマンドの名前の全体。グループの語だけの形を除く。
const TOP_WORDS = [...new Set(COMMANDS.map(command => command.path.join(' ')))].toSorted(compareStrings).map(name => name.replaceAll(' ', String.raw`\s+`)).join('|')
// deny の hook の起動形を拾う。起動形は pecot・$PECOT・${PECOT}・.../bin/pecot で、クオート付きを含む。
// 後ろに `--repo <値>` があってもよい。その後ろに、サブコマンドか `--help`・`--version` が来る形を拾う。
// eslint-disable-next-line security/detect-non-literal-regexp -- サブコマンドの語は COMMANDS から作る
const CLI_FORM = new RegExp(
  String.raw`(?:^|[\s\x60(;&|'])"?(?:\$\{?PECOT\}?|[^\s"'=]*/bin/pecot|pecot)"?`
  + String.raw`(?:\s+--repo(?:=|\s+)\S+)?\s+(?:${TOP_WORDS}|--help|--version)(?![\w-])`,
  'u',
)
// #428 で改名した入力名（repo_ref・owner_repo・branch_name・plan・issue）と、消したツール issue_quick。
// issue は `issue:` の形だけ拾う（issue_ref・issue 番号の語は拾わない）。plan は `plan: true` の形だけ拾う。
const OLD_INPUT_NAMES = /\b(?:repo_ref|owner_repo|branch_name|issue_quick)\b|`plan: (?:true|false)`|`issue: "/u
const PREFIXED = /mcp__plugin_pecot-w_pecot-workflow__([a-z_]+)/gu

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

describe('本文のツール名', () => {
  const tools = toolInputs()
  const inputNames = new Set<string>()
  for (const names of tools.values()) for (const name of names) inputNames.add(name)
  const documents = readDocuments()

  it('読む本文が 1 件以上ある', () => {
    expect(documents.length).toBeGreaterThan(30)
  })

  it('ツール名らしい語は、COMMANDS のツール名・入力名、またはツールでない語の一覧のどれかにある', () => {
    const unknown: string[] = []
    for (const { file, text } of documents) {
      for (const match of text.matchAll(TOOL_LIKE)) {
        const word = match[0]
        if (!tools.has(word) && !inputNames.has(word) && !NOT_TOOLS.has(word)) unknown.push(`${file}:${String(lineNumberAt(text, match.index))} ${word}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it('ツールでない語の一覧は、どれもツール名らしい語の式に合う', () => {
    expect([...NOT_TOOLS].filter(word => word.match(TOOL_LIKE)?.[0] !== word)).toEqual([])
  })

  it('古い入力名と古いツール名を、本文に書かない', () => {
    const offenders: string[] = []
    for (const { file, text } of documents) {
      for (const [index, line] of text.split('\n').entries()) {
        if (OLD_INPUT_NAMES.test(line)) offenders.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('本文以外の文書（hooks/README.md など）にも、古い入力名と古いツール名を書かない。バッククォートが付くかは問わない', () => {
    const files = globSync('**/*.md', { cwd: pluginRoot, exclude: name => ['node_modules', 'CHANGELOG.md', 'test-results'].includes(name) })
    expect(files).toContain('hooks/README.md')
    const offenders: string[] = []
    for (const file of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 読むのはプラグイン配下の md のみ
      const lines = readFileSync(path.join(pluginRoot, file), 'utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        if (OLD_INPUT_NAMES.test(line)) offenders.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('古い入力名の検出式は、古い入力を拾い、今の入力を拾わない', () => {
    expect(['`repo_ref: "o/r"`', '`owner_repo` | x', '`branch_name: "feat/x"`', '`issue_quick` を呼ぶ', '`plan: true`', '`issue: "o/r/1"`'].filter(sample => !OLD_INPUT_NAMES.test(sample))).toEqual([])
    expect(['`repo: "o/r"`', '`branch: "feat/x"`', '`dry_run: true`', '`issue_ref: "o/r/1"`'].filter(sample => OLD_INPUT_NAMES.test(sample))).toEqual([])
  })

  it('ツールでない語の一覧は、どれも本文のどこかに出る', () => {
    const joined = documents.map(({ text }) => text).join('\n')
    const unused = [...NOT_TOOLS].filter(word => !joined.includes(word))
    expect(unused).toEqual([])
  })

  it('接頭辞付きの名前は、実在するツールを指す', () => {
    const unknown: string[] = []
    for (const { file, text } of documents) {
      for (const match of text.matchAll(PREFIXED)) {
        if (!tools.has(match[1] ?? '')) unknown.push(`${file} ${match[0]}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it('接頭辞付きの名前は、スキルの frontmatter の allowed-tools にだけ書く', () => {
    const outside = documents.filter(({ text }) => {
      const body = text.replace(/^---\n[\s\S]*?\n---\n/u, '')
      return body.includes('mcp__plugin_pecot-w_pecot-workflow__') || body.includes('pecot-workflow-')
    }).map(({ file }) => file)
    expect(outside).toEqual([])
  })

  it('w-pr の allowed-tools は、pr_check・pr_create・pr_show・issue_comment を許す', () => {
    const skill = documents.find(({ file }) => file === 'skills/w-pr/SKILL.md')
    expect(skill?.text).toContain('mcp__plugin_pecot-w_pecot-workflow__pr_check')
    for (const tool of ['pr_create', 'pr_show', 'issue_comment']) expect(skill?.text).toContain(`mcp__plugin_pecot-w_pecot-workflow__${tool}`)
  })

  it('COMMANDS の全ツールの名前が、重ならない', () => {
    const names = COMMANDS.map(command => command.toolName)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('`pecot <サブコマンド>` の残り（R-19）', () => {
  it('残りは、端末で打つコマンドとして許した箇所の一覧と一致する', () => {
    const residual: string[] = []
    for (const { file, text } of readDocuments()) {
      for (const [index, line] of text.split('\n').entries()) {
        if (CLI_FORM.test(line)) residual.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(residual).toEqual(TERMINAL_COMMANDS)
  })
})

describe('`pecot <サブコマンド>` の検出式', () => {
  const denied = [
    'pecot issue show 1',
    '$PECOT issue show o/r#1',
    '${PECOT} pr create',
    '"$PECOT" board show',
    '"${CLAUDE_PLUGIN_ROOT}/bin/pecot" --repo o/r issue comment',
    '/home/u/.claude/plugins/x/bin/pecot session show',
    'pecot --repo o/r tracker sync security',
    'cd x && pecot --help',
    'pecot --version',
    'pecot branch delete acme/demo feat/x',
    '$PECOT tracker sync security --dry-run',
    'pecot workflow doctor review',
  ]
  const allowed = [
    'pecot-tools aws s3 ls',
    'pecotv issue show',
    'cd .pecot/work/350 && ls',
    'pecot-workflow issue show',
    '.pecot/state/pecot issue',
    'pecot について説明する',
    'pecot issue-tracker',
    'pecot create-branches',
    'pecot securityx',
    'pecot workflow management',
    'pecot issue',
  ]

  it('deny の起動形の見本を、全部拾う', () => {
    expect(denied.filter(sample => !CLI_FORM.test(sample))).toEqual([])
  })

  it('拾ってはいけない見本を、拾わない', () => {
    expect(allowed.filter(sample => CLI_FORM.test(sample))).toEqual([])
  })
})

describe('pecot の起動のランチャー', () => {
  // 単独の PECOT= の代入と、サブコマンドの付かない ${CLAUDE_PLUGIN_ROOT}/bin/pecot は、R-19 の検出式では拾えない
  const LAUNCHER = /\$\{?PECOT\}?(?!\w)|^\s*PECOT=/mu
  const skillDocuments = readDocuments().filter(({ file }) => file.startsWith('skills/'))

  it('SKILL.md が 1 件以上ある', () => {
    expect(skillDocuments.some(({ file }) => file.endsWith('/SKILL.md'))).toBe(true)
  })

  it('スキルの本文に、Claude Code だけで動く ${CLAUDE_PLUGIN_ROOT}/bin/pecot を置かない', () => {
    const offenders = skillDocuments.filter(({ text }) => text.includes('${CLAUDE_PLUGIN_ROOT}/bin/pecot')).map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it('スキルと hooks のテンプレートに、ランチャー変数（PECOT=... と $PECOT）を置かない', () => {
    const offenders = readDocuments().filter(({ file }) => file.startsWith('skills/') || file.startsWith('hooks/templates/')).filter(({ text }) => LAUNCHER.test(text)).map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it('ランチャー変数の検出式は、代入と参照を拾い、PECOT_HOME のような別の名前を拾わない', () => {
    expect(['PECOT=pecot', '  PECOT="$X"', 'run $PECOT issue', 'run ${PECOT} x'].filter(sample => !LAUNCHER.test(sample))).toEqual([])
    expect(['PECOT_HOME=1', 'echo $PECOT_HOME', 'MYPECOT=1'].filter(sample => LAUNCHER.test(sample))).toEqual([])
  })
})

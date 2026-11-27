// スキル・エージェント・hooks のテンプレートの本文に出るツール名が、COMMANDS に実在することを確かめる。
// あわせて、`pecot <サブコマンド>` の書き方（R-19）が本文に残らないことを確かめる。
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { explains } from '../_helpers/explains.js'
import { COMMAND_GROUPS } from '@pecot/workflow-core/commands-shared/names.js'
import { COMMANDS } from '../../src/commands/registry.js'
import { compareStrings } from '../parity/baseline.js'
import { pluginRoot, readDocuments, toolInputs } from './_helpers/documents.js'

// 利用者が端末で打つコマンドの説明として、本文に残してよい `pecot <サブコマンド>`。
// 書式は `<プラグインからの相対パス>:<行>`。載せるのは、w-help の、利用者が端末か `!` で打つ説明だけ。
const TERMINAL_COMMANDS: readonly string[] = ['skills/w-help/SKILL.md:64', 'skills/w-help/SKILL.md:66']

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

  it('走査する本文が 30 件を超える', async () => {
    await explains('本文の走査対象のテストです。スキル・エージェント・hooks のテンプレートの文書が 30 件を超えることを確認します。')
    expect(documents.length).toBeGreaterThan(30)
  })

  it('ツール名らしい語は、COMMANDS のツール名・入力名、またはツールでない語の一覧のどれかに含まれる', async () => {
    await explains('本文のツール名のテストです。`issue_show` のようなツール名らしい語が、すべて `COMMANDS` のツール名・入力名、またはツールではない語の一覧のどれかに含まれることを確認します。')
    const unknown: string[] = []
    for (const { file, text } of documents) {
      for (const match of text.matchAll(TOOL_LIKE)) {
        const word = match[0]
        if (!tools.has(word) && !inputNames.has(word) && !NOT_TOOLS.has(word)) unknown.push(`${file}:${String(lineNumberAt(text, match.index))} ${word}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it('ツールではない語の一覧は、どれもツール名らしい語の正規表現に一致する', async () => {
    await explains('ツールではない語の一覧のテストです。一覧のすべての語が、ツール名らしい語を拾う正規表現に一致することを確認します。')
    expect([...NOT_TOOLS].filter(word => word.match(TOOL_LIKE)?.[0] !== word)).toEqual([])
  })

  it('古い入力名と古いツール名が、本文に含まれない', async () => {
    await explains('本文の入力名のテストです。改名前の入力名（`repo_ref`・`owner_repo`・`branch_name`）と、廃止した `issue_quick` が、どの文書にも含まれないことを確認します。')
    const offenders: string[] = []
    for (const { file, text } of documents) {
      for (const [index, line] of text.split('\n').entries()) {
        if (OLD_INPUT_NAMES.test(line)) offenders.push(`${file}:${String(index + 1)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('本文以外の文書（hooks/README.md など）にも、古い入力名と古いツール名を書かない。バッククォートが付くかは問わない', async () => {
    await explains('本文以外の Markdown のテストです。`hooks/README.md` などの文書にも、改名前の入力名と廃止したツール名が、バッククォートの有無を問わず含まれないことを確認します。')
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

  it('古い入力名の正規表現は、古い入力に一致し、現在の入力に一致しない', async () => {
    await explains('古い入力名を検出する正規表現のテストです。`repo_ref` や `issue_quick` などの古い記述には一致し、`repo` や `issue_ref` などの現在の記述には一致しないことを確認します。')
    expect(['`repo_ref: "o/r"`', '`owner_repo` | x', '`branch_name: "feat/x"`', '`issue_quick` を呼ぶ', '`plan: true`', '`issue: "o/r/1"`'].filter(sample => !OLD_INPUT_NAMES.test(sample))).toEqual([])
    expect(['`repo: "o/r"`', '`branch: "feat/x"`', '`delete_branch: true`', '`issue_ref: "o/r/1"`'].filter(sample => OLD_INPUT_NAMES.test(sample))).toEqual([])
  })

  it('ツールではない語の一覧は、どれも本文のどこかに含まれる', async () => {
    await explains('ツールではない語の一覧のテストです。一覧のすべての語が、いずれかの文書に含まれていることを確認し、使われなくなった語が残るのを防ぎます。')
    const joined = documents.map(({ text }) => text).join('\n')
    const unused = [...NOT_TOOLS].filter(word => !joined.includes(word))
    expect(unused).toEqual([])
  })

  it('接頭辞付きの名前は、実在するツールを指す', async () => {
    await explains('`mcp__plugin_pecot-w_pecot-workflow__` で始まる名前のテストです。接頭辞の後ろの名前が、すべて実在するツールの名前であることを確認します。')
    const unknown: string[] = []
    for (const { file, text } of documents) {
      for (const match of text.matchAll(PREFIXED)) {
        if (!tools.has(match[1] ?? '')) unknown.push(`${file} ${match[0]}`)
      }
    }
    expect(unknown).toEqual([])
  })

  it('接頭辞付きの名前は、スキルの frontmatter の allowed-tools にだけ書く', async () => {
    await explains('接頭辞つきのツール名の置き場所のテストです。接頭辞つきの名前が、スキルの frontmatter の `allowed-tools` の外（本文）に含まれないことを確認します。')
    const outside = documents.filter(({ text }) => {
      const body = text.replace(/^---\n[\s\S]*?\n---\n/u, '')
      return body.includes('mcp__plugin_pecot-w_pecot-workflow__') || body.includes('pecot-workflow-')
    }).map(({ file }) => file)
    expect(outside).toEqual([])
  })

  it('w-pr の allowed-tools は、pr_check・pr_create・pr_show・issue_comment を許す', async () => {
    await explains('`w-pr` の `allowed-tools` のテストです。`pr_check`・`pr_create`・`pr_show`・`issue_comment` の 4 つのツールが許可されていることを確認します。')
    const skill = documents.find(({ file }) => file === 'skills/w-pr/SKILL.md')
    expect(skill?.text).toContain('mcp__plugin_pecot-w_pecot-workflow__pr_check')
    for (const tool of ['pr_create', 'pr_show', 'issue_comment']) expect(skill?.text).toContain(`mcp__plugin_pecot-w_pecot-workflow__${tool}`)
  })

  it.for(['w-active', 'w-quick', 'w-breakdown'])('%s の allowed-tools は、取りこぼしの片付けに使う session_finish だけを許す', async (skillName) => {
    await explains(`\`${skillName}\` の \`allowed-tools\` のテストです。許可するツールが、取りこぼしの片付けに使う \`session_finish\` だけであることを確認します。`)
    const skill = documents.find(({ file }) => file === `skills/${skillName}/SKILL.md`)
    const line = skill?.text.split('\n').find(candidate => candidate.startsWith('allowed-tools: '))
    expect(line).toBe('allowed-tools: mcp__plugin_pecot-w_pecot-workflow__session_finish')
  })

  it('スキルの allowed-tools は、Agent Skills の仕様どおり空白で区切り、カンマを使わない', async () => {
    await explains('スキルの `allowed-tools` の書式のテストです。Agent Skills の仕様に従って空白で区切られ、カンマを含む値が存在しないことを確認します。')
    const fields = documents.filter(({ file }) => file.endsWith('/SKILL.md')).flatMap(({ file, text }) => text.split('\n').filter(line => line.startsWith('allowed-tools: ')).map(line => ({ file, value: line.slice('allowed-tools: '.length) })))
    expect(fields.length).toBeGreaterThanOrEqual(4)
    expect(fields.filter(({ value }) => value.includes(',')).map(({ file }) => file)).toEqual([])
  })

  it('COMMANDS の全ツールの名前が重複しない', async () => {
    await explains('`COMMANDS` のツール名のテストです。すべてのツール名が一意で、重複が存在しないことを確認します。')
    const names = COMMANDS.map(command => command.toolName)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('`pecot <サブコマンド>` の残り（R-19）', () => {
  it('残りは、端末で打つコマンドとして許した箇所の一覧と一致する', async () => {
    await explains('`pecot <サブコマンド>` の形の記述のテストです。本文に残っているこの形の記述が、利用者が端末で打つコマンドとして許可した箇所の一覧と一致することを確認します。')
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

  it('deny の hook が拒否する起動形の見本を、すべて検出する', async () => {
    await explains('`pecot <サブコマンド>` を検出する正規表現のテストです。`pecot issue show 1` や `$PECOT pr create` など、deny の hook が拒否する起動形の見本がすべて一致することを確認します。')
    expect(denied.filter(sample => !CLI_FORM.test(sample))).toEqual([])
  })

  it('検出してはいけない見本を、検出しない', async () => {
    await explains('同じ正規表現のテストです。`pecot-tools aws s3 ls` や `pecot について説明する` など、検出してはいけない見本のどれにも一致しないことを確認します。')
    expect(allowed.filter(sample => CLI_FORM.test(sample))).toEqual([])
  })
})

describe('pecot の起動のランチャー', () => {
  // 単独の PECOT= の代入と、サブコマンドの付かない ${CLAUDE_PLUGIN_ROOT}/bin/pecot は、R-19 の検出式では拾えない
  const LAUNCHER = /\$\{?PECOT\}?(?!\w)|^\s*PECOT=/mu
  const skillDocuments = readDocuments().filter(({ file }) => file.startsWith('skills/'))

  it('スキルの文書に SKILL.md が 1 件以上含まれる', async () => {
    await explains('ランチャーの検証の前提のテストです。スキルの文書に `SKILL.md` が 1 件以上含まれることを確認します。')
    expect(skillDocuments.some(({ file }) => file.endsWith('/SKILL.md'))).toBe(true)
  })

  it('スキルの本文に、Claude Code だけで動く ${CLAUDE_PLUGIN_ROOT}/bin/pecot を書かない', async () => {
    await explains('スキルの本文のテストです。Claude Code だけで動く `${CLAUDE_PLUGIN_ROOT}/bin/pecot` が、どの文書にも含まれないことを確認します。')
    const offenders = skillDocuments.filter(({ text }) => text.includes('${CLAUDE_PLUGIN_ROOT}/bin/pecot')).map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it('スキルと hooks のテンプレートに、ランチャー変数（PECOT=... と $PECOT）を書かない', async () => {
    await explains('スキルと hooks のテンプレートのテストです。`PECOT=...` の代入と `$PECOT` の参照が、どの文書にも含まれないことを確認します。')
    const offenders = readDocuments().filter(({ file }) => file.startsWith('skills/') || file.startsWith('hooks/templates/')).filter(({ text }) => LAUNCHER.test(text)).map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it('ランチャー変数の正規表現は、代入と参照に一致し、PECOT_HOME のような別の名前に一致しない', async () => {
    await explains('ランチャー変数を検出する正規表現のテストです。`PECOT=pecot` や `$PECOT` には一致し、`PECOT_HOME` のような別の名前には一致しないことを確認します。')
    expect(['PECOT=pecot', '  PECOT="$X"', 'run $PECOT issue', 'run ${PECOT} x'].filter(sample => !LAUNCHER.test(sample))).toEqual([])
    expect(['PECOT_HOME=1', 'echo $PECOT_HOME', 'MYPECOT=1'].filter(sample => LAUNCHER.test(sample))).toEqual([])
  })
})

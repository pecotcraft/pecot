// hooks 配下のファイルを読むテストは、test-hooks だけが実行する（vitest の project hooks）。
// test-cli の入力に hooks/ を含めないため、cli 側のテストからは hooks/ を読まない。
import { existsSync, globSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings, readBaseline } from '../parity/baseline.js'
import { pluginRoot } from './_helpers/paths.js'
import { codeLines } from './_helpers/script-references.js'

// テストが名指しできない lib スクリプトは、別のスクリプトから呼ばれて動く。
// キーは hooks.scripts の相対パス、値はそれを呼ぶスクリプト。呼ぶ側もテストが名指しするか、この表の別の行にある。
const INDIRECT_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  'hooks/lib/core/git-repo-resolver.sh': ['hooks/lib/core/git-checkout-check.sh', 'hooks/lib/core/git-worktree-branch-check.sh'],
  'hooks/lib/core/pecot-dir-init-detect.sh': ['hooks/pre-tool-use-skill.sh', 'hooks/user-prompt-submit.sh'],
  'hooks/lib/core/skill-name.sh': ['hooks/lib/core/pecot-dir-init-detect.sh', 'hooks/lib/post-tool-use/pecot-skill-reminder.sh', 'hooks/lib/pre-tool-use/pecot-skill-compliance.sh'],
  'hooks/lib/mcp-handlers/context7-allow.sh': ['hooks/lib/mcp-handlers/mcp-dispatcher.sh'],
  'hooks/lib/mcp-handlers/mcp-dispatcher.sh': ['hooks/pre-tool-use-mcp.sh'],
  'hooks/lib/notification/pty-bell-sender.sh': ['hooks/stop-copilot.sh'],
  'hooks/lib/notification/terminal-bell.sh': ['hooks/notification.sh', 'hooks/stop.sh'],
  'hooks/lib/pre-tool-use/pecot-skill-compliance.sh': ['hooks/pre-tool-use-skill.sh'],
  'hooks/lib/pre-tool-use/websearch-allow.sh': ['hooks/pre-tool-use-websearch.sh'],
}

// hooks のスクリプトを起動せず、ファイルの中身を読むだけのテスト。名指しの走査から外す。
const NON_LAUNCHING_TESTS: ReadonlySet<string> = new Set([
  'ci-scope-consistency.test.ts',
  'cuj-definition-single-source.test.ts',
  'english-only.test.ts',
  'entry-point-library-references.test.ts',
  'hooks-config-parity.test.ts',
  'hooks-config-sample-sync.test.ts',
  'lib/agent-definitions.test.ts',
  'lib/entry-point-linter.test.ts',
  'lib/hooks-definitions.test.ts',
  'lib/mcp-definitions.test.ts',
  'lib/pecot-state-write-convention.test.ts',
  'project-root-convention.test.ts',
  'readme-flow-table-sync.test.ts',
  'regex-posix-convention.test.ts',
  'skill-name-prefix-convention.test.ts',
])

// 引用符の種類によらず、コードの行にあるスクリプト名を拾う。bash -c の文字列に埋めた名前も含む。
// "$1/x.sh" のような変数つきの名前は、変数を除いた "/x.sh" から読む。
const SHELL_NAME = /(?:(?<![\w./$-])|(?<=\$\{?\w+\}?))\/?(?<name>[\w./-]*[\w-]\.sh)(?![\w-])/gu
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/u
const TITLE_LINE = /^\s*(?:describe|it)(?:\.for)?\(/u

function scriptsNamedByTests(candidates: readonly string[]): Set<string> {
  const files = globSync('**/*.test.ts', { cwd: import.meta.dirname })
    .filter(relative => !relative.startsWith('_helpers/') && relative !== 'baseline-scripts.test.ts' && !NON_LAUNCHING_TESTS.has(relative))
  const named = new Set<string>()
  for (const relative of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tests/hooks 配下の固定の相対パス
    const lines = readFileSync(path.join(import.meta.dirname, relative), 'utf8').split('\n')
    const codeOnly = lines.filter(item => !COMMENT_LINE.test(item) && !TITLE_LINE.test(item))
    for (const line of codeOnly) {
      const code = line.replace(/\s\/\/.*$/u, '')
      for (const match of code.matchAll(SHELL_NAME)) {
        const literal = match.groups?.['name'] ?? ''
        let matched = candidates.filter(script => (literal.includes('/')
          ? script === `hooks/${literal}` || script.endsWith(`/${literal}`)
          : path.basename(script) === literal))
        // 同じ名前が複数あるときは、同じ行に親ディレクトリ名があるものだけを採る。
        if (matched.length > 1) matched = matched.filter(script => code.split(NOT_NAME_CHAR).includes(path.basename(path.dirname(script))))
        for (const script of matched) named.add(script)
      }
    }
  }
  return named
}

// 名前の一部にならない文字。親ディレクトリ名を単語として探すのに使う。
const NOT_NAME_CHAR = /[^\w-]+/u
const SHELL_TOKEN = /[\w.-]*[\w-]\.sh(?![\w-])/gu

function isNamedBy(referrer: string, script: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- plugin ルート配下の固定の相対パス
  const lines = codeLines(readFileSync(path.join(pluginRoot, referrer), 'utf8'))
  return lines.some(line => line.match(SHELL_TOKEN)?.includes(path.basename(script)) === true)
}

describe('baseline.json の hooks.scripts', () => {
  it('列挙したスクリプトがすべて実在する', () => {
    const missing = readBaseline().hooks.scripts.filter(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- plugin ルート配下の固定の相対パス
      script => !existsSync(path.join(pluginRoot, script)),
    )
    expect(missing).toEqual([])
  })

  it('テストが名指しするスクリプトと間接に動くスクリプトで、すべてを覆っている', () => {
    const { scripts } = readBaseline().hooks
    const named = scriptsNamedByTests(scripts)
    const covered = new Set([...named, ...Object.keys(INDIRECT_SCRIPTS)])
    expect(scripts.filter(script => !covered.has(script))).toEqual([])
  })

  it('間接に動くスクリプトを、どのテストも名指ししていない', () => {
    const { scripts } = readBaseline().hooks
    const named = scriptsNamedByTests(scripts)
    const stale = Object.keys(INDIRECT_SCRIPTS).filter(script => named.has(script))
    expect(stale.toSorted(compareStrings)).toEqual([])
  })

  it('間接に動くスクリプトの呼び出し元が、そのスクリプトを実際に名指ししている', () => {
    const { scripts } = readBaseline().hooks
    const named = scriptsNamedByTests(scripts)
    const indirect = Object.keys(INDIRECT_SCRIPTS)
    const broken = Object.entries(INDIRECT_SCRIPTS).flatMap(([script, referrers]) => referrers
      .filter(referrer => !(named.has(referrer) || indirect.includes(referrer)) || !scripts.includes(referrer) || !isNamedBy(referrer, script))
      .map(referrer => `${referrer} -> ${script}`))
    expect(broken).toEqual([])
  })
})

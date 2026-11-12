// Bash の pecot 起動の deny（hooks/lib/core/pecot-cli-deny.sh）を確かめる。
// claude-bash-guards.sh からの接続は lib/bash-guard-responses.test.ts で確かめる。ここでは HOOK_COMMAND を直接渡して起動する。
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import { runShell } from './_helpers/run.js'
import type { HookRun } from './_helpers/run-hook.js'
import { createProject, runHook, writeHooksConfig } from './_helpers/run-hook.js'

// 定義書の 34 コマンド（cli.path）。MCP ツール名は、語を `_` でつなぎ `-` を `_` にした名前。
const commands: readonly (readonly string[])[] = [
  ['add-to-project'],
  ['create-branch'],
  ['delete-branch'],
  ['dependabot', 'sync'],
  ['issue', 'comment'],
  ['issue', 'create'],
  ['issue', 'quick'],
  ['issue', 'read'],
  ['issue', 'reopen'],
  ['pr', 'cleanup'],
  ['pr', 'create'],
  ['pr', 'preflight'],
  ['pr', 'read'],
  ['project', 'activate'],
  ['project', 'create'],
  ['project', 'info'],
  ['project', 'init'],
  ['project', 'list'],
  ['project', 'search'],
  ['project', 'set-aggregation-repo'],
  ['project', 'set-repo'],
  ['project', 'show-aggregation-repo'],
  ['project', 'unset-aggregation-repo'],
  ['release', 'create'],
  ['release', 'merge'],
  ['release', 'preflight'],
  ['security', 'sync'],
  ['session', 'restore'],
  ['session', 'status'],
  ['update-issue-status'],
  ['worktree', 'add'],
  ['worktree', 'init'],
  ['worktree', 'link'],
  ['worktree', 'remove'],
]

const launchers = [
  { label: 'pecot', launcher: 'pecot' },
  { label: '$PECOT', launcher: '$PECOT' },
  { label: 'クオート付きの $PECOT', launcher: '"$PECOT"' },
  { label: 'bin/pecot のフルパス', launcher: '/opt/plugins/pecot-workflow/bin/pecot' },
  { label: 'クオート付きのパス', launcher: '"${CLAUDE_PLUGIN_ROOT}/bin/pecot"' },
]

const toolListMarker = 'Use one of the MCP tools'

function compareText(a: string, b: string): number {
  return a.localeCompare(b)
}

function toolOf(words: readonly string[]): string {
  return words.join('_').replaceAll('-', '_')
}

function runDeny(command: string, projectDirectory = createProject()): HookRun {
  return runHook('lib/core/pecot-cli-deny.sh', { projectDirectory, env: { HOOK_COMMAND: command } })
}

describe('pecot-cli-deny', () => {
  it('34 コマンドの MCP ツール名が、hooks の一覧と一致する', () => {
    const script = path.resolve(import.meta.dirname, '../../../hooks/lib/core/pecot-tool-names.sh')
    const result = runShell(createHookCase(), String.raw`source "$1"; printf "%s\n" $PECOT_TOOL_NAMES`, [script])
    expect(commands.map(words => toolOf(words)).toSorted(compareText)).toEqual(result.stdout.split('\n').filter(Boolean).toSorted(compareText))
  })

  describe.for(launchers)('起動形が $label', ({ launcher }) => {
    it.for(commands.map(words => ({ name: words.join(' '), words })))('$name は、deny して対応するツール名を理由に入れる', ({ words }) => {
      const run = runDeny(`${launcher} ${words.join(' ')} -r owner/repo`)
      expect(run.status).toBe(1)
      expect(run.stdout).toContain(`MCP tool ${toolOf(words)} `)
      expect(run.stdout).not.toContain(toolListMarker)
    })
  })

  it.for([
    { command: 'pecot', note: 'pecot だけ' },
    { command: 'pecot --help', note: '--help だけ' },
    { command: 'pecot nosuch read', note: '一覧に無い語' },
    { command: 'pecot issue', note: 'グループだけ' },
    { command: 'pecot --repo o/r issue read 1', note: '先頭に --repo が来る形' },
  ])('$note のときは、MCP ツールの一覧を使うよう理由に書いて deny する', ({ command }) => {
    const run = runDeny(command)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain(toolListMarker)
    expect(run.stdout).toContain('issue_read')
  })

  it.for([
    { command: 'FOO=1 BAR=x pecot issue read 1', note: '環境変数の前置き' },
    { command: 'git status && pecot issue read 1', note: '&& の後ろ' },
    { command: 'git status; pecot issue read 1', note: '; の後ろ' },
    { command: 'git status\npecot issue read 1', note: '改行の後ろ' },
    { command: 'git log | pecot issue read 1', note: 'パイプの後ろ' },
    { command: 'echo $(pecot issue read 1)', note: 'コマンド置換の中' },
    { command: 'cat > body.md <<EOF\ntext\nEOF\npecot issue read 1', note: 'ヒアドキュメントの終端の後ろの行' },
    { command: 'cat <<\'EOF\'\ntext\nEOF\npecot issue read 1', note: '区切り語をクオートしたヒアドキュメントの後ろの行' },
    { command: 'cat <<-EOF\n\ttext\n\tEOF\npecot issue read 1', note: '<<- のヒアドキュメントの後ろの行' },
    { command: 'git commit -m "a << b"\npecot issue read 1', note: 'クオート内の << の後ろの行' },
    { command: 'cat <<< foo\npecot issue read 1', note: 'here-string の後ろの行' },
    { command: 'cd /x\npecot issue read 1 <<< "x"', note: 'here-string を引数に持つ行' },
  ])('$note でも、セグメントの先頭なら deny する', ({ command }) => {
    const run = runDeny(command)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('MCP tool issue_read ')
  })

  it.for([
    { command: 'pecot \\\n  issue read 1', note: '起動形の後ろの行継続' },
    { command: 'FOO=1 \\\n  pecot issue read 1', note: '環境変数の前置きの後ろの行継続' },
    { command: 'echo a && \\\npecot issue read 1', note: '&& の後ろの行継続' },
    { command: 'echo a \\\n  && pecot issue read 1', note: '行継続の次の行頭の &&' },
    { command: 'echo a\n\\\npecot issue read 1', note: '行頭の \\ だけの行の次' },
    { command: '# note \\\npecot issue read x', note: 'コメント行の末尾の \\ は、継続にしない' },
  ])('行末の \\ で続く行は連結して判定する: $note', ({ command }) => {
    const run = runDeny(command)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('MCP tool issue_read ')
  })

  it.for([
    { command: 'echo done # trailing \\\npecot project info', note: '行の途中から始まるコメントの末尾の \\ は、継続にしない' },
    { command: 'cat <<EOF \\\nbody\nEOF\npecot project info', note: 'ヒアドキュメントを始める行の末尾の \\ は、終端の次の行につなげない' },
    { command: 'cat <<-EOF \\\n\tbody\n\tEOF\npecot project info', note: '<<- を始める行の末尾の \\ も、終端の次の行につなげない' },
  ])('継続の状態を持ち越さない: $note', ({ command }) => {
    const run = runDeny(command)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('MCP tool project_info ')
  })

  it.for([
    { command: 'echo "pecot issue read"', note: '文字列の中' },
    { command: 'gh pr merge 1', note: 'gh pr merge' },
    { command: 'git status', note: 'git status' },
    { command: 'ls /opt/pecot', note: 'パスの引数' },
    { command: 'CLAUDE_PROJECT_DIR=/work/pecot bash run.sh', note: '環境変数の値のパス' },
    { command: 'pecot-tools aws s3 ls', note: '名前が pecot で始まる別のコマンド' },
    { command: '/work/pecot/scripts/run-tests.sh', note: 'パスの途中の pecot' },
    { command: 'cat <<EOF\npecot issue read 1\nEOF', note: 'ヒアドキュメントの本文の行' },
    { command: 'cat <<\'EOF\'\nRun `pecot pr create` after review.\nEOF', note: '本文のバッククォート内' },
    { command: 'cat <<EOF\nnote (pecot issue read is gone)\nEOF', note: '本文の括弧内' },
    { command: 'grep -rnE "gh|pecot" plugins/', note: 'クオート内の | をはさむ pecot' },
    { command: 'rg \'(uvx|pecot)\' hooks', note: 'クオート内の括弧と | をはさむ pecot' },
    { command: 'echo "a;pecot issue read 1"', note: 'クオート内の ; の後ろ' },
    { command: 'git worktree add \\\n/workspaces/wt3/pecot', note: '行末の \\ の次の行が …/pecot で終わる語（git worktree add）' },
    { command: 'git add \\\nplugins/pecot-workflow/bin/pecot \\\n  README.md', note: '継続行の先頭が …/bin/pecot で終わる語（git add）' },
    { command: 'ls \\\npecot', note: '継続行の先頭が pecot だけの語（ls の引数）' },
    { command: 'cat \\\n  $PECOT', note: '継続行の先頭が $PECOT（cat の引数）' },
    { command: 'echo a # pecot issue read 1', note: 'コメントの中の pecot' },
  ])('pecot を起動しない形（$note）は、無出力で素通しにする', ({ command }) => {
    const run = runDeny(command)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })

  // 先頭に起動形が来ない形は検出抜けになる。塞ぐのは別の Issue で決める。
  it.for([
    { command: '${PECOT} issue read 1', note: '${PECOT} の展開形' },
    { command: 'time pecot issue read 1', note: 'time の後ろ' },
    { command: 'env X=1 pecot issue read 1', note: 'env の後ろ' },
    { command: 'bash -c "pecot issue read 1"', note: 'bash -c の中' },
    { command: '{ pecot issue read 1; }', note: '{ } の中' },
    { command: 'if pecot issue read 1; then echo ok; fi', note: 'if の後ろ' },
    { command: 'foo=1 pecot issue read 1', note: '小文字の環境変数の前置き' },
    { command: 'X1=1 pecot issue read 1', note: '数字を含む環境変数の前置き' },
    { command: '! pecot issue read 1', note: '否定の記号の後ろ' },
    { command: 'command pecot issue read 1', note: 'command の後ろ' },
    { command: 'exec pecot issue read 1', note: 'exec の後ろ' },
    { command: 'sudo pecot issue read 1', note: 'sudo の後ろ' },
    { command: 'xargs pecot issue read 1', note: 'xargs の後ろ' },
    { command: 'pecot>out issue read 1', note: 'pecot の直後のリダイレクト' },
    { command: '"/my dir/bin/pecot" issue read 1', note: '空白を含むパスのクオート' },
  ])('今は素通しになる形（$note）を、そのまま固定する', ({ command }) => {
    const run = runDeny(command)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })

  describe('設定キー pecot-cli-deny', () => {
    it('false にすると、起動形でも無出力で素通しにする', () => {
      const project = createProject()
      writeHooksConfig(project, { 'pecot-cli-deny': false })
      const run = runDeny('pecot issue read 1', project)
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
    })

    it('true にすると、deny する', () => {
      const project = createProject()
      writeHooksConfig(project, { 'pecot-cli-deny': true })
      const run = runDeny('pecot issue read 1', project)
      expect(run.status).toBe(1)
      expect(run.stdout).toContain('MCP tool issue_read ')
    })

    it('他のキーだけを false にしても、deny する', () => {
      const project = createProject()
      writeHooksConfig(project, { 'claude-bash-guards': false, 'gh-pr-merge-ask': false })
      expect(runDeny('pecot issue read 1', project).status).toBe(1)
    })
  })

  it('HOOK_COMMAND が空だと、内部エラーで終える', () => {
    const run = runDeny('')
    expect(run.status).toBe(2)
    expect(run.stdout).toBe('')
  })
})

/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// hook-input.sh（hook 入力 JSON を PECOT_HOOK_* に export する）のテスト。
import { existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { coreDirectory } from '../_helpers/paths.js'
import { run } from '../_helpers/run.js'
import { jsonDumps } from '../_helpers/text.js'

const HOOK_INPUT = path.join(coreDirectory, 'hook-input.sh')

const VARIABLES = [
  'PECOT_HOOK_EVENT',
  'PECOT_HOOK_TOOL_NAME',
  'PECOT_HOOK_COMMAND',
  'PECOT_HOOK_CWD',
  'PECOT_HOOK_SESSION_ID',
  'PECOT_HOOK_TRANSCRIPT_PATH',
  'PECOT_HOOK_FILE_PATH',
  'PECOT_HOOK_PLAN_PATH',
  'PECOT_HOOK_SKILL_NAME',
  'PECOT_HOOK_SOURCE',
  'PECOT_HOOK_SESSION_TITLE',
  'PECOT_HOOK_COMMAND_OVERSIZE',
]

// 値を NUL 区切りで出す（改行を含む値を壊さない）。子プロセスから見えること（export）も確かめる。
const PRINT = String.raw`for v in ${VARIABLES.join(' ')}; do printf "%s\0" "${'${!v}'}"; done`
const DUMP = `source "$1" && pecot_hook_input_load "$2" && bash -c '${PRINT}'`
const DUMP_TWICE = `source "$1" && pecot_hook_input_load "$2" && pecot_hook_input_load "$3" && bash -c '${PRINT}'`

// 読み込んだ後の PECOT_HOOK_* の値を、変数名から引ける形で返す。
function load(hookCase: HookCase, ...payloads: readonly string[]): ReadonlyMap<string, string> {
  const script = payloads.length === 1 ? DUMP : DUMP_TWICE
  const out = run(hookCase, 'bash', ['-c', script, '_', HOOK_INPUT, ...payloads])
  expect(out).toMatchObject({ exitCode: 0 })
  const values = out.stdout.split('\0').slice(0, -1)
  expect(values).toHaveLength(VARIABLES.length)
  return new Map(VARIABLES.map((name, index) => [name, values.at(index) ?? '']))
}

describe('hook-input.sh', () => {
  it('Claude の Bash の入力を、PECOT_HOOK_* に読み込む', () => {
    const hookCase = createHookCase()
    const payload = jsonDumps({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: '/work/repo',
      session_id: 's-1',
      transcript_path: '/t/s-1.jsonl',
    })
    const got = load(hookCase, payload)
    expect(got.get('PECOT_HOOK_EVENT')).toBe('PreToolUse')
    expect(got.get('PECOT_HOOK_TOOL_NAME')).toBe('Bash')
    expect(got.get('PECOT_HOOK_COMMAND')).toBe('git status')
    expect(got.get('PECOT_HOOK_CWD')).toBe('/work/repo')
    expect(got.get('PECOT_HOOK_SESSION_ID')).toBe('s-1')
    expect(got.get('PECOT_HOOK_TRANSCRIPT_PATH')).toBe('/t/s-1.jsonl')
    expect(got.get('PECOT_HOOK_FILE_PATH')).toBe('')
  })

  it.for([
    // Claude の Read / Write / Edit
    { label: 'file_path', toolInput: { file_path: '/a/b.py' }, expected: '/a/b.py' },
    // NotebookEdit
    { label: 'notebook_path', toolInput: { notebook_path: '/a/n.ipynb' }, expected: '/a/n.ipynb' },
    // Copilot の Read / Edit
    { label: 'path', toolInput: { path: '/a/c.py', old_str: 'x', new_str: 'y' }, expected: '/a/c.py' },
  ])('tool_input の $label から、ファイルのパスを読む', (row) => {
    const hookCase = createHookCase()
    const got = load(hookCase, jsonDumps({ tool_name: 'Edit', tool_input: row.toolInput }))
    expect(got.get('PECOT_HOOK_FILE_PATH')).toBe(row.expected)
  })

  it('Copilot の apply_patch のように tool_input がパッチ文字列でも、受け入れる', () => {
    const hookCase = createHookCase()
    const got = load(hookCase, jsonDumps({ tool_name: 'Edit', tool_input: '*** Begin Patch\n*** End Patch', cwd: '/w' }))
    expect(got.get('PECOT_HOOK_TOOL_NAME')).toBe('Edit')
    expect(got.get('PECOT_HOOK_COMMAND')).toBe('')
    expect(got.get('PECOT_HOOK_FILE_PATH')).toBe('')
    expect(got.get('PECOT_HOOK_CWD')).toBe('/w')
  })

  it('skill の名前と plan のパスを読む', () => {
    const hookCase = createHookCase()
    const skill = load(hookCase, jsonDumps({ tool_name: 'skill', tool_input: { skill: 'w-help' } }))
    expect(skill.get('PECOT_HOOK_SKILL_NAME')).toBe('w-help')
    const plan = load(hookCase, jsonDumps({ tool_name: 'ExitPlanMode', tool_input: { plan: 'p', planFilePath: '/p/x.md' } }))
    expect(plan.get('PECOT_HOOK_PLAN_PATH')).toBe('/p/x.md')
  })

  it('引用符と改行を含むコマンドを、そのまま保ち、実行しない', () => {
    const hookCase = createHookCase()
    const marker = path.join(hookCase.temporaryPath, 'injected')
    const command = `echo 'a'; touch ${marker}\n"$(touch ${marker})" \`touch ${marker}\`\n'`
    const got = load(hookCase, jsonDumps({ tool_input: { command } }))
    expect(got.get('PECOT_HOOK_COMMAND')).toBe(command)
    expect(existsSync(marker)).toBe(false)
  })

  it.for([
    { label: '名前あり', extra: { session_title: '#1 a' }, title: '#1 a' },
    // eslint-disable-next-line unicorn/no-null -- session_title が null の入力を確かめる
    { label: 'null', extra: { session_title: null }, title: '' },
    { label: 'キーなし', extra: {}, title: '' },
  ])('session_title が $label のとき、source を読み、セッション名は $title になる', (row) => {
    const hookCase = createHookCase()
    const got = load(hookCase, jsonDumps({ hook_event_name: 'SessionStart', source: 'resume', ...row.extra }))
    expect(got.get('PECOT_HOOK_SOURCE')).toBe('resume')
    expect(got.get('PECOT_HOOK_SESSION_TITLE')).toBe(row.title)
  })

  it('2 回目の読み込みは、前の値を残さない', () => {
    const hookCase = createHookCase()
    const first = jsonDumps({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/a',
      session_id: 'old',
      source: 'startup',
      session_title: 'old title',
    })
    const second = jsonDumps({ tool_name: 'Read', tool_input: { path: '/x' } })
    const got = load(hookCase, first, second)
    expect(got.get('PECOT_HOOK_TOOL_NAME')).toBe('Read')
    expect(got.get('PECOT_HOOK_COMMAND')).toBe('')
    expect(got.get('PECOT_HOOK_CWD')).toBe('')
    expect(got.get('PECOT_HOOK_SESSION_ID')).toBe('')
    expect(got.get('PECOT_HOOK_FILE_PATH')).toBe('/x')
    expect(got.get('PECOT_HOOK_SOURCE')).toBe('')
    expect(got.get('PECOT_HOOK_SESSION_TITLE')).toBe('')
  })

  it.for([
    { label: '空文字', payload: '' },
    { label: 'JSON でない文字列', payload: 'not json' },
    { label: '空の配列', payload: '[]' },
    { label: 'null', payload: 'null' },
    { label: 'tool_input が null', payload: '{"tool_input":null}' },
  ])('入力が不正または空（$label）のとき、すべて空の値になる', (row) => {
    const hookCase = createHookCase()
    const got = load(hookCase, row.payload)
    expect(new Set(got.values())).toEqual(new Set(['']))
  })

  // 環境変数 1 個が 128KiB を超えると、その後の execve がすべて失敗する。
  // 上限を超えるコマンドは export せず（同じシェルの変数としては残す）、OVERSIZE=1 を渡す。
  describe('128KiB を超えるコマンド', () => {
    const SIZE_IN_SHELL = [
      'source "$1" && pecot_hook_input_load "$2" && ',
      'printf "%s|%s|%s" "${#PECOT_HOOK_COMMAND}" "${PECOT_HOOK_COMMAND_OVERSIZE}" ',
      '"$(bash -c \'printf "%s" "${PECOT_HOOK_COMMAND-unset}"\' | wc -c)"',
    ].join('')

    it.for([
      { label: '上限ちょうど', command: 'a'.repeat(60_000), chars: 60_000, oversize: '', childLength: 60_000 },
      { label: '上限を 1 文字超える', command: 'a'.repeat(60_001), chars: 60_001, oversize: '1', childLength: 'unset'.length },
      // 日本語は 1 文字 3 バイト。文字数では 25000 でも 75000 バイトなので超過扱いにする
      { label: 'マルチバイトで上限を超える', command: 'あ'.repeat(25_000), chars: 25_000, oversize: '1', childLength: 'unset'.length },
    ])('$label のとき、子プロセスへ export するかを切り替える', (row) => {
      const hookCase = createHookCase()
      // json.dumps(…, ensure_ascii=False) と同じバイト列にする（区切りは ", " と ": "、非 ASCII はそのまま）
      const payload = `{"tool_input": {"command": ${JSON.stringify(row.command)}}}`
      const out = run(hookCase, 'bash', ['-c', SIZE_IN_SHELL, '_', HOOK_INPUT, payload])
      expect(out).toMatchObject({ exitCode: 0 })
      expect(out.stdout).toBe(`${String(row.chars)}|${row.oversize}|${String(row.childLength)}`)
    })
  })

  it('OVERSIZE フラグは、次の読み込みでリセットされる', () => {
    const hookCase = createHookCase()
    const big = jsonDumps({ tool_input: { command: 'a'.repeat(70_000) } })
    const small = jsonDumps({ tool_input: { command: 'ls' } })
    const got = load(hookCase, big, small)
    expect(got.get('PECOT_HOOK_COMMAND')).toBe('ls')
    expect(got.get('PECOT_HOOK_COMMAND_OVERSIZE')).toBe('')
  })
})

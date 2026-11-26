/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// pecot-dir-init 起動の検知レイヤのテスト。
// user-prompt-submit.sh と pre-tool-use-skill.sh が `/pecot:` プレフィックスを正しく検知するかを確かめる。
// 判定は、.pecot ディレクトリを生成するか（= init 発火）で行う。どちらのエントリも、副作用は .pecot の生成だけなので実体を実行する。
import { mkdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createHookCase } from '../_helpers/environment.js'
import type { HookCase } from '../_helpers/environment.js'
import { hooksDirectory, pluginRoot } from '../_helpers/paths.js'
import { runScript } from '../_helpers/run.js'
import { extractReferences, resolveDirectoryVariables } from '../_helpers/script-references.js'
import { splitLines } from '../_helpers/text.js'
import { explains } from '../../_helpers/explains.js'

// 検知スクリプトを呼ぶエントリ × 参照変数 → lib サブディレクトリ。
const DIRECTORY_REFERENCE_ROWS = [
  { label: 'user-prompt-submit.sh の CORE_DIR', entry: 'user-prompt-submit.sh', directoryVariable: 'CORE_DIR', librarySubdirectory: 'lib/core' },
  { label: 'pre-tool-use-skill.sh の CORE_DIR', entry: 'pre-tool-use-skill.sh', directoryVariable: 'CORE_DIR', librarySubdirectory: 'lib/core' },
]

// CORE_DIR 自体の定義行のみ生パスを許す。
const DIRECTORY_ASSIGN = /^\s*CORE_DIR=/u

// <entry> が呼ぶ <librarySubdirectory> 配下のスクリプト名を返す。
function extractSubdirectoryReferences(entry: string, librarySubdirectory: string): string[] {
  const source = readFileSync(path.join(hooksDirectory, entry), 'utf8')
  const targetDirectory = path.join(hooksDirectory, librarySubdirectory)
  const references = extractReferences(source, hooksDirectory, pluginRoot)
  const referenced = references.filter(reference => path.dirname(reference.path) === targetDirectory).map(reference => path.basename(reference.path))
  // 参照を 1 件も抽出できないときは、ガードが空振りする
  expect(referenced.length, `${entry} から ${librarySubdirectory} 配下の参照を抽出できませんでした`).toBeGreaterThan(0)
  return referenced
}

interface DetectionEnvironment {
  readonly project: string
  readonly upsScript: string
  readonly ptusScript: string
}

// CLAUDE_PROJECT_DIR / PLUGIN 環境変数を設定する。
function setUpDetection(hookCase: HookCase): DetectionEnvironment {
  const project = path.join(hookCase.temporaryPath, 'project')
  mkdirSync(project, { recursive: true })
  hookCase.setEnv('CLAUDE_PROJECT_DIR', project)
  hookCase.setEnv('CLAUDE_PLUGIN_ROOT', pluginRoot)
  hookCase.setEnv('PLUGIN_HOOKS', hooksDirectory)
  return {
    project,
    upsScript: path.join(hooksDirectory, 'user-prompt-submit.sh'),
    ptusScript: path.join(hooksDirectory, 'pre-tool-use-skill.sh'),
  }
}

function isPecotDirectoryCreated(project: string): boolean {
  const pecot = path.join(project, '.pecot')
  return existsSync(pecot) && statSync(pecot).isDirectory()
}

// 静的ガード（生パス禁止・変数解決先の確認）。
// どちらのエントリもチェーン途中の rc を見ないため、参照先が崩れても実行時には表面化しない。
describe('検知スクリプトを呼ぶエントリの静的ガード', () => {
  // 解決先が別ディレクトリへ移ると、下のガードは何にもマッチせず常に通る。literal と実態をここで繋ぐ。
  // 参照が 0 件でも空集合同士の一致で通るため、参照の存在も固定する。
  it.for(DIRECTORY_REFERENCE_ROWS)('$label は、期待のサブディレクトリへ解決し、その配下への参照が 1 件以上ある', async (row) => {
    await explains(`検知スクリプトを呼ぶエントリのテストです。\`${row.label}\` が、期待するサブディレクトリを指すディレクトリ変数に解決され、その配下への参照が 1 件以上あることを確認します。`)
    const source = readFileSync(path.join(hooksDirectory, row.entry), 'utf8')
    const directoryVariables = resolveDirectoryVariables(source, hooksDirectory, pluginRoot)
    expect(directoryVariables.get(row.directoryVariable)).toBe(path.join(hooksDirectory, row.librarySubdirectory))
    expect(extractSubdirectoryReferences(row.entry, row.librarySubdirectory).length).toBeGreaterThan(0)
  })

  // `$SCRIPT_DIR/lib/core/foo.sh` のような生パスは、参照抽出と *_DIR の差し替えのどちらにも掛からない。変数経由に固定し、定義行だけ生パスを許す。
  it.for(DIRECTORY_REFERENCE_ROWS)('$label の配下は、変数経由でだけ参照する', async (row) => {
    await explains(`検知スクリプトを呼ぶエントリのテストです。\`${row.label}\` のサブディレクトリの配下を、生のパスではなくディレクトリ変数を通してだけ参照していることを確認します。`)
    const source = readFileSync(path.join(hooksDirectory, row.entry), 'utf8')
    const rawReferences = splitLines(source)
      .filter(line => line.includes(row.librarySubdirectory) && !DIRECTORY_ASSIGN.test(line))
      .map(line => line.trim())
    expect(rawReferences, `${row.entry} が ${row.librarySubdirectory}/ を生パスで参照しています`).toEqual([])
  })
})

describe('UserPromptSubmit', () => {
  // .prompt にはユーザーの生入力がそのまま渡り、短縮形で起動されたときは名前空間が付かない。
  // フル修飾だけを見ていると pecot 未使用リポで .pecot が作られない（#939）。
  it.for([
    { label: '名前空間付き', prompt: '/pecot-w:w-help' },
    { label: '名前空間なしの短縮形', prompt: '/w-help' },
    { label: '引数つきの短縮形', prompt: '/w-quick READMEのtypo修正' },
  ])('pecot のコマンド（$label）のとき、init が発火する', async (row) => {
    await explains(`UserPromptSubmit の検知スクリプトのテストです。pecot のコマンド（${row.label}）を入力した場合に、\`.pecot\` ディレクトリが作成される（初期化が起動する）ことを確認します。`)
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.upsScript, [], { stdin: `{"prompt": "${row.prompt}"}` })
    expect(result.exitCode).toBe(0)
    expect(isPecotDirectoryCreated(detection.project)).toBe(true)
  })

  it('通常の文のとき、init が発火せず、何も出力しない', async () => {
    await explains('UserPromptSubmit の検知スクリプトのテストです。通常の文を入力した場合に、`.pecot` ディレクトリを作成せず、標準出力に何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.upsScript, [], { stdin: '{"prompt": "今日の天気を教えて"}' })
    expect(result.exitCode).toBe(0)
    expect(isPecotDirectoryCreated(detection.project)).toBe(false)
    // UserPromptSubmit の stdout は全プロンプトへ文脈注入される。検知スクリプトが 1 バイトでも漏らすと全プロンプトが汚染されるため、無出力を固定する。
    expect(result.stdout).toBe('')
  })

  // 短縮形の捕捉は `w-` プレフィックス（pecot の命名規約）に限る。`/` 全般へ広げると pecot を使わないリポでも .pecot が作られる。
  it.for([
    { label: '/v-slidev', prompt: '/v-slidev' },
    { label: '/help', prompt: '/help' },
  ])('pecot 以外のスラッシュコマンド（$label）のとき、init が発火しない', async (row) => {
    await explains(`UserPromptSubmit の検知スクリプトのテストです。pecot 以外のスラッシュコマンド（${row.label}）を入力した場合に、\`.pecot\` ディレクトリを作成しないことを確認します。`)
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.upsScript, [], { stdin: `{"prompt": "${row.prompt}"}` })
    expect(result.exitCode).toBe(0)
    expect(isPecotDirectoryCreated(detection.project)).toBe(false)
  })

  it('コードブロック内の pecot のコマンドでは、誤発火しない', async () => {
    await explains('UserPromptSubmit の検知スクリプトのテストです。コードブロックの中に pecot のコマンドを書いた入力の場合に、誤って初期化を起動せず、`.pecot` ディレクトリを作成しないことを確認します。')
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.upsScript, [], { stdin: '{"prompt": "説明: `/pecot-w:w-help`"}' })
    expect(result.exitCode).toBe(0)
    expect(isPecotDirectoryCreated(detection.project)).toBe(false)
  })
})

// pecot-dir-init-detect.sh は `/pecot:` プレフィックスと `pecot:` skill を単一の `or` 式で判定する。
// UserPromptSubmit に .tool_input が無く PreToolUse に .prompt が無い前提は固定されていないので、以下 2 件で意味論を示す。
describe('統合式の意味論（クロス payload）', () => {
  // prompt が非 pecot でも `.tool_input.skill` が `pecot:` なら、init が動く。これが `or` 統合式の意味論になる。
  // ホスト payload にクロスフィールドが現れた場合の挙動を、宣言として固定する（変わったら意図的に判断し直す）。
  it('UserPromptSubmit に tool_input.skill が混入したとき、init が発火する', async () => {
    await explains('UserPromptSubmit と PreToolUse の検知式のテストです。UserPromptSubmit の入力に `tool_input.skill`（pecot のスキル）が混入した場合に、`.pecot` ディレクトリが作成され、標準出力は空であることを確認します。')
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.upsScript, [], {
      stdin: '{"prompt": "今日の天気を教えて", "tool_input": {"skill": "pecot-w:w-help"}}',
    })
    expect(result.exitCode).toBe(0)
    expect(isPecotDirectoryCreated(detection.project)).toBe(true)
    // 発火しても検知スクリプトは stdout へ何も出さない（全プロンプト汚染の防止）。
    expect(result.stdout).toBe('')
  })

  // skill が非 pecot でも `.prompt` が `/pecot:` なら、init が動く。これが `or` 統合式の意味論になる。
  // ホスト payload にクロスフィールドが現れた場合の挙動を、宣言として固定する（変わったら意図的に判断し直す）。
  it('PreToolUse(Skill) に prompt が混入したとき、init が発火する', async () => {
    await explains('UserPromptSubmit と PreToolUse の検知式のテストです。PreToolUse(Skill) の入力に pecot のコマンドを含む `prompt` が混入した場合に、`.pecot` ディレクトリが作成されることを確認します。')
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.ptusScript, [], {
      stdin: '{"prompt": "/pecot-w:w-help", "tool_input": {"skill": "claude-code-guide"}}',
    })
    expect(result.exitCode).toBe(0)
    expect(isPecotDirectoryCreated(detection.project)).toBe(true)
  })
})

describe('PreToolUse(Skill)', () => {
  it('pecot の skill のとき、init が発火する', async () => {
    await explains('PreToolUse(Skill) の検知スクリプトのテストです。pecot のスキルを入力した場合に、`.pecot` ディレクトリが作成される（初期化が起動する）ことを確認します。')
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.ptusScript, [], { stdin: '{"tool_input": {"skill": "pecot-w:w-help"}}' })
    expect(result.exitCode).toBe(0)
    expect(isPecotDirectoryCreated(detection.project)).toBe(true)
  })

  it('pecot 以外の skill のとき、init が発火しない', async () => {
    await explains('PreToolUse(Skill) の検知スクリプトのテストです。pecot 以外のスキルを入力した場合に、`.pecot` ディレクトリを作成しないことを確認します。')
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.ptusScript, [], { stdin: '{"tool_input": {"skill": "claude-code-guide"}}' })
    expect(result.exitCode).toBe(0)
    expect(isPecotDirectoryCreated(detection.project)).toBe(false)
  })

  // 決まりの注入は撤廃した（spec 025 FR-010）。
  it('pecot の skill のとき、何も出力しない', async () => {
    await explains('PreToolUse(Skill) の検知スクリプトのテストです。pecot のスキルを入力した場合に、標準出力に何も出力せず、`.pecot` ディレクトリが作成されることを確認します。')
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.ptusScript, [], { stdin: '{"tool_input": {"skill": "pecot-w:w-help"}}' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
    expect(isPecotDirectoryCreated(detection.project)).toBe(true)
  })

  it('pecot 以外の skill のとき、何も出力しない', async () => {
    await explains('PreToolUse(Skill) の検知スクリプトのテストです。pecot 以外のスキルを入力した場合に、標準出力に何も出力しないことを確認します。')
    const hookCase = createHookCase()
    const detection = setUpDetection(hookCase)
    const result = runScript(hookCase, detection.ptusScript, [], { stdin: '{"tool_input": {"skill": "claude-code-guide"}}' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})

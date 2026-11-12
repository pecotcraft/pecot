/* eslint-disable security/detect-non-literal-fs-filename -- 読むのは hooks 配下と、ケースの一時ディレクトリ配下のみ */
// hooks 全域のスクリプトが参照する lib とテンプレが実在するかの静的な確認。抽出は _helpers/script-references.ts を使う。
import { globSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { compareStrings } from '../parity/baseline.js'
import { createHookCase } from './_helpers/environment.js'
import { isFile } from './_helpers/files.js'
import { toArray, toRecord } from './_helpers/json.js'
import { hooksDirectory, pluginRoot } from './_helpers/paths.js'
import {
  codeLines,
  extractReferences,
  extractTemplateReferences,
  resolveDirectoryVariables,
} from './_helpers/script-references.js'
import type { LibraryReference } from './_helpers/script-references.js'
import { comparePathParts, parseJson } from './_helpers/text.js'

const entryPoints = globSync('*.sh', { cwd: hooksDirectory }).toSorted(comparePathParts)
// lib/tests/ はテスト資材なので外す。
const libraryScripts = globSync('lib/**/*.sh', { cwd: hooksDirectory })
  .filter(relative => !relative.split('/').includes('tests'))
  .toSorted(comparePathParts)
const guardedScripts: readonly string[] = [...entryPoints, ...libraryScripts]

// 列挙が空振りして全件通るのを防ぐ下限。
const MIN_GUARDED_SCRIPTS = 60
const MIN_RESOLVED_REFERENCES = 90
const MIN_RESOLVED_TEMPLATE_REFERENCES = 2

const CONFIG_FILES: readonly string[] = ['hooks.json', '../com.github.copilot/hooks/hooks.json']
const PLUGIN_ROOT_PREFIX = '${CLAUDE_PLUGIN_ROOT}/'

// 抽出器とは独立な「鈍い」走査。
const BLUNT_SH_TOKEN = /[\w./${}%*-]*\.sh(?![\w-])/gu
// `templates/` の直前の否定後読みは、`mytemplates/x.md` から切り出さないためのセグメント境界。

const BLUNT_TEMPLATE_TOKEN = /[\w./${}%*-]*(?<![\w.-])templates\/[\w./${}%*-]*\.md(?![\w-])/gu
// config-dispatcher.sh 側の PLUGIN_HOOKS の根拠行。代入と `${CLAUDE_PLUGIN_ROOT}/hooks` を 1 行内に要求する。
const HOOKS_ROOT_DERIVATION = /^\s*PLUGIN_HOOKS=.*\$\{CLAUDE_PLUGIN_ROOT\}\/hooks/mu

function scriptPath(relative: string): string {
  return path.join(hooksDirectory, relative)
}

function readText(target: string): string {
  return readFileSync(target, 'utf8')
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- RegExp は読むだけ
function allMatches(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), match => match[0])
}

function bluntShTokens(text: string): string[] {
  return codeLines(text).flatMap(line => allMatches(line, BLUNT_SH_TOKEN))
}

function missingReferencePaths(references: readonly LibraryReference[]): string[] {
  const missing = references.filter(reference => !isFile(reference.path)).map(reference => reference.path)
  return [...new Set(missing)].toSorted(compareStrings)
}

// 鈍い走査で得た全 `.sh` トークンと、抽出器が解決したトークンを、多重集合として比べるために並べて返す。
// `/` を含まない自ファイル名は usage 文字列の自己言及なので、会計から外す。
function tokenAccounting(text: string, references: readonly LibraryReference[], ownName: string): [string[], string[]] {
  const blunt = bluntShTokens(text).filter(token => token.includes('/') || token !== ownName)
  return [blunt.toSorted(compareStrings), references.map(reference => reference.token).toSorted(compareStrings)]
}

function templateTokenAccounting(text: string, references: readonly LibraryReference[]): [string[], string[]] {
  const blunt = codeLines(text).flatMap(line => allMatches(line, BLUNT_TEMPLATE_TOKEN))
  return [blunt.toSorted(compareStrings), references.map(reference => reference.token).toSorted(compareStrings)]
}

// hooks 設定の command から、plugin root 相対のスクリプトのパスを取り出す。
function configCommandScripts(configName: string): string[] {
  const parsed = parseJson(readText(scriptPath(configName)))
  const data = toRecord(parsed, configName)
  const scripts: string[] = []
  const events = Object.values(toRecord(data['hooks'], 'hooks'))
  const blocks = events.flatMap(entries => toArray(entries, 'hooks のイベント'))
  const hooks = blocks.flatMap(block => toArray(toRecord(block, 'エントリ')['hooks'], 'エントリの hooks'))
  for (const hook of hooks) {
    const command = toRecord(hook, 'hook')['command']
    if (typeof command !== 'string') throw new TypeError('command が文字列ではありません')
    // クォートの有無は比較の対象外。command は変数をクォートする。
    const tokens = allMatches(command.replaceAll('"', ''), BLUNT_SH_TOKEN)
    expect(tokens, `command から \`.sh\` を抽出できませんでした: ${command}`).not.toHaveLength(0)
    for (const token of tokens) {
      expect(token.startsWith(PLUGIN_ROOT_PREFIX), `command が \${CLAUDE_PLUGIN_ROOT} 起点でありません: ${command}`).toBe(true)
      scripts.push(token.slice(PLUGIN_ROOT_PREFIX.length))
    }
  }
  return scripts
}

const SYNTHETIC_NAME = 'synthetic-entry.sh'
const SYNTHETIC_HEADER
  = '#!/bin/bash\n'
    + 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
    + 'LIB_DIR="$SCRIPT_DIR/lib/pre-tool-use"\n'
// config-dispatcher.sh を source する lib 配下スクリプトの合成ヘッダ。PLUGIN_HOOKS の seed の条件を満たす。
const SYNTHETIC_LIBRARY_HEADER
  = '#!/bin/bash\n'
    + 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
    + 'source "${SCRIPT_DIR%/*}/core/config-dispatcher.sh"\n'
const adaptersDirectory = path.join(hooksDirectory, 'lib', 'adapters')
const syntheticLibraryDirectory = path.join(hooksDirectory, 'lib', 'post-tool-use')

describe('hooks のスクリプトの参照先', () => {
  describe('対象の列挙', () => {
    it.for(CONFIG_FILES.map(label => ({ label })))('hooks 設定 $label の command の指すスクリプトは実在する', (row) => {
      const scripts = configCommandScripts(row.label)
      expect(scripts, `${row.label} から command を抽出できませんでした`).not.toHaveLength(0)
      const missing = [...new Set(scripts.filter(script => !isFile(path.join(pluginRoot, script))))].toSorted(compareStrings)
      expect(missing, `${row.label} の command が実在しないスクリプトを指しています`).toEqual([])
    })

    it('hooks 設定の command はすべてエントリポイントを指す', () => {
      const enumerated = new Set(entryPoints.map(relative => path.posix.join('hooks', relative)))
      for (const configName of CONFIG_FILES) {
        const scripts = configCommandScripts(configName)
        expect(scripts, `${configName} から command を抽出できませんでした`).not.toHaveLength(0)
        const unenumerated = [...new Set(scripts)].filter(script => !enumerated.has(script)).toSorted(compareStrings)
        expect(unenumerated, `${configName} の command がエントリポイント（hooks/ 直下）ではありません。hooks 設定は lib 内部を直接指さない規約`).toEqual([])
      }
    })

    it('ガード対象の列挙は下限を割らない', () => {
      expect(guardedScripts.length, `ガード対象が ${String(guardedScripts.length)} 件しか列挙できていません`).toBeGreaterThanOrEqual(MIN_GUARDED_SCRIPTS)
      expect(entryPoints.length, 'hooks/ 直下のエントリポイントが 0 件です').toBeGreaterThan(0)
      expect(libraryScripts.length, 'lib 配下のスクリプトが 0 件です').toBeGreaterThan(0)
    })

    it('全対象を通算した解決参照の数は下限を割らない', () => {
      const total = guardedScripts
        .map(relative => extractReferences(readText(scriptPath(relative)), path.dirname(scriptPath(relative)), pluginRoot).length)
        .reduce((sum, count) => sum + count, 0)
      expect(total, `解決できた参照が通算 ${String(total)} 件しかありません`).toBeGreaterThanOrEqual(MIN_RESOLVED_REFERENCES)
    })

    it('全対象を通算した解決テンプレ参照の数は下限を割らない', () => {
      const total = guardedScripts
        .map(relative => extractTemplateReferences(readText(scriptPath(relative)), path.dirname(scriptPath(relative)), pluginRoot).length)
        .reduce((sum, count) => sum + count, 0)
      expect(total, `解決できたテンプレ参照が通算 ${String(total)} 件しかありません`).toBeGreaterThanOrEqual(MIN_RESOLVED_TEMPLATE_REFERENCES)
    })
  })

  describe('参照の実在とトークン会計', () => {
    const rows = guardedScripts.map(label => ({ label }))

    it.for(rows)('$label が呼ぶ lib スクリプトはすべて実在する', (row) => {
      const target = scriptPath(row.label)
      const references = extractReferences(readText(target), path.dirname(target), pluginRoot)
      expect(missingReferencePaths(references), `${row.label} が存在しないスクリプトを呼んでいます`).toEqual([])
    })

    it.for(rows)('$label の非コメント行の .sh トークンはすべて抽出器が解決している', (row) => {
      const target = scriptPath(row.label)
      const text = readText(target)
      const references = extractReferences(text, path.dirname(target), pluginRoot)
      const [blunt, extracted] = tokenAccounting(text, references, path.basename(target))
      const unresolved = [...new Set(blunt)].filter(token => !extracted.includes(token)).toSorted(compareStrings)
      expect(blunt, `${row.label} の .sh トークンに抽出器が解決していないものがあります。未解決: ${JSON.stringify(unresolved)}`).toEqual(extracted)
    })

    it.for(rows)('$label が読むテンプレはすべて実在する', (row) => {
      const target = scriptPath(row.label)
      const references = extractTemplateReferences(readText(target), path.dirname(target), pluginRoot)
      expect(missingReferencePaths(references), `${row.label} が存在しないテンプレを参照しています`).toEqual([])
    })

    it.for(rows)('$label の非コメント行のテンプレトークンはすべて抽出器が解決している', (row) => {
      const target = scriptPath(row.label)
      const text = readText(target)
      const references = extractTemplateReferences(text, path.dirname(target), pluginRoot)
      const [blunt, extracted] = templateTokenAccounting(text, references)
      const unresolved = [...new Set(blunt)].filter(token => !extracted.includes(token)).toSorted(compareStrings)
      expect(blunt, `${row.label} のテンプレトークンに抽出器が解決していないものがあります。未解決: ${JSON.stringify(unresolved)}`).toEqual(extracted)
    })
  })

  describe('抽出器の前提', () => {
    it('config-dispatcher.sh は ${CLAUDE_PLUGIN_ROOT}/hooks から PLUGIN_HOOKS を導く行を持つ', () => {
      const dispatcher = readText(path.join(hooksDirectory, 'lib', 'core', 'config-dispatcher.sh'))
      expect(HOOKS_ROOT_DERIVATION.test(dispatcher), 'PLUGIN_HOOKS の導出行がありません。PLUGIN_HOOKS の seed の前提が崩れています').toBe(true)
    })
  })

  describe('抽出器の自己テスト', () => {
    it('実在しない lib への参照を検出する', () => {
      const text = `${SYNTHETIC_HEADER}echo "$INPUT" | "$LIB_DIR/does-not-exist.sh"\n`
      const references = extractReferences(text, hooksDirectory, pluginRoot)
      expect(missingReferencePaths(references)).toEqual([path.join(hooksDirectory, 'lib', 'pre-tool-use', 'does-not-exist.sh')])
    })

    it('未知のディレクトリ変数の参照は解決せずエラーにする', () => {
      const text = `${SYNTHETIC_HEADER}"$UNKNOWN_DIR/handler.sh"\n`
      expect(() => extractReferences(text, hooksDirectory, pluginRoot)).toThrow('UNKNOWN_DIR')
    })

    it('値が .sh で終わる代入はディレクトリ変数として登録しない', () => {
      const text = `${SYNTHETIC_HEADER}HELPER="$LIB_DIR/helper.sh"\n`
      expect(resolveDirectoryVariables(text, hooksDirectory, pluginRoot).has('HELPER')).toBe(false)
      expect(() => extractReferences(`${text}"$HELPER/nested.sh"\n`, hooksDirectory, pluginRoot)).toThrow('$HELPER/nested.sh')
    })

    it('.sh 以外の拡張子を持つ値もディレクトリ変数として登録しない', () => {
      const text = `${SYNTHETIC_LIBRARY_HEADER}TEMPLATE="\${PLUGIN_HOOKS}/templates/reminder.md"\n`
      expect(resolveDirectoryVariables(text, adaptersDirectory, pluginRoot).has('TEMPLATE')).toBe(false)
      expect(() => extractReferences(`${text}"$TEMPLATE/nested.sh"\n`, adaptersDirectory, pluginRoot)).toThrow('$TEMPLATE/nested.sh')
    })

    it('同名のディレクトリ変数を 2 回代入するとエラーにする', () => {
      const text = `${SYNTHETIC_HEADER}LIB_DIR="$SCRIPT_DIR/lib/post-tool-use"\n"$LIB_DIR/auto-push.sh"\n`
      expect(() => extractReferences(text, hooksDirectory, pluginRoot)).toThrow('LIB_DIR')
    })

    it('seed 済みの PLUGIN_HOOKS への実代入は重複として扱わない', () => {
      const text = `${SYNTHETIC_LIBRARY_HEADER}PLUGIN_HOOKS="\${CLAUDE_PLUGIN_ROOT}/hooks"\n`
      const directoryVariables = resolveDirectoryVariables(text, adaptersDirectory, pluginRoot)
      expect(directoryVariables.get('PLUGIN_HOOKS')).toBe(path.join(pluginRoot, 'hooks'))
    })

    it('CLAUDE_PLUGIN_ROOT の再代入は、seed の除外が PLUGIN_HOOKS に限られるのでエラーにする', () => {
      const text = `${SYNTHETIC_LIBRARY_HEADER}CLAUDE_PLUGIN_ROOT="$SCRIPT_DIR/elsewhere"\n`
      expect(() => extractReferences(text, adaptersDirectory, pluginRoot)).toThrow('CLAUDE_PLUGIN_ROOT')
    })

    it('変数プレフィックスのない参照は抽出されず、会計の不一致として現れる', () => {
      const text = `${SYNTHETIC_HEADER}bash lib/pre-tool-use/handler.sh\n`
      const references = extractReferences(text, hooksDirectory, pluginRoot)
      const [blunt, extracted] = tokenAccounting(text, references, SYNTHETIC_NAME)
      expect(extracted).toEqual([])
      expect(blunt).toEqual(['lib/pre-tool-use/handler.sh'])
    })

    it('自ファイル名の裸トークン（usage 文字列）は会計から外れる', () => {
      const text = `${SYNTHETIC_HEADER}echo "Usage: ${SYNTHETIC_NAME} <core-script>" >&2\n`
      const references = extractReferences(text, hooksDirectory, pluginRoot)
      expect(tokenAccounting(text, references, SYNTHETIC_NAME)).toEqual([[], []])
    })

    it('自己名の例外は他ファイルの裸 basename まで免除しない', () => {
      const text = `${SYNTHETIC_HEADER}echo "Usage: other-handler.sh <core-script>" >&2\n`
      const references = extractReferences(text, hooksDirectory, pluginRoot)
      const [blunt, extracted] = tokenAccounting(text, references, SYNTHETIC_NAME)
      expect(extracted).toEqual([])
      expect(blunt).toEqual(['other-handler.sh'])
    })

    it('.sh で始まる別拡張子（foo.shellcheckrc）は偽トークンにしない', () => {
      const text = `${SYNTHETIC_HEADER}cat "$LIB_DIR/foo.shellcheckrc"\n`
      const references = extractReferences(text, hooksDirectory, pluginRoot)
      expect(tokenAccounting(text, references, SYNTHETIC_NAME)).toEqual([[], []])
    })

    it('行頭と行末のコメント内の .sh は両系統とも 0 件になる', () => {
      const text
        = `${SYNTHETIC_HEADER}# merge-hook-outputs.sh で出力を統合する\n`
          + 'export HOOK_EVENT_NAME="PreToolUse"  # auto-push.sh 側で参照する\n'
      const references = extractReferences(text, hooksDirectory, pluginRoot)
      expect(tokenAccounting(text, references, SYNTHETIC_NAME)).toEqual([[], []])
    })

    it('BASH_SOURCE 版の自己ディレクトリ、${VAR} 形、サブディレクトリ、CLAUDE_PLUGIN_ROOT を解決する', () => {
      const text
        = '#!/bin/bash\n'
          + 'SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n'
          + 'GUARD_DIR="$SELF_DIR/lib"\n'
          + 'echo "$INPUT" | "${GUARD_DIR}/adapters/claude-bash-guards.sh"\n'
          + '"${CLAUDE_PLUGIN_ROOT}/hooks/lib/core/pecot-dir-init.sh"\n'
      const references = extractReferences(text, hooksDirectory, pluginRoot)
      expect(references.map(reference => reference.path)).toEqual([
        path.join(hooksDirectory, 'lib', 'adapters', 'claude-bash-guards.sh'),
        path.join(pluginRoot, 'hooks', 'lib', 'core', 'pecot-dir-init.sh'),
      ])
      expect(missingReferencePaths(references)).toEqual([])
    })

    it('${VAR%/*} の親ディレクトリ剥がしは 1 段上を起点に解決する', () => {
      const text = `${SYNTHETIC_LIBRARY_HEADER}source "\${SCRIPT_DIR%/*}/core/branch-guard.sh"\n`
      const references = extractReferences(text, adaptersDirectory, pluginRoot)
      expect(references.map(reference => reference.path)).toEqual([
        path.join(hooksDirectory, 'lib', 'core', 'config-dispatcher.sh'),
        path.join(hooksDirectory, 'lib', 'core', 'branch-guard.sh'),
      ])
      expect(missingReferencePaths(references)).toEqual([])
    })

    it('%/* 以外の % 修飾は解決せずエラーにする', () => {
      const text = `${SYNTHETIC_LIBRARY_HEADER}source "\${SCRIPT_DIR%/lib/*}/core/branch-guard.sh"\n`
      expect(() => extractReferences(text, adaptersDirectory, pluginRoot)).toThrow('SCRIPT_DIR%/lib/*')
    })

    it('config-dispatcher.sh を source していれば ${PLUGIN_HOOKS} 起点を解決する', () => {
      const text = `${SYNTHETIC_LIBRARY_HEADER}CORE_DIR="\${PLUGIN_HOOKS}/lib/core"\n"$CORE_DIR/branch-guard.sh"\n`
      const references = extractReferences(text, adaptersDirectory, pluginRoot)
      expect(references.map(reference => reference.path)).toEqual([
        path.join(hooksDirectory, 'lib', 'core', 'config-dispatcher.sh'),
        path.join(hooksDirectory, 'lib', 'core', 'branch-guard.sh'),
      ])
      expect(missingReferencePaths(references)).toEqual([])
    })

    it('config-dispatcher.sh を source しないスクリプトの ${PLUGIN_HOOKS} は未解決にする', () => {
      const text = `${SYNTHETIC_HEADER}"\${PLUGIN_HOOKS}/lib/core/branch-guard.sh"\n`
      expect(() => extractReferences(text, hooksDirectory, pluginRoot)).toThrow('PLUGIN_HOOKS')
    })

    it('末尾に config-dispatcher.sh を含む別名ファイルの source では seed しない', () => {
      const text
        = '#!/bin/bash\n'
          + 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
          + 'source "${SCRIPT_DIR%/*}/core/my-config-dispatcher.sh"\n'
          + '"${PLUGIN_HOOKS}/lib/core/branch-guard.sh"\n'
      expect(resolveDirectoryVariables(text, adaptersDirectory, pluginRoot).has('PLUGIN_HOOKS')).toBe(false)
      expect(() => extractReferences(text, adaptersDirectory, pluginRoot)).toThrow('PLUGIN_HOOKS')
    })

    it('崩れた symlink への参照を実在ありと判定しない', () => {
      const hookCase = createHookCase()
      const coreDirectory = path.join(hookCase.temporaryPath, 'hooks', 'lib', 'core')
      mkdirSync(coreDirectory, { recursive: true })
      symlinkSync(path.join(hookCase.temporaryPath, 'nowhere.sh'), path.join(coreDirectory, 'dangling.sh'))
      const text = `${SYNTHETIC_HEADER}"$SCRIPT_DIR/lib/core/dangling.sh"\n`
      const references = extractReferences(text, path.join(hookCase.temporaryPath, 'hooks'), hookCase.temporaryPath)
      expect(missingReferencePaths(references)).toEqual([path.join(coreDirectory, 'dangling.sh')])
    })
  })

  describe('テンプレ参照抽出器の自己テスト', () => {
    it('実在しないテンプレへの参照を検出する', () => {
      const text = `${SYNTHETIC_LIBRARY_HEADER}TEMPLATE="\${PLUGIN_HOOKS}/templates/does-not-exist.md"\n`
      const references = extractTemplateReferences(text, syntheticLibraryDirectory, pluginRoot)
      expect(missingReferencePaths(references)).toEqual([path.join(hooksDirectory, 'templates', 'does-not-exist.md')])
    })

    it('config-dispatcher.sh を source しないスクリプトのテンプレ参照は未解決にする', () => {
      const text = `${SYNTHETIC_HEADER}TEMPLATE="\${PLUGIN_HOOKS}/templates/reminder.md"\n`
      expect(() => extractTemplateReferences(text, hooksDirectory, pluginRoot)).toThrow('PLUGIN_HOOKS')
    })

    it('コメント内のテンプレ参照は抽出と会計のどちらでも 0 件になる', () => {
      const text
        = `${SYNTHETIC_LIBRARY_HEADER}# \${PLUGIN_HOOKS}/templates/reminder.md を読み込む\n`
          + 'MODE="quick"  # ${PLUGIN_HOOKS}/templates/reminder-quick.md を使う\n'
      const references = extractTemplateReferences(text, syntheticLibraryDirectory, pluginRoot)
      expect(templateTokenAccounting(text, references)).toEqual([[], []])
    })

    it('.md で始まる別拡張子（x.mdx）は偽のテンプレトークンにしない', () => {
      const text = `${SYNTHETIC_LIBRARY_HEADER}TEMPLATE="\${PLUGIN_HOOKS}/templates/reminder.mdx"\n`
      const references = extractTemplateReferences(text, syntheticLibraryDirectory, pluginRoot)
      expect(templateTokenAccounting(text, references)).toEqual([[], []])
    })

    it('templates/ セグメントを含まない .md は抽出と会計のどちらの対象にもならない', () => {
      const text
        = `${SYNTHETIC_LIBRARY_HEADER}PLAN_FILE="$HOME/.claude/plans/\${SLUG}.md"\n`
          + 'echo "CLAUDE.mdのルール"\n'
      const references = extractTemplateReferences(text, syntheticLibraryDirectory, pluginRoot)
      expect(templateTokenAccounting(text, references)).toEqual([[], []])
    })

    it('hooks/templates/x.md のような深い相対パスも対象に入る', () => {
      const text = `${SYNTHETIC_HEADER}REMIND="\${CLAUDE_PLUGIN_ROOT}/hooks/templates/exit-plan-comment-update.md"\n`
      const references = extractTemplateReferences(text, hooksDirectory, pluginRoot)
      expect(references.map(reference => reference.path)).toEqual([path.join(hooksDirectory, 'templates', 'exit-plan-comment-update.md')])
      expect(missingReferencePaths(references)).toEqual([])
    })
  })
})

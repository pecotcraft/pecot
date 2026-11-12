// hooks スクリプトの lib・テンプレ参照の静的な抽出。
//
// 解決できない参照が 1 件でもあれば throw する（fail-closed）。dir 変数の写像は Map<変数名, 実パス>。
// パスの連結は path.join なので `..` を畳む。
import path from 'node:path'

import { splitLines } from './text.js'

const COMMENT_LINE = /^\s*#/u

// 自己ディレクトリ変数は、識別子名を決め打ちせず、代入イディオムから認識する。
const SELF_DIR_ASSIGN = /^\s*(?<name>[A-Za-z_]\w*)="\$\(cd "\$\(dirname "(?:\$0|\$\{BASH_SOURCE\[0\]\})"\)" && pwd\)"\s*$/u
// 既知ディレクトリ変数からの派生代入（LIB_DIR="$SCRIPT_DIR/lib/notification" など）。
const DERIVED_DIR_ASSIGN = /^\s*(?<name>[A-Za-z_]\w*)="\$\{?(?<base>[A-Za-z_]\w*)\}?\/(?<relative>[^"$]+)"\s*$/u
// 末尾の否定先読みは、`foo.shellcheckrc` から `foo.sh` を切り出さないための語境界。
// eslint-disable-next-line security/detect-unsafe-regex -- 入力は hooks の shell スクリプト。量指定子は固定の区切りで終わり、バックトラックは増えない
const VAR_SH_REF = /\$(?:\{(?<braced>[A-Za-z_]\w*)(?<modifier>%[^}]*)?\}|(?<bare>[A-Za-z_]\w*))\/(?<relative>[\w./-]+\.sh)(?![\w-])/gu
// relative が templates/ セグメントを含む .md だけを対象にする。
// eslint-disable-next-line security/detect-unsafe-regex -- 同上（templates/ までの入れ子の量指定子は '/' で区切られる）
const VAR_MD_TEMPLATE_REF = /\$(?:\{(?<braced>[A-Za-z_]\w*)(?<modifier>%[^}]*)?\}|(?<bare>[A-Za-z_]\w*))\/(?<relative>(?:[\w.-]+\/)*templates\/[\w./-]+\.md)(?![\w-])/gu
// 解決できる唯一の `%` 修飾。親ディレクトリ剥がしは dir 変数の親から解決する。
const PARENT_STRIP_MODIFIER = '%/*'
// config-dispatcher.sh を source する行。source 済みのスクリプトだけが PLUGIN_HOOKS の seed を受ける。
const CONFIG_DISPATCHER_SOURCE = /^\s*(?:source|\.)\s.*(?<![\w.-])config-dispatcher\.sh(?![\w.-])/u

const PLUGIN_ROOT_VAR = 'CLAUDE_PLUGIN_ROOT'
const PLUGIN_HOOKS_VAR = 'PLUGIN_HOOKS'

export interface LibraryReference {
  // ソース上の生表記
  readonly token: string
  // 解決後の実パス
  readonly path: string
}

// 行頭コメント行を落とし、残る行から行末コメントを最初の `#` で切り落とす。
export function codeLines(text: string): string[] {
  return splitLines(text)
    .filter(line => !COMMENT_LINE.test(line))
    .map(line => line.split('#', 1)[0] ?? '')
}

// 末端要素に `.` を含む相対パスをファイルパスとみなす。dir 変数に登録しないための判定。
export function isFileLike(relative: string): boolean {
  return (relative.split('/').at(-1) ?? '').includes('.')
}

function resolveDirectoryVariablesFromLines(lines: readonly string[], scriptDirectory: string, pluginRoot: string): Map<string, string> {
  const directoryVariables = new Map<string, string>([[PLUGIN_ROOT_VAR, pluginRoot]])
  if (lines.some(line => CONFIG_DISPATCHER_SOURCE.test(line))) directoryVariables.set(PLUGIN_HOOKS_VAR, path.join(pluginRoot, 'hooks'))
  // seed した PLUGIN_HOOKS への実代入は、重複の判定から外して seed 値を維持する。
  const isSeedKept = directoryVariables.has(PLUGIN_HOOKS_VAR)

  const register = (name: string, resolved: string): void => {
    if (isSeedKept && name === PLUGIN_HOOKS_VAR) return
    const previous = directoryVariables.get(name)
    if (previous !== undefined) {
      throw new Error(
        `ディレクトリ変数 ${name} が 2 回代入されています（解決先: ${previous} → ${resolved}）。`
        + 'last-wins で先行代入を使う分岐の参照が静かに誤解決されるため、変数名を分けてください',
      )
    }
    directoryVariables.set(name, resolved)
  }

  for (const line of lines) {
    const selfDirectory = SELF_DIR_ASSIGN.exec(line)?.groups
    if (selfDirectory?.['name'] !== undefined) {
      register(selfDirectory['name'], scriptDirectory)
      continue
    }
    const derived = DERIVED_DIR_ASSIGN.exec(line)?.groups
    const base = derived?.['base']
    const baseDirectory = base === undefined ? undefined : directoryVariables.get(base)
    if (baseDirectory === undefined || derived?.['name'] === undefined || derived['relative'] === undefined || isFileLike(derived['relative'])) continue
    register(derived['name'], path.join(baseDirectory, derived['relative']))
  }
  return directoryVariables
}

// スクリプト中のディレクトリ変数を実パスへ解決した写像を返す。
export function resolveDirectoryVariables(text: string, scriptDirectory: string, pluginRoot: string): Map<string, string> {
  return resolveDirectoryVariablesFromLines(codeLines(text), scriptDirectory, pluginRoot)
}

function extractByPattern(kind: 'script' | 'template', text: string, scriptDirectory: string, pluginRoot: string): LibraryReference[] {
  const lines = codeLines(text)
  const directoryVariables = resolveDirectoryVariablesFromLines(lines, scriptDirectory, pluginRoot)
  const references: LibraryReference[] = []
  const unresolved: string[] = []
  for (const line of lines) {
    const pattern = kind === 'script' ? VAR_SH_REF : VAR_MD_TEMPLATE_REF
    for (const match of line.matchAll(pattern)) {
      const groups = match.groups ?? {}
      const name = groups['braced'] ?? groups['bare'] ?? ''
      const modifier = groups['modifier']
      const base = directoryVariables.get(name)
      if (base === undefined || (modifier !== undefined && modifier !== PARENT_STRIP_MODIFIER)) {
        unresolved.push(match[0])
        continue
      }
      references.push({ token: match[0], path: path.join(modifier === undefined ? base : path.dirname(base), groups['relative'] ?? '') })
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      `ディレクトリ変数を解決できない参照があります: ${JSON.stringify(unresolved)}。`
      + '代入イディオムが抽出器の想定外か、変数の定義が失われています。'
      + `${PLUGIN_HOOKS_VAR} 起点の参照は、config-dispatcher.sh を source しているファイルでのみ解決されます。source 行の有無も確認してください。`,
    )
  }
  return references
}

// `$VAR/<path>.sh` / `${VAR%/*}/<path>.sh` 形の参照を、出現順に実パスへ解決する。
export function extractReferences(text: string, scriptDirectory: string, pluginRoot: string): LibraryReference[] {
  return extractByPattern('script', text, scriptDirectory, pluginRoot)
}

// `$VAR/…/templates/<name>.md` 形のテンプレ参照を、出現順に実パスへ解決する。
export function extractTemplateReferences(text: string, scriptDirectory: string, pluginRoot: string): LibraryReference[] {
  return extractByPattern('template', text, scriptDirectory, pluginRoot)
}

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Language, Parser } from 'web-tree-sitter'
import type { Scanner, Segment } from './scan.js'

// TypeScript / JavaScript の文字列とテンプレート文字列と JSX のテキストを、web-tree-sitter で取り出す。
// 文法は comments plugin が同梱する wasm を使う。
// comments plugin は CJS の web-tree-sitter、こちらは ESM の web-tree-sitter を読むので、実行環境は 2 つある。
// 同じ実行環境で Parser.init を並行に呼ぶと先に読んだ Language が使えなくなるので、共有せずに分けている。
// 初期化と文法の読み込みは、この実行環境の中で最初の解析まで遅らせて 1 度だけ行う。
// comments plugin の web-tree-sitter と同じバージョンに固定する（tests/web-tree-sitter-version.test.ts が確かめる）。
export type Grammar = 'typescript' | 'tsx' | 'javascript'

// 置き場の解決はモジュールの読み込みでなく解析のときに行う。失敗は plugin-error として bin の終了コード 2 になる。
function wasmDirectory(): string {
  return path.join(path.dirname(createRequire(import.meta.url).resolve('@cffnpwr/textlint-plugin-comments/package.json')), 'wasm')
}

const state: { initialization?: Promise<void> } = {}
const languages = new Map<Grammar, Promise<Language>>()

async function loadLanguage(grammar: Grammar): Promise<Language> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- 文法名は 3 値の型で、同梱の wasm を読む
  const bytes = await readFile(path.join(wasmDirectory(), `tree-sitter-${grammar}.wasm`))
  return Language.load(bytes)
}

async function languageOf(grammar: Grammar): Promise<Language> {
  state.initialization ??= Parser.init()
  await state.initialization
  const loaded = languages.get(grammar) ?? loadLanguage(grammar)
  languages.set(grammar, loaded)
  return loaded
}

const STRING_TYPES = ['string', 'template_string', 'jsx_text']

// 本文は前後の引用符を除いた区間。テンプレート文字列は `${}` を holes にする。
// 文字列とテンプレート文字列はエスケープを解かずに含み、JSX のテキストは引用符を持たない。
function bodyOf(type: string, start: number, end: number, substitutions: readonly Segment[]): Segment {
  if (type === 'jsx_text') {
    return { start, end }
  }
  return type === 'template_string' ? { start: start + 1, end: end - 1, holes: substitutions, hasEscapes: true } : { start: start + 1, end: end - 1, hasEscapes: true }
}

export function typescriptStrings(grammar: Grammar): Scanner {
  return async (text) => {
    const language = await languageOf(grammar)
    const parser = new Parser()
    try {
      parser.setLanguage(language)
      const tree = parser.parse(text)
      // rootNode.hasError では止めない。この文法は String.raw のタグ付きテンプレートの不正なエスケープ（`\ubuntu` など）も、正しいコードなのに誤りにする。
      // 構文の誤りそのものは各パッケージの tsc が commit の前に止める。誤りの部分木に入っても、文字列は拾う。
      if (tree === null) {
        throw new Error('構文木を作れませんでした')
      }
      try {
        return tree.rootNode.descendantsOfType(STRING_TYPES).filter(node => node.isNamed).map(node => bodyOf(
          node.type,
          node.startIndex,
          node.endIndex,
          node.children.filter(child => child.type === 'template_substitution').map(child => ({ start: child.startIndex, end: child.endIndex })),
        ))
      }
      finally {
        tree.delete()
      }
    }
    finally {
      parser.delete()
    }
  }
}

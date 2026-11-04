import { describe, expect, it } from 'vitest'
import { frontmatterOf, jsonStrings, pythonStrings, shellStrings, yamlStrings } from '../lib/plugins/scan.js'
import type { Segment } from '../lib/plugins/scan.js'

type Scanner = (text: string) => readonly Segment[]

type Row = readonly [name: string, input: string, bodies: readonly string[]]

// 切り出した本文（引用符を含まない）を並べて比べる。
function bodiesOf(scanner: Scanner, text: string): string[] {
  return scanner(text).map(segment => text.slice(segment.start, segment.end))
}

function check(scanner: Scanner, rows: readonly Row[]): void {
  it.each(rows)('%s', (_name, input, bodies) => {
    expect(bodiesOf(scanner, input)).toEqual(bodies)
  })
}

describe('pythonStrings', () => {
  check(pythonStrings, [
    ['二重引用符', 'x = "あ"', ['あ']],
    ['単引用符', 'x = \'あ\'', ['あ']],
    ['f 接頭辞', 'x = f"あ{y}"', ['あ{y}']],
    ['rb 接頭辞と大文字', 'x = rb\'a\' + R"い"', ['a', 'い']],
    ['空の文字列', 'x = "" + "a"', ['', 'a']],
    ['トリプルクォート内の単独引用符', 'x = """a "b" c"""', ['a "b" c']],
    ['単引用符のトリプル', 'x = \'\'\'あ\'\'\'', ['あ']],
    ['空のトリプル', 'x = """"""', ['']],
    ['複数行のトリプル', 'x = """a\n  b"""', ['a\n  b']],
    ['閉じ引用符のエスケープ', 'x = "a\\"b"', ['a\\"b']],
    ['末尾のバックスラッシュ対', 'x = \'a\\\\\' + \'b\'', ['a\\\\', 'b']],
    ['バックスラッシュと改行で続く文字列', 'x = \'a\\\nb\'', ['a\\\nb']],
    ['バックスラッシュと CRLF で続く文字列', 'x = \'a\\\r\nb\'', ['a\\\r\nb']],
    ['閉じていない単一行の文字列は行末で止まる', 'x = "abc\ny = "d"', ['abc', 'd']],
    ['入力末尾で閉じていない文字列', 'x = "abc', ['abc']],
    ['入力末尾で閉じていないトリプル', 'x = """abc', ['abc']],
    ['コメントの中の引用符は読まない', '# "a"\nx = "b"', ['b']],
    ['文字列の中の # は文字列に含める', 'x = "#tag です"', ['#tag です']],
    ['入力が空', '', []],
  ])
})

describe('jsonStrings', () => {
  check(jsonStrings, [
    ['値を返す', '{"a": "b"}', ['b']],
    ['コロン前の空白があるキーを除く', '{"a" : "b"}', ['b']],
    ['コロン前の改行があるキーを除く', '{"a"\n:"b"}', ['b']],
    ['配列の要素', '["あ", "い"]', ['あ', 'い']],
    ['入れ子の値だけ返す', '{"k": {"j": ["い"]}}', ['い']],
    ['エスケープされた引用符', '{"a": "x\\"y"}', ['x\\"y']],
    ['行コメントの中は読まない', '// "x"\n{"a": "b"}', ['b']],
    ['ブロックコメントの中は読まない', '/* "x" */ "y"', ['y']],
    ['閉じていないブロックコメント', '/* "x"', []],
    ['コメントでないスラッシュ', '1 / 2 "a"', ['a']],
    ['閉じていない文字列は行末で止まる', '"abc\n"d"', ['abc', 'd']],
    ['入力末尾で閉じていない文字列', '"abc', ['abc']],
  ])
})

describe('shellStrings', () => {
  check(shellStrings, [
    ['二重引用符', 'echo "あ"', ['あ']],
    ['単引用符', 'MSG=\'あ\'', ['あ']],
    ['単引用符にエスケープは無い', 'x=\'a\\\' \'b\'', ['a\\', 'b']],
    ['$\' ではバックスラッシュが引用符をエスケープする', 'x=$\'a\\\'b\'', ['a\\\'b']],
    ['二重引用符のエスケープ', 'echo "a\\"b\\$c"', ['a\\"b\\$c']],
    ['複数行の文字列', 'echo "a\nb"', ['a\nb']],
    ['行頭のコメントは読まない', '# "x"\necho "y"', ['y']],
    ['先頭行の shebang はコメント', '#!/bin/sh\necho "y"', ['y']],
    ['先頭行の shebang の引用符は読まない', '#!/bin/sh -e "x\necho "y"', ['y']],
    ['語頭の # は行末までコメント', 'echo a # "x"', []],
    ['; の直後の # はコメント', 'x;# c "z"', []],
    ['| の直後の # はコメント', 'x|# c "z"', []],
    ['& の直後の # はコメント', 'x&# c "z"', []],
    ['開き括弧の直後の # はコメント', '(# c "z"', []],
    ['${#x} はコメントにしない', 'echo ${#x} "y"', ['y']],
    ['$# はコメントにしない', 'echo $# "y"', ['y']],
    ['a#b はコメントにしない', 'echo a#b "y"', ['y']],
    ['エスケープした # と引用符', 'echo \\# \\" "y"', ['y']],
    ['バックスラッシュと CRLF の続き行', 'echo a \\\r\n"y"', ['y']],
    ['入れ子のコマンド置換の中の同じ引用符は境界だけ誤る', 'echo "$(echo "x")あ"', ['$(echo ', ')あ']],
    ['heredoc の本文を読み飛ばす', 'cat <<EOF\nit\'s\nEOF\necho "y"', ['y']],
    ['<<- は先頭のタブを除いた終端語', 'cat <<-EOF\n\t"x\n\tEOF\necho "y"', ['y']],
    ['終端語に - を含む heredoc の本文を読み飛ばす', 'cat <<\'END-X\'\nit\'s\nEND-X\necho "y"', ['y']],
    ['終端語に . を含む heredoc の本文を読み飛ばす', 'cat <<END.1\nit\'s\nEND.1\necho "y"', ['y']],
    ['<<\'EOF\'', 'cat <<\'EOF\'\n"x\nEOF\necho "y"', ['y']],
    ['<<"EOF"', 'cat <<"EOF"\n\'x\nEOF\necho "y"', ['y']],
    ['<<\\EOF', 'cat <<\\EOF\n"x\nEOF\necho "y"', ['y']],
    ['終端語が CRLF', 'cat <<EOF\r\n"x\r\nEOF\r\necho "y"', ['y']],
    ['終端語と前方一致するだけの行は本文', 'cat <<EOF\n"x\nEOF2\nEOF\necho "y"', ['y']],
    ['1 行に 2 つの heredoc', 'cat <<A <<B\n\'x\nA\n\'y\nB\necho "z"', ['z']],
    ['宣言と同じ行の文字列は読む', 'cat <<EOF "a"\nb\nEOF', ['a']],
    ['終端語が無い heredoc は何も飛ばさない', 'cat <<EOF\necho "a"\n', ['a']],
    ['here-string は heredoc にしない', 'cat <<< "a"\n"b"', ['a', 'b']],
    ['算術の左シフトは heredoc にしない', 'echo $((1 << 2))\necho "a"', ['a']],
    ['< だけのリダイレクト', 'cat < f "a"', ['a']],
    ['語の無い << は heredoc にしない', 'cat <<; "a"', ['a']],
    ['引用符が閉じていない', 'echo "abc', ['abc']],
    ['入力が空', '', []],
  ])
})

describe('yamlStrings', () => {
  check(yamlStrings, [
    ['プレーンスカラーの値', 'a: あ', ['あ']],
    ['キーは除く', 'あ: い', ['い']],
    ['引用符つきキーは除く', '"あ": い', ['い']],
    ['二重引用符の値は中身だけ', 'a: "あ"', ['あ']],
    ['単引用符の値は中身だけ', 'a: \'あ\'', ['あ']],
    ['配列の要素', '- あ\n- い', ['あ', 'い']],
    ['フローマップの値', '{a: あ}', ['あ']],
    ['複数行のプレーンスカラー', 'a: あ\n  い', ['あ\n  い']],
    ['ブロックスカラーは指示子の行を除く', 'a: |\n  あ\n  い\n', ['  あ\n  い\n']],
    ['折り畳みブロックスカラー', 'a: >-\n  あ\n  い', ['  あ\n  い']],
    ['本文の無いブロックスカラー', 'a: |', ['']],
    ['2 ドキュメント', 'a: 1\n---\nb: "い"', ['1', 'い']],
    ['コメントは読まない', '# あ\na: b', ['b']],
    ['構文エラーでも取れた分を返す', 'a: い\na: う', ['い', 'う']],
    ['入力が空', '', []],
  ])
})

// 本文全体を 1 つの Segment として渡し、values と rest を切り出した本文で返す。
function split(text: string): { values: string[], rest: string } | undefined {
  const result = frontmatterOf(text, { start: 0, end: text.length })
  return result === undefined
    ? undefined
    : { values: result.values.map(value => text.slice(value.start, value.end)), rest: text.slice(result.rest.start, result.rest.end) }
}

describe('frontmatterOf', () => {
  it('値ごとに分け、閉じた --- より後を rest にする', () => {
    expect(split('---\ntitle: あ\ntype: "い"\n---\n\n本文\n')).toEqual({ values: ['あ', 'い'], rest: '\n本文\n' })
  })

  it('キーは除く', () => {
    expect(split('---\nあ: い\n---')).toEqual({ values: ['い'], rest: '' })
  })

  it('インデントを除いて読み、複数行の値を元の位置で切り出す', () => {
    expect(split('  ---\n  x: あ\n    い\n\n  y: う\n  ---\n')).toEqual({ values: ['あ\n    い', 'う'], rest: '' })
  })

  it('先頭の空行を読み飛ばす', () => {
    expect(split('\n\n---\nx: あ\n---\n')).toEqual({ values: ['あ'], rest: '' })
  })

  it('値のブロックスカラーは指示子の行を除いた本文を返す', () => {
    expect(split('---\nx: |\n  あ\n---\n')).toEqual({ values: ['  あ'], rest: '' })
  })

  it('空の frontmatter は値を持たず、後ろは rest にする', () => {
    expect(split('---\n---\nあ')).toEqual({ values: [], rest: 'あ' })
  })

  it.each([
    ['閉じる --- が無い', '---\nx: あ\n'],
    ['--- で始まらない', 'x\n---\ny: あ\n---\n'],
    ['空の本文', ''],
    ['構文エラー', ['---\nx: [', 'あ\n---\n'].join('')],
  ])('%s ときは undefined', (_name, text) => {
    expect(split(text)).toBeUndefined()
  })
})

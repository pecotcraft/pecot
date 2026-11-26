import { TextlintKernel } from '@textlint/kernel'
import { describe, expect, it } from 'vitest'
import { SUMMARY_PREFIX } from '../lib/findings.js'
import { loadCommentsPlugin, loadPlugin } from '../lib/plugins/load.js'
import strings, { documentOf, stringParagraphs } from '../lib/plugins/strings.js'
import { lintText } from '../lib/lint-text.js'
import { buildRules } from '../lib/rules.js'
import { at, lint, sentence, word } from './helpers/strings.js'
import type { Hit } from './helpers/strings.js'
import { step, stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

const kernel = new TextlintKernel()
// Python の三重引用符と引用符は、日本語の文の中に literal で置くと引用符の対の規則に止められるので、定数に置く。
const TRIPLE = '"'.repeat(3)
const QUOTE = '"'
// no-exclamation-question-mark の違反を、literal ではなく補間で組み立てる。
const FULL_BANG = String.fromCodePoint(0xFF_01)
const HALF_BANG = String.fromCodePoint(0x21)

describe('strings plugin: Python', () => {
  it('代入した文字列に違反があると、元のファイルの行と桁で指摘を返す', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。変数へ代入した文字列に違反がある場合、元のファイルの 1 行目 6 桁の指摘を返すことを確認します。')
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = "${sentence}"\n`, '.py')).toEqual([at(1, 6)])
    })
  })

  it('2 行目から始まる docstring に違反があると、2 行目と 3 行目の正しい桁で指摘を返す', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。2 行目から始まる複数行の docstring の各行に違反がある場合に、2 行目と 3 行目のそれぞれで正しい桁の指摘を返すことを確認します。')
    const text = `x = 1\ny = """${sentence}\n    ${sentence}"""\n`
    await step('docstring を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(2, 8), at(3, 5)])
    })
  })

  it('コメントの中の引用符で囲んだ文は、文字列として数えず、コメントとして 1 件だけ返す', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。コメントの中に引用符で囲んだ違反のある文がある場合に、文字列を調べる plugin とコメントを調べる plugin の両方では数えず、コメントとして 1 件だけ指摘を返すことを確認します。')
    await step('コメントを規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`# "${sentence}"\n`, '.py')).toEqual([at(1, 4)])
    })
  })

  it('日本語を含まない文字列は、段落として取り出さない', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。英数字だけの文字列を渡した場合に、段落が 1 つも取り出されないことを確認します。')
    await step('文字列を段落に分け、空かを比べる', async () => {
      expect(await stringParagraphs('x = "only ascii"\n', '.py')).toEqual([])
    })
  })

  it('文字列の中の # を、コメントの開始として扱わない', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。文字列の中に `#` が含まれていても、文字列が途中で切れず、`#` の後ろの違反まで同じ文字列として読むことを確認します。')
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = "#tag ${sentence}"\n`, '.py')).toEqual([at(1, 11)])
    })
  })

  it.each([
    ['f 接頭辞', `x = f"${sentence}"\n`, 7],
    ['r 接頭辞', `x = r'${sentence}'\n`, 7],
  ])('%s の文字列に違反があると、文字列の位置に指摘を 1 件返す', async (name, text, column) => {
    await explains(`Python ファイルから文を取り出す strings plugin のテストです。「${name}」の文字列に違反がある場合に、接頭辞の後ろの文字列の位置に、指摘を 1 件返すことを確認します。`)
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(1, column)])
    })
  })

  it('トリプルクォートの中に二重引用符が 1 つあっても、文字列が終わらない', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。三重引用符の文字列の中に、単独の二重引用符がある場合に、文字列が途中で終わらず、後ろの違反の位置で指摘を返すことを確認します。')
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = """前 "引用" ${sentence}"""\n`, '.py')).toEqual([at(1, 15)])
    })
  })

  it('バックスラッシュと改行で続く文字列は、行ごとに数える', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。行末のバックスラッシュで次の行へ続く文字列を渡した場合に、1 行目と 2 行目のそれぞれの位置で指摘を返すことを確認します。')
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = "${sentence}\\\n${sentence}"\n`, '.py')).toEqual([at(1, 6), at(2, 1)])
    })
  })

  it('文字列の中のエスケープした空行で段落を分け、文の長さの指摘を出さない', async () => {
    await explains('文字列の中のエスケープを読む strings plugin のテストです。エスケープした改行が 2 つ続く文字列を、`.py`・`.json`・`.yaml` で渡した場合に、段落が分かれ、規則 `sentence-length` の指摘が返らないことを確認します。')
    const long = 'あ'.repeat(60)
    await step('各形式の文字列を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(`x = "${long}\\n\\n${long}"\n`, '.py', 'sentence-length')).toEqual([])
      expect(await lint(`{"a": "${long}\\n\\n${long}"}\n`, '.json', 'sentence-length')).toEqual([])
      expect(await lint(`a: "${long}\\n\\n${long}"\n`, '.yaml', 'sentence-length')).toEqual([])
    })
  })

  it('エスケープを解かない YAML の単引用符の文字列では、エスケープした改行を改行として扱わない', async () => {
    await explains('文字列の中のエスケープを読む strings plugin のテストです。YAML の単引用符の文字列に、エスケープした改行が 2 つ続く場合に、改行として扱わず、規則 `sentence-length` の指摘が 1 件返ることを確認します。')
    const long = 'あ'.repeat(60)
    await step('YAML の文字列を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`a: '${long}\\n\\n${long}'\n`, '.yaml', 'sentence-length')).toHaveLength(1)
    })
  })

  it('改行が CRLF のファイルでは、行末の CR を文に含めず、2 行目の桁を正しく数える', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。改行が CRLF のファイルを渡した場合に、2 行目の指摘の桁が正しく、取り出した文に CR が含まれないことを確認します。')
    const text = `x = "${sentence}"\r\ny = "${sentence}"\r\n`
    await step('規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(1, 6), at(2, 6)])
    })
    const paragraphs = await step('文字列を段落に分ける', () => stringParagraphs(text, '.py'))
    const values = stepSync('段落の文字列を取り出す', () => paragraphs.flatMap(paragraph => paragraph.children.map(child => child.raw)))
    stepSync('文字列に CR が無いかを比べる', () => {
      expect(values.some(raw => raw.includes('\r'))).toBe(false)
    })
  })

  it('先頭に BOM があっても、指摘の桁がずれない', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。先頭に BOM があるファイルを渡した場合に、BOM が無いファイルと同じ桁で指摘を返すことを確認します。')
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`\u{FEFF}x = "${sentence}"\n`, '.py')).toEqual([at(1, 6)])
    })
  })

  it('コメントと文字列の違反を、位置の順に 1 件ずつ返す', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。コメントと文字列の両方に違反がある場合に、位置の順に 1 件ずつ、合わせて 2 件の指摘を返すことを確認します。')
    const text = `# ${sentence}\nx = "${sentence}"\n`
    await step('規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(1, 3), at(2, 6)])
    })
  })

  it('100 文字を超える文字列は、文の長さの指摘として 1 件返す', async () => {
    await explains('Python ファイルから文を取り出す strings plugin のテストです。101 文字の文を含む文字列を渡した場合に、規則 `sentence-length` の指摘が、1 行目の位置で 1 件返ることを確認します。')
    const hits = await step('文字列を規則にかける', () => lint(`x = "${'あ'.repeat(101)}。"\n`, '.py', 'sentence-length'))
    stepSync('指摘の件数と位置を比べる', () => {
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ line: 1 })
    })
  })
})

describe('strings plugin: シェル', () => {
  it.each([
    ['echo', `echo "${sentence}"\n`, 7],
    ['変数代入', `MSG='${sentence}'\n`, 6],
  ])('%s の文字列に違反があると、文字列の位置に指摘を 1 件返す', async (name, text, column) => {
    await explains(`シェルスクリプトの文字列から文を取り出す strings plugin のテストです。「${name}」の形の文字列に違反がある場合に、文字列の位置に指摘を 1 件返すことを確認します。`)
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.sh')).toEqual([at(1, column)])
    })
  })

  it('変数の長さを表す記法の # をコメントとして扱わず、後ろの文字列を読む', async () => {
    await explains('シェルスクリプトの文字列から文を取り出す strings plugin のテストです。変数の長さを表す記法の中の `#` がある場合に、`#` をコメントの開始とみなさず、後ろの文字列の違反を返すことを確認します。')
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`echo \${#x} "${sentence}"\n`, '.sh')).toEqual([at(1, 13)])
    })
  })

  it('ヒアドキュメントの中の単引用符を、文字列の開始として扱わない', async () => {
    await explains('シェルスクリプトの文字列から文を取り出す strings plugin のテストです。ヒアドキュメントの本文に単引用符がある場合に、文字列の開始とみなさず、後ろの文字列の違反を元のファイルの位置で返すことを確認します。')
    const text = `cat <<EOF\nit's\nEOF\necho "${sentence}"\n`
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.sh')).toEqual([at(4, 7)])
    })
  })

  it('入れ子のコマンド置換の中に同じ引用符があると、文字列の境界は誤るが、位置は元のファイルのまま返す', async () => {
    await explains('シェルスクリプトの文字列から文を取り出す strings plugin のテストです。コマンド置換の中に同じ種類の引用符がある場合に、文字列の境界は正しく読めないが、指摘の位置は元のファイルと一致することを確認します。')
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`echo "$(echo "x")${sentence}"\n`, '.sh')).toEqual([at(1, 18)])
    })
  })

  it('.bash の拡張子のファイルでも、文字列を読む', async () => {
    await explains('シェルスクリプトの文字列から文を取り出す strings plugin のテストです。拡張子が `.bash` のファイルを渡した場合に、`.sh` と同じように、文字列の違反を返すことを確認します。')
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`echo "${sentence}"\n`, '.bash')).toEqual([at(1, 7)])
    })
  })
})

describe('strings plugin: JSON', () => {
  it('JSON の値に違反があると、その位置を指摘として返す', async () => {
    await explains('JSON ファイルの値から文を取り出す strings plugin のテストです。JSON の値に違反がある場合に、元のファイルの 1 行目 18 桁の指摘を返すことを確認します。')
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`{"description": "${sentence}"}\n`, '.json')).toEqual([at(1, 18)])
    })
  })

  it('JSON のキーは、違反があっても対象にしない', async () => {
    await explains('JSON ファイルの値から文を取り出す strings plugin のテストです。JSON のキーに違反のある文がある場合に、キーは調べず、指摘が 1 件も返らないことを確認します。')
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`{"${sentence}": "ok"}\n`, '.json')).toEqual([])
    })
  })

  it('.jsonc のコメントは、文字列として数えず、コメントとして 1 件だけ返す', async () => {
    await explains('JSON ファイルの値から文を取り出す strings plugin のテストです。`.jsonc` の行コメントとブロックコメントに違反がある場合に、どちらも文字列としては数えず、コメントとして 1 件ずつ指摘を返すことを確認します。')
    await step('JSONC のコメントを規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`{"a": 1} // "${sentence}"\n`, '.jsonc')).toHaveLength(1)
      expect(await lint(`{"a": 1} /* "${sentence}" */\n`, '.jsonc')).toHaveLength(1)
    })
  })
})

describe('strings plugin: YAML', () => {
  it.each([
    ['単引用符', `description: '${sentence}'\n`, 15],
    ['二重引用符', `description: "${sentence}"\n`, 15],
    ['プレーン', `description: ${sentence}\n`, 14],
  ])('%s の値に違反があると、値の位置に指摘を 1 件返す', async (name, text, column) => {
    await explains(`YAML ファイルの値から文を取り出す strings plugin のテストです。「${name}」の値に違反がある場合に、値の位置に指摘を 1 件返すことを確認します。`)
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.yaml')).toEqual([at(1, column)])
    })
  })

  it('ブロックスカラーの 2 行目以降も、行ごとに位置を数えて指摘を返す', async () => {
    await explains('YAML ファイルの値から文を取り出す strings plugin のテストです。複数行のブロックスカラーの各行に違反がある場合に、2 行目と 3 行目のそれぞれの位置で指摘を返すことを確認します。')
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`description: |\n  ${sentence}\n  ${sentence}\n`, '.yaml')).toEqual([at(2, 3), at(3, 3)])
    })
  })

  it('YAML のキーは対象にせず、# のコメントは、コメントとして 1 件だけ返す', async () => {
    await explains('YAML ファイルの値から文を取り出す strings plugin のテストです。キーに違反のある文がある場合は指摘が返らず、`#` のコメントに違反がある場合は、コメントとして 1 件だけ指摘を返すことを確認します。')
    await step('キーを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(`${word}: 1\n`, '.yml')).toEqual([])
    })
    await step('コメントを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`# ${sentence}\n`, '.yaml')).toEqual([at(1, 3)])
    })
  })

  it('文字列へ埋め込んだ frontmatter を、値ごとの段落に分け、文の長さの指摘を出さない', async () => {
    await explains('YAML ファイルの値から文を取り出す strings plugin のテストです。ブロックスカラーの中に frontmatter が埋め込まれている場合に、値ごとに別の段落になり、規則 `sentence-length` の指摘が返らないことを確認します。')
    const text = 'frontmatter: |\n  ---\n  layout: x\n  title: "あ"\n  note: "い"\n  ---\n'
    const paragraphs = await step('文字列を段落に分ける', () => stringParagraphs(text, '.yaml'))
    stepSync('段落の位置を比べる', () => {
      expect(paragraphs.map(paragraph => [paragraph.raw, paragraph.loc.start])).toEqual([
        ['あ', { line: 4, column: 10 }],
        ['い', { line: 5, column: 9 }],
      ])
    })
    const long = `---\n  title: "${'あ'.repeat(60)}"\n  note: "${'い'.repeat(60)}"\n  ---`
    await step('frontmatter を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(`frontmatter: |\n  ${long}\n`, '.yaml', 'sentence-length')).toEqual([])
    })
  })

  it('文字列に埋め込んだ frontmatter の値に違反があると、その値の元のファイルの位置で指摘を返す', async () => {
    await explains('YAML ファイルの値から文を取り出す strings plugin のテストです。入れ子になった項目のブロックスカラーに埋め込んだ frontmatter の値に違反がある場合に、元のファイルの 5 行目 15 桁の指摘を返すことを確認します。')
    const text = `items:\n  - frontmatter: |\n      ---\n      layout: x\n      title: "${sentence}"\n      ---\n`
    await step('frontmatter を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.yaml')).toEqual([at(5, 15)])
    })
  })

  it('1 つのファイルに YAML のドキュメントが 2 つあると、どちらも読む', async () => {
    await explains('YAML ファイルの値から文を取り出す strings plugin のテストです。`---` で区切った 2 つのドキュメントのどちらにも違反がある場合に、1 行目と 3 行目の指摘を返すことを確認します。')
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`a: '${sentence}'\n---\nb: '${sentence}'\n`, '.yaml')).toEqual([at(1, 5), at(3, 5)])
    })
  })
})

describe('Processor', () => {
  const processor = new strings.Processor()

  it('対象とする拡張子の一覧を返す', async () => {
    await explains('ファイルを Document に変換する Processor のテストです。対応する拡張子の一覧を取得した場合に、Python・シェル・JSON・YAML・TypeScript・JavaScript・`.vue` の拡張子が、決まった順に並ぶことを確認します。')
    stepSync('対象の拡張子を比べる', () => {
      expect(processor.availableExtensions()).toEqual(['.py', '.pyi', '.sh', '.bash', '.json', '.jsonc', '.yaml', '.yml', '.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.vue'])
    })
  })

  it('Document は、位置の順に並んだ子と、全文の位置を持ち、親への参照を持たない', async () => {
    await explains('ファイルを Document に変換する Processor のテストです。コメントと文字列を含む `.py` ファイルを変換した場合に、`Document` の範囲が全文になり、段落の子が位置の順に並び、`parent` を持たないことを確認します。')
    const text = `# ${sentence}\nx = "${sentence}"\n`
    const result = await step('Document を作る', async () => documentOf(await processor.processor('.py').preProcess(text)))
    stepSync('Document の形を比べる', () => {
      expect(result.type).toBe('Document')
      expect(result.range).toEqual([0, text.length])
      expect(result.loc).toEqual({ start: { line: 1, column: 0 }, end: { line: 3, column: 0 } })
      expect(result.children.map(child => child.type)).toEqual(['Paragraph', 'Paragraph'])
      expect(result.children.map(child => child.range[0])).toEqual([2, text.indexOf('x = "') + 5])
      expect(result.children.some(child => 'parent' in child)).toBe(false)
    })
  })

  it('複数行の文字列は、Str と Break を交互に並べ、Str の範囲に引用符と字下げを含めない', async () => {
    await explains('ファイルを Document に変換する Processor のテストです。複数行の文字列を変換した場合に、`Str` と `Break` が交互に並び、`Str` の範囲に引用符と字下げが含まれないことを確認します。')
    const text = `x = """\n    あ\n    い"""\n`
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs(text, '.py'))
    stepSync('段落の子ノードを比べる', () => {
      expect(paragraph?.children.map(child => [child.type, child.raw])).toEqual([
        ['Str', 'あ'],
        ['Break', '\n    '],
        ['Str', 'い'],
      ])
      expect(paragraph?.children[0]).toMatchObject({ value: 'あ', range: [12, 13], loc: { start: { line: 2, column: 4 } } })
    })
  })

  it('空行で区切った句点の無い 2 つの段落は、1 つの文に連結せず、文の長さの指摘を出さない', async () => {
    await explains('ファイルを Document に変換する Processor のテストです。句点が無く、空行で区切った 2 つの段落を渡した場合に、1 つの文に連結されず、規則 `sentence-length` の指摘が返らないことを確認します。')
    const paragraph = 'あ'.repeat(60)
    await step('Python の docstring を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`def f():\n    """${paragraph}\n\n    ${paragraph}\n    """\n`, '.py', 'sentence-length')).toEqual([])
      expect(await lint(`x = """${paragraph}\n${paragraph}"""\n`, '.py', 'sentence-length')).toHaveLength(1)
    })
  })

  it('空白だけの行を含む空行で段落を分け、空行の無い複数行は 1 つの段落のままにする', async () => {
    await explains('ファイルを Document に変換する Processor のテストです。空白だけの行を含む空行がある文字列を変換した場合に、空行ごとに段落が分かれ、空行の無い複数行は 1 つの段落のままになることを確認します。')
    const text = `x = ${TRIPLE}\n    あ\n    い\n  \n\n    う${TRIPLE}\n`
    const paragraphs = await step('文字列を段落に分ける', () => stringParagraphs(text, '.py'))
    stepSync('段落の構成を比べる', () => {
      expect(paragraphs.map(paragraph => paragraph.children.map(child => [child.type, child.raw]))).toEqual([
        [['Str', 'あ'], ['Break', '\n    '], ['Str', 'い']],
        [['Str', 'う']],
      ])
      expect(paragraphs[1]).toMatchObject({ loc: { start: { line: 6, column: 4 } } })
    })
  })

  it('postProcess は、messages と filePath をそのまま返し、filePath が存在しなければ空文字にする', async () => {
    await explains('ファイルを Document に変換する Processor のテストです。`postProcess` に messages と filePath を渡した場合はそのまま返し、filePath を渡さない場合は、filePath を空文字にして返すことを確認します。')
    const python = processor.processor('.py')
    stepSync('postProcess の結果を比べる', () => {
      expect(python.postProcess([], 'a.py')).toEqual({ messages: [], filePath: 'a.py' })
      expect(python.postProcess([])).toEqual({ messages: [], filePath: '' })
    })
  })

  it('対象外の拡張子を渡すと、stringParagraphs が RangeError を投げる', async () => {
    await explains('ファイルを Document に変換する Processor のテストです。対応していない拡張子 `.go` を `stringParagraphs` へ渡した場合、`RangeError` で失敗することを確認します。')
    await step('対象外の拡張子で段落に分け、RangeError かを比べる', async () => {
      await expect(stringParagraphs('x', '.go')).rejects.toThrow(RangeError)
    })
  })

  it('text と ast を持つ形式の preProcess の結果からも、Document を取り出す', async () => {
    await explains('ファイルを Document に変換する Processor のテストです。`preProcess` の結果が、変換後の text と `ast` を持つ形式の場合に、`documentOf` が `ast` をそのまま取り出すことを確認します。')
    const ast = await step('変換後の text から Document を作る', async () => documentOf(await processor.processor('.py').preProcess('')))
    stepSync('取り出した Document を比べる', () => {
      expect(documentOf({ text: '', ast })).toBe(ast)
    })
  })
})

// strings を通さず、comments plugin だけで処理する拡張子（.ts など）を確かめる。
async function lintComments(text: string, ruleId: string): Promise<Hit[]> {
  const result = await kernel.lintText(text, {
    ext: '.ts',
    filePath: 'sample.ts',
    plugins: [{ pluginId: 'comments', plugin: loadCommentsPlugin() }],
    rules: buildRules(),
  })
  return result.messages
    .filter(message => message.ruleId === ruleId)
    .map(message => ({ ruleId: message.ruleId, line: message.loc.start.line, column: message.loc.start.column }))
}

describe('インラインコードの Code ノード', () => {
  const rule = 'no-exclamation-question-mark'
  const hit = (column: number): Hit => ({ ruleId: rule, line: 1, column })

  it.each([
    ['Python の文字列', 'x = "差分の行には `[!code ++]` を付ける。"\n', '.py'],
    ['YAML の文字列', 'a: 差分の行には `[!code ++]` を付ける。\n', '.yaml'],
    ['シェルの文字列', 'echo "差分の行には `[!code ++]` を付ける。"\n', '.sh'],
    ['シェルのコメント', '# 差分の行には `[!code ++]` を付ける。\n', '.sh'],
    ['2 連のバッククォート', 'x = "差分の行には ``[!code `+` +]`` を付ける。"\n', '.py'],
  ])('%s のバッククォートで囲んだ区間は、規則の対象にしない', async (name, text, extension) => {
    await explains(`バッククォートで囲んだインラインコードを \`Code\` として扱う strings plugin のテストです。「${name}」の中のバッククォートで囲んだ区間に、規則 \`no-exclamation-question-mark\` の違反に当たる記号がある場合に、指摘が 1 件も返らないことを確認します。`)
    await step('バッククォートの区間を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, extension, rule)).toEqual([])
    })
  })

  it('コメントを調べる plugin だけで処理する .ts のコメントでも、バッククォートで囲んだ区間を対象から外す', async () => {
    await explains('バッククォートで囲んだインラインコードを `Code` として扱う strings plugin のテストです。`.ts` のコメントのバッククォートで囲んだ区間に、感嘆符を含む記法がある場合に、指摘が返らないことを確認します。')
    await step('comments plugin のコメントを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintComments('// 差分の行には `[!code ++]` を付ける。\nexport const a = 1\n', rule)).toEqual([])
    })
  })

  it('バッククォートで囲んだ区間の外の違反は、元のファイルの位置で返す', async () => {
    await explains('バッククォートで囲んだインラインコードを `Code` として扱う strings plugin のテストです。バッククォートで囲んだ区間の外に違反がある場合に、文字列とコメントのどちらでも、元のファイルの位置で指摘を返すことを確認します。')
    await step('Code の外を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = "\`a\` 本当に${FULL_BANG} \`b\` 終わり。"\n`, '.py', rule)).toEqual([hit(13)])
      expect(await lintComments(`// \`a\` 本当に${FULL_BANG} \`b\` 終わり。\n`, rule)).toEqual([hit(11)])
    })
  })

  it('複数行のコメントの、行頭と行末のバッククォートで囲んだ区間も、対象から外す', async () => {
    await explains('バッククォートで囲んだインラインコードを `Code` として扱う strings plugin のテストです。複数行のコメントの、行頭と行末にバッククォートで囲んだ区間がある場合に、指摘が 1 件も返らないことを確認します。')
    await step('複数行のコメントを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintComments('/*\n * `[!a]` 差分の行。\n * 差分の行は `[!b]`\n */\nexport const a = 1\n', rule)).toEqual([])
    })
  })

  it('閉じていないバッククォートは、通常の文字として、規則の対象にする', async () => {
    await explains('バッククォートで囲んだインラインコードを `Code` として扱う strings plugin のテストです。バッククォートが閉じていない文を渡した場合に、インラインコードとは扱われず、文字列とコメントのどちらでも指摘が 1 件返ることを確認します。')
    await step('閉じていないバッククォートを規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`x = "差分には \`[${HALF_BANG}code ++] を付ける。"\n`, '.py', rule)).toHaveLength(1)
      expect(await lintComments(`// 差分には \`\`[${HALF_BANG}code ++]\` を付ける。\n`, rule)).toHaveLength(1)
    })
  })

  it('Code とその前後の Str に、元のファイルの範囲と位置を持たせ、value は内側の文字、raw はバッククォートを含めた文字にする', async () => {
    await explains('バッククォートで囲んだインラインコードを `Code` として扱う strings plugin のテストです。1 つと 2 つのバッククォートで囲んだ区間を含む文字列を変換した場合に、`Str` と `Code` が順に並び、それぞれの範囲と位置が元のファイルと一致することを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('x = "あ `い` う ``え`` お"\n', '.py'))
    stepSync('Str と Code を比べる', () => {
      expect(paragraph?.children.flatMap(child => (child.type === 'Break' ? [] : [[child.type, 'value' in child ? child.value : undefined, child.raw, child.range]]))).toEqual([
        ['Str', 'あ ', 'あ ', [5, 7]],
        ['Code', 'い', '`い`', [7, 10]],
        ['Str', ' う ', ' う ', [10, 13]],
        ['Code', 'え', '``え``', [13, 18]],
        ['Str', ' お', ' お', [18, 20]],
      ])
      expect(paragraph?.children[1]).toMatchObject({ loc: { start: { line: 1, column: 7 }, end: { line: 1, column: 10 } } })
    })
  })

  it('複数行の文字列では、2 行目以降の Code の行と桁を、元のファイルに合わせる', async () => {
    await explains('バッククォートで囲んだインラインコードを `Code` として扱う strings plugin のテストです。複数行の文字列の 3 行目にインラインコードがある場合に、`Code` の範囲と、3 行目 6 桁の位置が元のファイルと一致することを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('x = """\n    あ\n    い `う` え"""\n', '.py'))
    const code = stepSync('Code を取り出す', () => paragraph?.children.find(child => child.type === 'Code'))
    stepSync('Code の位置を比べる', () => {
      expect(code).toMatchObject({ value: 'う', range: [20, 23], loc: { start: { line: 3, column: 6 } } })
    })
  })
})

// 規則 ID だけを、要約を除いて並べる。Markdown の断片（lintText）と件数と規則を比べるために使う。
async function ruleIdsOf(text: string, extension: string): Promise<string[]> {
  const result = await kernel.lintText(text, {
    ext: extension,
    filePath: `sample${extension}`,
    plugins: [{ pluginId: 'strings', plugin: strings }],
    rules: buildRules(),
  })
  return result.messages.filter(message => !message.message.startsWith(SUMMARY_PREFIX)).map(message => message.ruleId).toSorted((a, b) => a.localeCompare(b))
}

describe('インライン HTML の Html ノード', () => {
  const rule = 'no-exclamation-question-mark'

  it.each([
    ['コメント', 'x = "差分の行には <!-- 本当に！ --> を付ける。"\n'],
    ['開始タグ', 'x = "差分の行には <a href=\'x！\'> を付ける。"\n'],
    ['終了タグ', 'x = "差分の行には </p class=\'！\'> を付ける。"\n'],
    ['自己完結タグ', 'x = "差分の行には <br class=\'！\' /> を付ける。"\n'],
  ])('%s は、規則の対象にしない', async (name, text) => {
    await explains(`文字列の中のインライン HTML を \`Html\` として扱う strings plugin のテストです。「${name}」の形のインライン HTML の中に、規則 \`no-exclamation-question-mark\` の違反に当たる記号がある場合に、指摘が 1 件も返らないことを確認します。`)
    await step('対象外の区間を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, '.py', rule)).toEqual([])
    })
  })

  it('タグではない < と > は、通常の文字として、規則の対象にする', async () => {
    await explains('文字列の中のインライン HTML を `Html` として扱う strings plugin のテストです。`x < y かつ y > z` のように、タグではない `<` と `>` を含む文に違反がある場合に、指摘が 1 件返ることを確認します。')
    await step('タグでない記号を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`x = "x < y かつ y > z を確認する${FULL_BANG}"\n`, '.py', rule)).toHaveLength(1)
    })
  })

  it('Html とその前後の Str に、元のファイルの範囲と位置を持たせる', async () => {
    await explains('文字列の中のインライン HTML を `Html` として扱う strings plugin のテストです。開始タグと終了タグを含む文字列を変換した場合に、`Str` と `Html` が順に並び、それぞれの範囲が元のファイルと一致することを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('x = "あ <b>い</b> う"\n', '.py'))
    stepSync('Str と Html を比べる', () => {
      expect(paragraph?.children.flatMap(child => (child.type === 'Break' ? [] : [[child.type, 'value' in child ? child.value : undefined, child.range]]))).toEqual([
        ['Str', 'あ ', [5, 7]],
        ['Html', '<b>', [7, 10]],
        ['Str', 'い', [10, 11]],
        ['Html', '</b>', [11, 15]],
        ['Str', ' う', [15, 17]],
      ])
    })
  })

  it.each([
    ['コメント', ['差分の行には ', '<!--', ' 本当に', FULL_BANG, ' --> を付ける。'].join('')],
    ['タグの外の違反', `<b>注意${FULL_BANG}</b> を読む。`],
    ['タグでない < と >', `x < y かつ y > z を確認する${FULL_BANG}`],
    ['コードとタグ', `\`[${HALF_BANG}x]\` と <i>強調</i> を書く。`],
    ['閉じないコメント', ['差分の行には ', '<!--', ' 本当に', FULL_BANG, ' を付ける。'].join('')],
    ['長い URL', `詳細は https://example.com/${'a'.repeat(100)} を参照する。`],
    ['URL の外の違反', `詳細は https://example.com/a を見る${FULL_BANG}`],
  ])('Markdown の断片として調べた場合と同じ件数と規則を返す: %s', async (name, content) => {
    await explains(`文字列の中のインライン HTML を \`Html\` として扱う strings plugin のテストです。「${name}」を含む文字列を調べた場合に、同じ内容を Markdown の断片として \`lintText\` に渡したときと、同じ規則の指摘が同じ件数だけ返ることを確認します。`)
    const findings = await step('断片を規則にかける', () => lintText(content, 'fragment'))
    const fragment = findings.map(finding => finding.ruleId).toSorted((a, b) => a.localeCompare(b))
    await step('Python の文字列を規則にかけ、規則 ID を比べる', async () => {
      expect(await ruleIdsOf(`x = "${content}"\n`, '.py')).toEqual(fragment)
    })
  })
})

describe('素の URL の Link ノード', () => {
  const rule = 'sentence-length'
  const url = `https://example.com/${'a'.repeat(100)}`

  it.each([
    ['Python の文字列', `x = "詳細は ${url} を参照する。"\n`, '.py'],
    ['YAML のコメント', `# 詳細は ${url} を参照する。\n`, '.yaml'],
    ['シェルのコメント', `# 詳細は ${url} を参照する。\n`, '.sh'],
    ['autolink', `x = "詳細は <${url}> を参照する。"\n`, '.py'],
  ])('%s に含まれる URL は、文の長さに含めない', async (name, text, extension) => {
    await explains(`文字列の中の素の URL を \`Link\` として扱う strings plugin のテストです。「${name}」に長い URL がある場合に、URL を文の長さに数えず、規則 \`sentence-length\` の指摘が返らないことを確認します。`)
    await step('URL を含む文を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, extension, rule)).toEqual([])
    })
  })

  it('コメントを調べる plugin だけで処理する .ts のコメントでも、URL を文の長さに含めない', async () => {
    await explains('文字列の中の素の URL を `Link` として扱う strings plugin のテストです。`.ts` のコメントに長い URL がある場合に、URL を文の長さに数えず、規則 `sentence-length` の指摘が返らないことを確認します。')
    await step('comments plugin のコメントを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintComments(`// 詳細は ${url} を参照する。\nexport const a = 1\n`, rule)).toEqual([])
    })
  })

  it('URL ではない長い文字列は、文の長さの指摘を返す', async () => {
    await explains('文字列の中の素の URL を `Link` として扱う strings plugin のテストです。スキームが `ftp` で、`http` ではない長い文字列を渡した場合に、URL として扱われず、規則 `sentence-length` の指摘が 1 件返ることを確認します。')
    await step('URL でない長い文字列を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`x = "詳細は ${url.replace('https://', 'ftp://')} を参照する。"\n`, '.py', rule)).toHaveLength(1)
    })
  })

  it('Link の子を URL の Str にして、url の属性と、元のファイルの位置を持たせる', async () => {
    await explains('文字列の中の素の URL を `Link` として扱う strings plugin のテストです。素の URL と、山括弧で囲んだ URL を含む文字列を変換した場合に、`Link` が URL の `Str` を子に持ち、`url` と範囲が元のファイルと一致することを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('x = "あ https://a.example/x?y=1). い <https://b.example/z> う"\n', '.py'))
    const nodes: unknown[] = []
    const children = paragraph?.children ?? []
    stepSync('Link を集める', () => {
      for (const child of children) {
        if (child.type === 'Link') {
          nodes.push({ type: child.type, url: child.url, raw: child.raw, range: child.range, children: child.children.map(inner => [inner.type, inner.raw, inner.range]) })
        }
      }
    })
    stepSync('Link の形を比べる', () => {
      expect(nodes).toEqual([
        { type: 'Link', url: 'https://a.example/x?y=1', raw: 'https://a.example/x?y=1', range: [7, 30], children: [['Str', 'https://a.example/x?y=1', [7, 30]]] },
        { type: 'Link', url: 'https://b.example/z', raw: '<https://b.example/z>', range: [35, 56], children: [['Str', 'https://b.example/z', [36, 55]]] },
      ])
    })
    stepSync('段落の子ノードを比べる', () => {
      expect(paragraph?.children.map(child => child.raw)).toEqual(['あ ', 'https://a.example/x?y=1', '). い ', '<https://b.example/z>', ' う'])
    })
  })

  it.each([
    ['句点', 'https://a.example/x。', 'https://a.example/x'],
    ['読点', 'https://a.example/x、', 'https://a.example/x'],
    ['閉じかぎ括弧', 'https://a.example/x」', 'https://a.example/x'],
    ['対応する ( の無い )', 'https://a.example/x)', 'https://a.example/x'],
    ['対応する ( のある )', 'https://a.example/a_(b)', 'https://a.example/a_(b)'],
    ['ピリオドと疑問符', 'https://a.example/x?q=1.', 'https://a.example/x?q=1'],
  ])('URL の末尾にある %s は、URL に含めない', async (name, written, expected) => {
    await explains(`文字列の中の素の URL を \`Link\` として扱う strings plugin のテストです。URL の末尾に「${name}」が続く場合に、その文字を URL に含めず、\`Link\` の文字列が期待した URL になることを確認します。`)
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs(`x = "あ ${written}"\n`, '.py'))
    stepSync('Link の文字列を比べる', () => {
      expect(paragraph?.children.find(child => child.type === 'Link')?.raw).toBe(expected)
    })
  })

  it.each([
    ['スキームだけ', 'あ https:// い'],
    ['http で始まらない語', 'あ httpx://a.example い'],
    ['バッククォートの中', 'あ `https://a.example` い'],
    ['HTML タグの属性の中', 'あ <a href="https://a.example"> い'],
  ])('%s は、Link として扱わない', async (name, written) => {
    await explains(`文字列の中の素の URL を \`Link\` として扱う strings plugin のテストです。「${name}」の形の文字列を渡した場合に、\`Link\` として扱われないことを確認します。`)
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs(`x = "${written}"\n`, '.py'))
    stepSync('Link が無いかを比べる', () => {
      expect(paragraph?.children.some(child => child.type === 'Link')).toBe(false)
    })
  })
})

// 断片（lintText）は行頭の記号を escape して Markdown を読むので、リストの扱いはここだけ Markdown の ListItem に寄せる。
// そのためこの describe は、lintText と判定が揃うことを確かめない。
describe('リストの記号で始まる行', () => {
  const rule = 'sentence-length'
  const item = 'あ'.repeat(60)

  it('Python の文字列の句点の無い箇条書きを、項目ごとに 1 文として数える', async () => {
    await explains('行頭のリストの記号を読む strings plugin のテストです。句点が無い長い項目を 2 つ並べた Python の文字列を渡した場合に、項目ごとに別の文として数え、規則 `sentence-length` の指摘が返らないことを確認します。')
    const text = `def f():\n    ${TRIPLE}対象を読む\n\n    - ${item}\n    - ${item}\n    ${TRIPLE}\n`
    await step('箇条書きを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, '.py', rule)).toEqual([])
    })
  })

  it.each([
    ['シェルのコメント', `# - ${item}\n# - ${item}\n`, '.sh'],
    ['YAML のコメント', `# 1. ${item}\n# 2) ${item}\n`, '.yaml'],
    ['YAML のブロックスカラー', `a: |\n  * ${item}\n  + ${item}\n`, '.yaml'],
  ])('%s の箇条書きを、項目ごとに 1 文として数える', async (name, text, extension) => {
    await explains(`行頭のリストの記号を読む strings plugin のテストです。「${name}」の、句点が無い長い項目を 2 つ並べた場合に、項目ごとに別の文として数え、規則 \`sentence-length\` の指摘が返らないことを確認します。`)
    await step('箇条書きを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, extension, rule)).toEqual([])
    })
  })

  it('コメントを調べる plugin だけで処理する .ts のコメントでも、箇条書きを項目ごとに数える', async () => {
    await explains('行頭のリストの記号を読む strings plugin のテストです。`.ts` のブロックコメントと行コメントに、句点が無い長い項目を 2 つ並べた場合に、項目ごとに別の文として数え、指摘が返らないことを確認します。')
    await step('コメントの箇条書きを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintComments(`/**\n * - ${item}\n * - ${item}\n */\nexport const a = 1\n`, rule)).toEqual([])
      expect(await lintComments(`// - ${item}\n// - ${item}\nexport const a = 1\n`, rule)).toEqual([])
    })
  })

  it('リストの記号が付いていない行は、1 つの文に連結して、文の長さの指摘を返す', async () => {
    await explains('行頭のリストの記号を読む strings plugin のテストです。リストの記号が付いていない長い行を 2 行並べた場合に、1 つの文として連結され、規則 `sentence-length` の指摘が 1 件返ることを確認します。')
    await step('記号の無い行を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`# ${item}\n# ${item}\n`, '.sh', rule)).toHaveLength(1)
    })
  })

  it('リストの記号の前で段落を分け、記号を Str に含めず、続きの行を同じ項目に残す', async () => {
    await explains('行頭のリストの記号を読む strings plugin のテストです。前文と番号付きの項目を含む文字列を変換した場合に、記号の前で段落が分かれ、`Str` に記号が含まれず、続きの行が同じ段落に残ることを確認します。')
    const text = `x = ${TRIPLE}前文\n- あ\n- い\n  続き\n1. う\n2) え${TRIPLE}\n`
    const paragraphs = await step('文字列を段落に分ける', () => stringParagraphs(text, '.py'))
    stepSync('段落の文字列を比べる', () => {
      expect(paragraphs.map(paragraph => paragraph.children.filter(child => child.type === 'Str').map(child => child.raw))).toEqual([
        ['前文'],
        ['あ'],
        ['い', '続き'],
        ['う'],
        ['え'],
      ])
    })
    stepSync('段落の位置を比べる', () => {
      expect(paragraphs.map(paragraph => [paragraph.loc.start.line, paragraph.loc.start.column])).toEqual([[1, 7], [2, 2], [3, 2], [5, 3], [6, 3]])
      expect(paragraphs[1]?.raw).toBe('あ')
      expect(paragraphs[1]?.range).toEqual([text.indexOf('あ'), text.indexOf('あ') + 1])
    })
  })

  it('コメントを調べる plugin の段落も、リストの記号の前で分け、範囲と位置を元のファイルに合わせる', async () => {
    await explains('行頭のリストの記号を読む strings plugin のテストです。前文と箇条書きを含む `.ts` のコメントを変換した場合に、記号の前で段落が分かれ、範囲と位置が元のファイルと一致することを確認します。')
    const text = '// 前文\n// - あ\n// - い\n//   続き\nexport const a = 1\n'
    const document = await step('comments plugin の Document を作る', async () => documentOf(await new (loadCommentsPlugin().Processor)().processor('.ts').preProcess(text)))
    stepSync('段落を比べる', () => {
      expect(document.children.map(paragraph => paragraph.raw)).toEqual(['前文', 'あ', 'い\n//   続き'])
      expect(document.children.map(paragraph => paragraph.range)).toEqual([[3, 5], [11, 12], [18, 19 + '\n//   続き'.length]])
      expect(document.children.map(paragraph => [paragraph.loc.start.line, paragraph.loc.start.column])).toEqual([[1, 3], [2, 5], [3, 5]])
    })
  })

  it.each([
    ['記号の後ろに空白が無い', '-1 を使う\n-x を使う'],
    ['小数', '1.5 倍にして、\n2.5 倍にする'],
    ['強調', '*強調* して、\n*再度強調* する'],
    ['記号だけの行', '前文\n-\n後文'],
  ])('%s の行は、リストの項目として扱わず、段落を分けない', async (name, written) => {
    await explains(`行頭のリストの記号を読む strings plugin のテストです。「${name}」の行を含む文字列を渡した場合に、リストの項目として扱われず、段落が 1 つのままになることを確認します。`)
    await step('空行の種類ごとの段落に分け、件数を比べる', async () => {
      expect(await stringParagraphs(`x = """${written}"""\n`, '.py')).toHaveLength(1)
    })
  })
})

describe('先頭の frontmatter', () => {
  const rule = 'sentence-length'
  const long = 'あ'.repeat(60)

  it('Python の文字列の先頭の frontmatter を、値ごとに読み、文の長さの指摘を出さない', async () => {
    await explains('文字列の先頭の frontmatter を読む strings plugin のテストです。長い値を持つ frontmatter を含む Python の文字列を渡した場合に、値ごとに別の文として読み、規則 `sentence-length` の指摘が返らないことを確認します。')
    const text = `x = ${TRIPLE}---\ntitle: ${long}\ntype: ${long}\n---\n\n本文\n${TRIPLE}\n`
    await step('frontmatter を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, '.py', rule)).toEqual([])
    })
  })

  it('閉じた --- より後ろは、通常の段落として読み、位置を元のファイルに合わせる', async () => {
    await explains('文字列の先頭の frontmatter を読む strings plugin のテストです。frontmatter の後ろに本文がある文字列を渡した場合に、frontmatter の値と本文のそれぞれの違反を、元のファイルの位置で返すことを確認します。')
    const text = `x = """---\ntitle: ${sentence}\n---\n\n${sentence}\n"""\n`
    await step('frontmatter の後ろを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(2, 8), at(5, 1)])
    })
  })

  it('シェルの複数行の文字列でも、先頭の frontmatter を読む', async () => {
    await explains('文字列の先頭の frontmatter を読む strings plugin のテストです。frontmatter を含むシェルの複数行の文字列を渡した場合に、frontmatter の値の違反を、元のファイルの位置で返すことを確認します。')
    await step('シェルの複数行の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`echo "---\ntitle: ${sentence}\n---\n"\n`, '.sh')).toEqual([at(2, 8)])
    })
  })

  it('読み取れない frontmatter は、全体を 1 つの段落として扱う', async () => {
    await explains('文字列の先頭の frontmatter を読む strings plugin のテストです。構文に誤りがあり、読み取れない frontmatter を渡した場合に、全体が 1 つの段落になり、規則 `sentence-length` の指摘が 1 件返ることを確認します。')
    const text = `x = """---\ntitle: [${long}\ntype: ${long}\n---\n"""\n`
    await step('読めない frontmatter を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(text, '.py', rule)).toHaveLength(1)
    })
  })
})

describe('loadPlugin', () => {
  it('Processor を持たないモジュールを読み込むと、TypeError を投げる', async () => {
    await explains('plugin を読み込む `loadPlugin` のテストです。Processor を持たないモジュール `yaml` を読み込んだ場合に、`TypeError` で失敗することを確認します。')
    stepSync('Processor の無いモジュールを読み込み、TypeError かを比べる', () => {
      expect(() => loadPlugin('yaml')).toThrow(TypeError)
    })
  })
})

async function raws(text: string, extension = '.py'): Promise<string[]> {
  const paragraphs = await stringParagraphs(text, extension)
  return paragraphs.map(paragraph => paragraph.raw)
}

// 文字列の本文は CommonMark のブロックの規則で読む。字下げ 4 以上のコード、フェンス、HTML ブロックは Markdown と同じく対象から外す。
describe('Markdown のブロックの規則', () => {
  it('共通の字下げを除いて読み、字下げが 4 以上の行はコードブロックとして外す', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。共通の字下げがある本文に、さらに字下げが 4 以上の行がある場合に、その行がコードブロックとして外れ、ほかの段落だけが残ることを確認します。')
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n    あ\n\n        い\n\n    う\n    ${TRIPLE}\n`)).toEqual(['あ', 'う'])
    })
  })

  it('タブは、幅 4 の字下げとして数える', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。タブで字下げした本文を渡した場合に、タブを幅 4 として数え、字下げが 4 以上の行を外すことを確認します。')
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n\tあ\n\n\t\t\tい\n${TRIPLE}\n`)).toEqual(['あ'])
    })
  })

  it('全行が同じ字下げなら、その字下げをコードブロックとして扱わない', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。全行が 4 以上の同じ字下げの場合に、共通の字下げとして除かれ、すべての段落が残ることを確認します。')
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n        あ\n\n        い\n${TRIPLE}\n`)).toEqual(['あ', 'い'])
    })
  })

  it('段落の続きにある字下げの深い行は、コードブロックにせず、段落に残す', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。段落の続きの行が深く字下げされている場合に、コードブロックにならず、同じ段落に残ることを確認します。')
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws('x = """\n    あ\n        い\n"""\n')).toEqual(['あ\n        い'])
    })
  })

  it('フェンスで囲んだコードブロックを外し、閉じていなければ末尾まで外す', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。バッククォートとチルダのフェンスで囲んだコードブロックを含む本文を渡した場合に、コードブロックが外れ、閉じていないフェンスは末尾まで外れることを確認します。')
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}あ\n\n\`\`\`\nい\n\`\`\`\n\nう\n\n~~~\nえ\n${TRIPLE}\n`)).toEqual(['あ', 'う'])
    })
  })

  it.each([
    ['div（type 6）は空行まで', 'あ\n\n<div>\nい\n\nう', ['あ', 'う']],
    ['style（type 1）は閉じタグまで空行をまたぐ', 'あ\n\n<style>\n.a { }\n\nい\n</style>\nう', ['あ', 'う']],
    ['同じ行で閉じる style', 'あ\n\n<style>.a { }</style>\n\nい', ['あ', 'い']],
    ['コメント（type 2）は --> まで', 'あ\n\n<!-- 注\n\nい -->\nう', ['あ', 'う']],
    ['単独の開始タグ（type 7）は空行まで', 'あ\n\n<span>\nい\n\nう', ['あ', 'う']],
    ['終了タグだけの行（type 7）', 'あ\n\n</span>\nい\n\nう', ['あ', 'う']],
    ['段落を中断しない type 7', 'あ\n<span>\nい', ['あ\n<span>\nい']],
    ['行の途中までのタグ（type 7 ではない）', 'あ\n\n<b>い</b> う', ['あ', '<b>い</b> う']],
  ])('HTML ブロックの場合は、%s', async (name, body, expected) => {
    await explains(`文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。HTML ブロックの「${name}」の場合に、HTML ブロックに当たる部分が外れ、期待した段落だけが残ることを確認します。`)
    await step('HTML ブロックを段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = """${body}"""\n`)).toEqual(expected)
    })
  })

  it('字下げした HTML の断片は、字下げを除いて HTML ブロックとして外す', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。字下げした HTML の断片だけを持つ `.js` の文字列を渡した場合に、字下げを除いて HTML ブロックとして外れ、段落が 1 つも残らないことを確認します。')
    await step('字下げした HTML を段落に分け、残った段落を比べる', async () => {
      expect(await raws('x = `\n      <div>\n        <span>あ</span>\n      </div>\n    `\n', '.js')).toEqual([])
    })
  })

  it('段落を中断する HTML ブロックの種類を、CommonMark 0.29 の一覧に合わせる', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。`<source>` は段落を中断して HTML ブロックになり、`<search>` は段落を中断せず、本文として残ることを確認します。')
    await step('type 6 を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}あ\n<source>\nい${TRIPLE}\n`)).toEqual(['あ'])
      expect(await raws('x = """あ\n<search>\nい"""\n')).toEqual(['あ\n<search>\nい'])
    })
  })

  it('リストの項目の内容の字下げ以上の行は、空行の後でも、項目の続きの段落として読む', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。箇条書きと番号付きの項目の後ろに、空行を挟んで内容の字下げ以上の行がある場合に、その行を項目の続きの段落として読むことを確認します。')
    await step('リスト項目を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n- あ\n\n    い\n${TRIPLE}\n`)).toEqual(['あ', 'い'])
      expect(await raws(`x = ${TRIPLE}\n1. あ\n\n   い\n${TRIPLE}\n`)).toEqual(['あ', 'い'])
    })
  })

  it('リストの項目の内容の字下げに 4 を加えた幅からは、コードブロックとして外す', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。箇条書きの項目の内容の字下げに 4 を加えた幅で字下げされた行がある場合に、その行をコードブロックとして外すことを確認します。')
    await step('リストと本文を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n- あ\n\n      い\n${TRIPLE}\n`)).toEqual(['あ'])
    })
  })

  it('項目の字下げに満たない行でリストを終え、字下げが 4 以上の行はコードブロックに戻る', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。項目の字下げに満たない行が現れた場合に、リストが終わり、その後ろの字下げが 4 以上の行がコードブロックとして外れることを確認します。')
    await step('リストと本文を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n- あ\n\nう\n\n    い\n${TRIPLE}\n`)).toEqual(['あ', 'う'])
    })
  })

  it('名前空間を持つタグは、CommonMark のタグ名ではないので、HTML ブロックにせず、本文として読む', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。`<a:p>` のように名前空間を持つタグを含む本文を渡した場合に、HTML ブロックにならず、本文として段落に残ることを確認します。')
    await step('リストと本文を段落に分け、残った段落を比べる', async () => {
      expect(await raws('x = """\n<a:p>あ</a:p>\n"""\n')).toEqual(['<a:p>あ</a:p>'])
    })
  })

  it('.sh と .yaml の文字列にも、同じ読み方を適用する', async () => {
    await explains('文字列の本文を CommonMark のブロックの規則で読む strings plugin のテストです。`.sh` と `.yaml` の文字列にフェンスのコードブロックや字下げした行がある場合に、`.py` と同じようにそれらを外すことを確認します。')
    await step('シェルの文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`echo ${QUOTE}あ\n\n\`\`\`\nい\n\`\`\`\n${QUOTE}\n`, '.sh')).toEqual(['あ'])
    })
    await step('YAML の文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws('a: |\n  あ\n\n      い\n\n  う\n', '.yaml')).toEqual(['あ', 'う'])
    })
  })

  it('テンプレート文字列の埋め込み式をまたぐバッククォートは、1 つの Code にする', async () => {
    await explains('テンプレート文字列の埋め込み式を、インライン要素の中に含めて読む strings plugin のテストです。埋め込み式を含むバッククォートで囲んだ区間を渡した場合に、1 つの `Code` として取り出されることを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `説明です。\\`<!-- ${x} -->\\``\n', '.ts'))
    stepSync('子ノードを比べる', () => {
      expect(paragraph?.children.map(child => [child.type, child.raw])).toEqual([['Str', '説明です。\\'], ['Code', '`<!-- ${x} -->\\`']])
    })
  })

  it('埋め込み式をまたぐ HTML コメントは、1 つの Html にする', async () => {
    await explains('テンプレート文字列の埋め込み式を、インライン要素の中に含めて読む strings plugin のテストです。埋め込み式を含む HTML コメントを渡した場合に、1 つの `Html` として取り出されることを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `あ <!-- ${x} --> い`\n', '.ts'))
    stepSync('子ノードを比べる', () => {
      expect(paragraph?.children.map(child => [child.type, child.raw])).toEqual([['Str', 'あ '], ['Html', '<!-- ${x} -->'], ['Str', ' い']])
    })
  })

  it('埋め込み式をまたぐ URL は、1 つの Link にする', async () => {
    await explains('テンプレート文字列の埋め込み式を、インライン要素の中に含めて読む strings plugin のテストです。埋め込み式を含む URL を渡した場合に、1 つの `Link` として取り出されることを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `あ https://a.example/${x}/b い`\n', '.ts'))
    stepSync('子ノードの種類を比べる', () => {
      expect(paragraph?.children.map(child => child.type)).toEqual(['Str', 'Link', 'Str'])
    })
  })
})

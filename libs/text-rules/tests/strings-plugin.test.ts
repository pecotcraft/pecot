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

const kernel = new TextlintKernel()
// Python の三重引用符と引用符は、日本語の文の中に literal で置くと引用符の対の規則に止められるので、定数に置く。
const TRIPLE = '"'.repeat(3)
const QUOTE = '"'
// no-exclamation-question-mark の違反を、literal ではなく補間で組み立てる。
const FULL_BANG = String.fromCodePoint(0xFF_01)
const HALF_BANG = String.fromCodePoint(0x21)

describe('strings plugin: Python', () => {
  it('代入の文字列の違反を元ファイルの行と列で返す', async () => {
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = "${sentence}"\n`, '.py')).toEqual([at(1, 6)])
    })
  })

  it('2 行目から始まる docstring の違反を 2 行目と 3 行目の正しい列で返す', async () => {
    const text = `x = 1\ny = """${sentence}\n    ${sentence}"""\n`
    await step('docstring を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(2, 8), at(3, 5)])
    })
  })

  it('コメント中の引用符で囲んだ文は、strings では数えず comments の 1 件だけにする', async () => {
    await step('コメントを規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`# "${sentence}"\n`, '.py')).toEqual([at(1, 4)])
    })
  })

  it('日本語を含まない文字列は Paragraph にしない', async () => {
    await step('文字列を段落に分け、空かを比べる', async () => {
      expect(await stringParagraphs('x = "only ascii"\n', '.py')).toEqual([])
    })
  })

  it('文字列中の # で文字列が切れない', async () => {
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = "#tag ${sentence}"\n`, '.py')).toEqual([at(1, 11)])
    })
  })

  it.each([
    ['f 接頭辞', `x = f"${sentence}"\n`, 7],
    ['r 接頭辞', `x = r'${sentence}'\n`, 7],
  ])('%s の文字列のとき、文字列の位置に指摘を 1 件返す', async (_name, text, column) => {
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(1, column)])
    })
  })

  it('トリプルクォート内の単独の二重引用符で文字列が終わらない', async () => {
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = """前 "引用" ${sentence}"""\n`, '.py')).toEqual([at(1, 15)])
    })
  })

  it('バックスラッシュと改行で続く文字列を行ごとに数える', async () => {
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = "${sentence}\\\n${sentence}"\n`, '.py')).toEqual([at(1, 6), at(2, 1)])
    })
  })

  it('エスケープの \\n\\n で段落を分け、sentence-length を出さない', async () => {
    const long = 'あ'.repeat(60)
    await step('各形式の文字列を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(`x = "${long}\\n\\n${long}"\n`, '.py', 'sentence-length')).toEqual([])
      expect(await lint(`{"a": "${long}\\n\\n${long}"}\n`, '.json', 'sentence-length')).toEqual([])
      expect(await lint(`a: "${long}\\n\\n${long}"\n`, '.yaml', 'sentence-length')).toEqual([])
    })
  })

  it('エスケープを解かない文字列は、\\n を改行にしない', async () => {
    const long = 'あ'.repeat(60)
    await step('YAML の文字列を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`a: '${long}\\n\\n${long}'\n`, '.yaml', 'sentence-length')).toHaveLength(1)
    })
  })

  it('CRLF の行末の CR を Str に含めず、2 行目の列を数える', async () => {
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

  it('BOM 付きでも列がずれない', async () => {
    await step('Python の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`\u{FEFF}x = "${sentence}"\n`, '.py')).toEqual([at(1, 6)])
    })
  })

  it('コメントと文字列の違反を range の順に 1 件ずつ返す', async () => {
    const text = `# ${sentence}\nx = "${sentence}"\n`
    await step('規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(1, 3), at(2, 6)])
    })
  })

  it('100 文字を超える文字列を sentence-length として 1 件返す', async () => {
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
  ])('%s の文字列のとき、文字列の位置に指摘を 1 件返す', async (_name, text, column) => {
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.sh')).toEqual([at(1, column)])
    })
  })

  it('${#x} の # をコメントにせず、後ろの文字列を読む', async () => {
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`echo \${#x} "${sentence}"\n`, '.sh')).toEqual([at(1, 13)])
    })
  })

  it('heredoc の中の単引用符を文字列の開始にしない', async () => {
    const text = `cat <<EOF\nit's\nEOF\necho "${sentence}"\n`
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.sh')).toEqual([at(4, 7)])
    })
  })

  it('入れ子のコマンド置換の中の同じ引用符は境界だけ誤り、位置は元ファイルのまま', async () => {
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`echo "$(echo "x")${sentence}"\n`, '.sh')).toEqual([at(1, 18)])
    })
  })

  it('.bash でも読む', async () => {
    await step('シェルの文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`echo "${sentence}"\n`, '.bash')).toEqual([at(1, 7)])
    })
  })
})

describe('strings plugin: JSON', () => {
  it('値の違反を返す', async () => {
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`{"description": "${sentence}"}\n`, '.json')).toEqual([at(1, 18)])
    })
  })

  it('キーは対象にしない', async () => {
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`{"${sentence}": "ok"}\n`, '.json')).toEqual([])
    })
  })

  it('.jsonc のコメントは strings が拾わず、comments の 1 件だけにする', async () => {
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
  ])('%s の値のとき、値の位置に指摘を 1 件返す', async (_name, text, column) => {
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.yaml')).toEqual([at(1, column)])
    })
  })

  it('ブロックスカラーの 2 行目以降を行ごとに数える', async () => {
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`description: |\n  ${sentence}\n  ${sentence}\n`, '.yaml')).toEqual([at(2, 3), at(3, 3)])
    })
  })

  it('キーは対象にせず、# コメントは comments の 1 件だけにする', async () => {
    await step('キーを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(`${word}: 1\n`, '.yml')).toEqual([])
    })
    await step('コメントを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`# ${sentence}\n`, '.yaml')).toEqual([at(1, 3)])
    })
  })

  it('埋め込んだ frontmatter は値ごとに Paragraph へ分け、sentence-length を出さない', async () => {
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

  it('埋め込んだ frontmatter の値の違反を、その値の元ファイルの位置で返す', async () => {
    const text = `items:\n  - frontmatter: |\n      ---\n      layout: x\n      title: "${sentence}"\n      ---\n`
    await step('frontmatter を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.yaml')).toEqual([at(5, 15)])
    })
  })

  it('2 ドキュメントを両方読む', async () => {
    await step('JSON または YAML の値を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`a: '${sentence}'\n---\nb: '${sentence}'\n`, '.yaml')).toEqual([at(1, 5), at(3, 5)])
    })
  })
})

describe('Processor', () => {
  const processor = new strings.Processor()

  it('対象の拡張子を返す', () => {
    stepSync('対象の拡張子を比べる', () => {
      expect(processor.availableExtensions()).toEqual(['.py', '.pyi', '.sh', '.bash', '.json', '.jsonc', '.yaml', '.yml', '.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.vue'])
    })
  })

  it('Document は range 順の children と全文の位置を持ち、parent を付けない', async () => {
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

  it('複数行の文字列は Str と Break の交互にし、Str の range は引用符とインデントを含めない', async () => {
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

  it('空行で区切った句点の無い 2 段落は、1 文に連結せず sentence-length を出さない', async () => {
    const paragraph = 'あ'.repeat(60)
    await step('Python の docstring を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`def f():\n    """${paragraph}\n\n    ${paragraph}\n    """\n`, '.py', 'sentence-length')).toEqual([])
      expect(await lint(`x = """${paragraph}\n${paragraph}"""\n`, '.py', 'sentence-length')).toHaveLength(1)
    })
  })

  it('空行（空白だけの行を含む）で Paragraph を分け、空行の無い複数行は 1 つのまま', async () => {
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

  it('postProcess は messages と filePath をそのまま返し、filePath が無ければ空文字にする', () => {
    const python = processor.processor('.py')
    stepSync('postProcess の結果を比べる', () => {
      expect(python.postProcess([], 'a.py')).toEqual({ messages: [], filePath: 'a.py' })
      expect(python.postProcess([])).toEqual({ messages: [], filePath: '' })
    })
  })

  it('対象外の拡張子は stringParagraphs が RangeError にする', async () => {
    await step('対象外の拡張子で段落に分け、RangeError かを比べる', async () => {
      await expect(stringParagraphs('x', '.go')).rejects.toThrow(RangeError)
    })
  })

  it('変換後の text を返す形式の preProcess 結果からも Document を取り出す', async () => {
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
  ])('%s のバッククォートで囲んだ区間は規則の対象にしない', async (_name, text, extension) => {
    await step('バッククォートの区間を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, extension, rule)).toEqual([])
    })
  })

  it('comments plugin だけで処理する .ts のコメントも対象から外す', async () => {
    await step('comments plugin のコメントを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintComments('// 差分の行には `[!code ++]` を付ける。\nexport const a = 1\n', rule)).toEqual([])
    })
  })

  it('Code の外の違反は従来どおり、元ファイルの位置で返す', async () => {
    await step('Code の外を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`x = "\`a\` 本当に${FULL_BANG} \`b\` 終わり。"\n`, '.py', rule)).toEqual([hit(13)])
      expect(await lintComments(`// \`a\` 本当に${FULL_BANG} \`b\` 終わり。\n`, rule)).toEqual([hit(11)])
    })
  })

  it('複数行のコメントと、行頭と行末の Code も対象から外す', async () => {
    await step('複数行のコメントを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintComments('/*\n * `[!a]` 差分の行。\n * 差分の行は `[!b]`\n */\nexport const a = 1\n', rule)).toEqual([])
    })
  })

  it('閉じていないバッククォートは Str のまま規則の対象にする', async () => {
    await step('閉じていないバッククォートを規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`x = "差分には \`[${HALF_BANG}code ++] を付ける。"\n`, '.py', rule)).toHaveLength(1)
      expect(await lintComments(`// 差分には \`\`[${HALF_BANG}code ++]\` を付ける。\n`, rule)).toHaveLength(1)
    })
  })

  it('Code の前後の Str と Code の range と loc を元ファイルに合わせ、value は内側、raw はバッククォート込みにする', async () => {
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

  it('複数行の文字列では、2 行目以降の Code の行と列を元ファイルに合わせる', async () => {
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
  ])('%s は規則の対象にしない', async (_name, text) => {
    await step('対象外の区間を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, '.py', rule)).toEqual([])
    })
  })

  it('タグでない < と > は Str のまま規則の対象にする', async () => {
    await step('タグでない記号を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`x = "x < y かつ y > z を確認する${FULL_BANG}"\n`, '.py', rule)).toHaveLength(1)
    })
  })

  it('Html の前後の Str と Html の range と loc を元ファイルに合わせる', async () => {
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
  ])('Markdown の断片（lintText）と同じ件数と規則を返す: %s', async (_name, content) => {
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
  ])('%s の URL は文の長さに入れない', async (_name, text, extension) => {
    await step('URL を含む文を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, extension, rule)).toEqual([])
    })
  })

  it('comments plugin だけで処理する .ts のコメントでも URL を文の長さに入れない', async () => {
    await step('comments plugin のコメントを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintComments(`// 詳細は ${url} を参照する。\nexport const a = 1\n`, rule)).toEqual([])
    })
  })

  it('URL でない長い文字列は従来どおり sentence-length を出す', async () => {
    await step('URL でない長い文字列を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`x = "詳細は ${url.replace('https://', 'ftp://')} を参照する。"\n`, '.py', rule)).toHaveLength(1)
    })
  })

  it('Link の子を URL の Str にし、url 属性を持たせて、位置を元ファイルに合わせる', async () => {
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
  ])('URL の末尾の %s は含めない', async (_name, written, expected) => {
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
  ])('%s は Link にしない', async (_name, written) => {
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

  it('Python の文字列の句点の無い箇条書きを、項目ごとに文として数える', async () => {
    const text = `def f():\n    ${TRIPLE}対象を読む\n\n    - ${item}\n    - ${item}\n    ${TRIPLE}\n`
    await step('箇条書きを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, '.py', rule)).toEqual([])
    })
  })

  it.each([
    ['シェルのコメント', `# - ${item}\n# - ${item}\n`, '.sh'],
    ['YAML のコメント', `# 1. ${item}\n# 2) ${item}\n`, '.yaml'],
    ['YAML のブロックスカラー', `a: |\n  * ${item}\n  + ${item}\n`, '.yaml'],
  ])('%s の箇条書きを項目ごとに文として数える', async (_name, text, extension) => {
    await step('箇条書きを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, extension, rule)).toEqual([])
    })
  })

  it('comments plugin だけで処理する .ts のコメントも項目ごとに数える', async () => {
    await step('コメントの箇条書きを規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintComments(`/**\n * - ${item}\n * - ${item}\n */\nexport const a = 1\n`, rule)).toEqual([])
      expect(await lintComments(`// - ${item}\n// - ${item}\nexport const a = 1\n`, rule)).toEqual([])
    })
  })

  it('記号の無い行は従来どおり 1 文に連結して sentence-length を出す', async () => {
    await step('記号の無い行を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(`# ${item}\n# ${item}\n`, '.sh', rule)).toHaveLength(1)
    })
  })

  it('記号の前で段落を分け、Str に記号を含めず、続きの行は同じ項目に残す', async () => {
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

  it('comments plugin の Paragraph も記号の前で分け、range と loc を元ファイルに合わせる', async () => {
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
  ])('%s 行は段落を分けない', async (_name, written) => {
    await step('空行の種類ごとの段落に分け、件数を比べる', async () => {
      expect(await stringParagraphs(`x = """${written}"""\n`, '.py')).toHaveLength(1)
    })
  })
})

describe('先頭の frontmatter', () => {
  const rule = 'sentence-length'
  const long = 'あ'.repeat(60)

  it('Python の文字列でも値ごとに読み、sentence-length を出さない', async () => {
    const text = `x = ${TRIPLE}---\ntitle: ${long}\ntype: ${long}\n---\n\n本文\n${TRIPLE}\n`
    await step('frontmatter を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, '.py', rule)).toEqual([])
    })
  })

  it('閉じた --- より後は通常の段落として読み、位置を元ファイルに合わせる', async () => {
    const text = `x = """---\ntitle: ${sentence}\n---\n\n${sentence}\n"""\n`
    await step('frontmatter の後ろを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.py')).toEqual([at(2, 8), at(5, 1)])
    })
  })

  it('シェルの複数行の文字列でも読む', async () => {
    await step('シェルの複数行の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`echo "---\ntitle: ${sentence}\n---\n"\n`, '.sh')).toEqual([at(2, 8)])
    })
  })

  it('読めない frontmatter は従来どおり全体を 1 つの段落にする', async () => {
    const text = `x = """---\ntitle: [${long}\ntype: ${long}\n---\n"""\n`
    await step('読めない frontmatter を規則にかけ、指摘の件数を比べる', async () => {
      expect(await lint(text, '.py', rule)).toHaveLength(1)
    })
  })
})

describe('loadPlugin', () => {
  it('Processor を持たないモジュールは TypeError にする', () => {
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
  it('共通の字下げを除いて読み、字下げ 4 以上の行はコードブロックとして外す', async () => {
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n    あ\n\n        い\n\n    う\n    ${TRIPLE}\n`)).toEqual(['あ', 'う'])
    })
  })

  it('タブは幅 4 として数える', async () => {
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n\tあ\n\n\t\t\tい\n${TRIPLE}\n`)).toEqual(['あ'])
    })
  })

  it('全行が同じ字下げなら、その字下げはコードブロックにしない', async () => {
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n        あ\n\n        い\n${TRIPLE}\n`)).toEqual(['あ', 'い'])
    })
  })

  it('段落の続きの深い字下げ行は、段落に残す（lazy continuation）', async () => {
    await step('文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws('x = """\n    あ\n        い\n"""\n')).toEqual(['あ\n        い'])
    })
  })

  it('フェンスのコードブロックを外し、閉じなければ末尾まで外す', async () => {
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
  ])('HTML ブロック: %s', async (_name, body, expected) => {
    await step('HTML ブロックを段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = """${body}"""\n`)).toEqual(expected)
    })
  })

  it('字下げした HTML の断片は、字下げを除いて HTML ブロックとして外す', async () => {
    await step('字下げした HTML を段落に分け、残った段落を比べる', async () => {
      expect(await raws('x = `\n      <div>\n        <span>あ</span>\n      </div>\n    `\n', '.js')).toEqual([])
    })
  })

  it('段落を中断する type 6 は micromark 2.11（CommonMark 0.29）の一覧に揃え、source は中断し、search は中断しない', async () => {
    await step('type 6 を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}あ\n<source>\nい${TRIPLE}\n`)).toEqual(['あ'])
      expect(await raws('x = """あ\n<search>\nい"""\n')).toEqual(['あ\n<search>\nい'])
    })
  })

  it('リスト項目の内容の字下げ以上の行は、空行の後でも項目の続きの段落として読む', async () => {
    await step('リスト項目を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n- あ\n\n    い\n${TRIPLE}\n`)).toEqual(['あ', 'い'])
      expect(await raws(`x = ${TRIPLE}\n1. あ\n\n   い\n${TRIPLE}\n`)).toEqual(['あ', 'い'])
    })
  })

  it('リスト項目の内容の字下げに 4 を足した幅からは、コードブロックとして外す', async () => {
    await step('リストと本文を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n- あ\n\n      い\n${TRIPLE}\n`)).toEqual(['あ'])
    })
  })

  it('項目の字下げに満たない行でリストを終え、字下げ 4 以上はコードブロックに戻る', async () => {
    await step('リストと本文を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`x = ${TRIPLE}\n- あ\n\nう\n\n    い\n${TRIPLE}\n`)).toEqual(['あ', 'う'])
    })
  })

  it('CommonMark のタグ名でない名前空間付きのタグは、HTML ブロックにせず本文として読む', async () => {
    await step('リストと本文を段落に分け、残った段落を比べる', async () => {
      expect(await raws('x = """\n<a:p>あ</a:p>\n"""\n')).toEqual(['<a:p>あ</a:p>'])
    })
  })

  it('.sh と .yaml の文字列にも同じ読み方を掛ける', async () => {
    await step('シェルの文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws(`echo ${QUOTE}あ\n\n\`\`\`\nい\n\`\`\`\n${QUOTE}\n`, '.sh')).toEqual(['あ'])
    })
    await step('YAML の文字列を段落に分け、残った段落を比べる', async () => {
      expect(await raws('a: |\n  あ\n\n      い\n\n  う\n', '.yaml')).toEqual(['あ', 'う'])
    })
  })

  it('テンプレート文字列の ${} をまたぐバッククォートは 1 つの Code にする', async () => {
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `説明です。\\`<!-- ${x} -->\\``\n', '.ts'))
    stepSync('子ノードを比べる', () => {
      expect(paragraph?.children.map(child => [child.type, child.raw])).toEqual([['Str', '説明です。\\'], ['Code', '`<!-- ${x} -->\\`']])
    })
  })

  it('${} をまたぐ HTML コメントは 1 つの Html にする', async () => {
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `あ <!-- ${x} --> い`\n', '.ts'))
    stepSync('子ノードを比べる', () => {
      expect(paragraph?.children.map(child => [child.type, child.raw])).toEqual([['Str', 'あ '], ['Html', '<!-- ${x} -->'], ['Str', ' い']])
    })
  })

  it('${} をまたぐ URL は 1 つの Link にする', async () => {
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `あ https://a.example/${x}/b い`\n', '.ts'))
    stepSync('子ノードの種類を比べる', () => {
      expect(paragraph?.children.map(child => child.type)).toEqual(['Str', 'Link', 'Str'])
    })
  })
})

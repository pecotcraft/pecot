import { describe, expect, it } from 'vitest'
import strings, { stringParagraphs } from '../lib/plugins/strings.js'
import { typescriptStrings } from '../lib/plugins/typescript.js'
import type { Grammar } from '../lib/plugins/typescript.js'
import { at, lint, lintAll, sentence } from './helpers/strings.js'
import { step, stepSync } from '../../interface-spec/src/vitest/step.js'
import { explains } from './helpers/explains.js'

describe('strings plugin: TypeScript / JavaScript', () => {
  it.each([
    ['.ts'],
    ['.mts'],
    ['.cts'],
    ['.tsx'],
    ['.js'],
    ['.mjs'],
    ['.cjs'],
    ['.jsx'],
  ])('%s の文字列に違反があると、元のファイルの行と桁で指摘を返す', async (extension) => {
    await explains(`TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。拡張子が \`${extension}\` のファイルの文字列に違反がある場合に、元のファイルの 2 行目 12 桁の指摘を返すことを確認します。`)
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`export const a = 1\nconst b = '${sentence}'\n`, extension)).toEqual([at(2, 12)])
    })
  })

  it('二重引用符で囲んだ文字列にも、違反があれば指摘を返す', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。二重引用符で囲んだ文字列に違反がある場合に、元のファイルの位置で指摘を返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const b = "${sentence}"\n`, '.ts')).toEqual([at(1, 12)])
    })
  })

  it('バッククォートで囲んだテンプレート文字列にも、違反があれば指摘を返す', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。バッククォートで囲んだテンプレート文字列に違反がある場合に、元のファイルの位置で指摘を返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const b = \`${sentence}\`\n`, '.ts')).toEqual([at(1, 12)])
    })
  })

  it('tsx の JSX の属性の文字列にも、違反があれば指摘を返す', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。`.tsx` ファイルの JSX の属性の文字列に違反がある場合に、元のファイルの位置で指摘を返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const b = <div title="${sentence}" />\n`, '.tsx')).toEqual([at(1, 23)])
    })
  })

  it('日本語を含まない文字列は、段落として取り出さない', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。英数字だけの文字列と、埋め込み式だけのテンプレート文字列を渡した場合に、段落が 1 つも取り出されないことを確認します。')
    await step('日本語を含まない文字列を段落に分け、空かを比べる', async () => {
      expect(await stringParagraphs('const a = "only ascii"\nconst b = `x${1}y`\n', '.ts')).toEqual([])
    })
  })

  it('コメントと文字列の違反を、位置の順に 1 件ずつ返す', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。コメントと文字列の両方に違反がある場合に、位置の順に 1 件ずつ、合わせて 2 件の指摘を返すことを確認します。')
    const text = `// ${sentence}\nconst a = '${sentence}'\n`
    await step('コメントと文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, '.ts')).toEqual([at(1, 4), at(2, 12)])
    })
  })

  it('文字列の中の // や /* を、文字列の区切りやコメントとして扱わない', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。文字列の中に `//` と `/*` が含まれる場合に、文字列が途中で切れず、コメントとしても数えられず、文字列の中の違反が返ることを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = 'http://x /* ${sentence}'\n`, '.ts')).toEqual([at(1, 24)])
    })
  })

  it('エスケープした引用符では、文字列が終わらない', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。文字列の中に、バックスラッシュでエスケープした引用符がある場合に、その後ろの違反まで同じ文字列として読むことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = 'it\\'s ${sentence}'\n`, '.ts')).toEqual([at(1, 18)])
    })
  })

  it('先頭に BOM があっても、指摘の桁がずれない', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。先頭に BOM があるファイルを渡した場合に、BOM が無いファイルと同じ桁で指摘を返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`\u{FEFF}const a = '${sentence}'\n`, '.ts')).toEqual([at(1, 12)])
    })
  })

  it('サロゲートペアの文字の後ろでも、桁を 1 文字ずつ数えてずらさない', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。文字列の先頭に絵文字のようなサロゲートペアの文字がある場合、その文字を 1 文字として数え、後ろの違反の桁が正しい値になることを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = '\u{1F600}${sentence}'\n`, '.ts')).toEqual([at(1, 13)])
    })
  })

  it('閉じていない文字列は数えず、次の行の文字列は読む', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。引用符が閉じていない行の次の行に、違反のある文字列がある場合に、閉じていない行は数えず、次の行の違反だけを返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = 'x\nconst b = "${sentence}"\n`, '.ts')).toEqual([at(2, 12)])
    })
  })

  it('複数行の文字列は、行ごとに位置を数えて指摘を返す', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。複数行にわたるテンプレート文字列の各行に違反がある場合に、1 行目と 2 行目の位置でそれぞれ指摘を返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = \`${sentence}\n${sentence}\`\n`, '.ts')).toEqual([at(1, 12), at(2, 1)])
    })
  })

  it('改行が CRLF のファイルでは、行末の CR を文に含めず、2 行目の桁を正しく数える', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。改行が CRLF のファイルを渡した場合に、行末の CR が文に含まれず、2 行目の指摘の桁が正しい値になることを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = '${sentence}'\r\nconst b = '${sentence}'\r\n`, '.ts')).toEqual([at(1, 12), at(2, 12)])
    })
  })

  it('空の入力でも、エラーにならず、段落を持たない結果を返す', async () => {
    await explains('TypeScript と JavaScript のファイルから文を取り出す strings plugin のテストです。空の文字列を渡した場合に、エラーにならず、段落が 1 つも取り出されないことを確認します。')
    await step('空文字の入力を段落に分け、空かを比べる', async () => {
      expect(await stringParagraphs('', '.ts')).toEqual([])
    })
  })
})

describe('strings plugin: テンプレート文字列の ${}', () => {
  it('埋め込み式を挟んで括弧が閉じる文を、途中で分けずに 1 つの文として読む', async () => {
    await explains('文字列の埋め込み式を含むテンプレート文字列を読む strings plugin のテストです。埋め込み式を挟んで括弧が閉じる文を渡した場合に、文が途中で分けられず、指摘が 1 件も返らないことを確認します。')
    await step('括弧をまたぐテンプレート文字列を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lintAll('const a = `${1}の値（${2}）を使います。`\n', '.ts')).toEqual([])
    })
  })

  it('埋め込み式の後ろの行にある違反を、元のファイルの行と桁で返す', async () => {
    await explains('文字列の埋め込み式を含むテンプレート文字列を読む strings plugin のテストです。埋め込み式の次の行に違反がある場合に、元のファイルの 2 行目 1 桁の指摘を返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = \`\${1}\n${sentence}\`\n`, '.ts')).toEqual([at(2, 1)])
    })
  })

  it('埋め込み式の中の文字列は、外側のテンプレート文字列とは別に読む', async () => {
    await explains('文字列の埋め込み式を含むテンプレート文字列を読む strings plugin のテストです。埋め込み式の中の文字列に違反がある場合に、外側とは別の文字列として読み、元のファイルの位置で指摘を返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = \`\${x ? '${sentence}' : ''}\`\n`, '.ts')).toEqual([at(1, 19)])
    })
  })

  it('埋め込み式の中の文字列だけが日本語のテンプレート文字列は、日本語の文字列だけを数える', async () => {
    await explains('文字列の埋め込み式を含むテンプレート文字列を読む strings plugin のテストです。埋め込み式の中に日本語の文字列だけがある場合は段落を 1 つ取り出し、関数の呼び出しだけがある場合は段落を取り出さないことを確認します。')
    await step('日本語だけの ${} を段落に分け、件数を比べる', async () => {
      expect(await stringParagraphs('const a = `${"あ"}`\n', '.ts')).toHaveLength(1)
    })
    await step('日本語を含まない ${} を段落に分け、空かを比べる', async () => {
      expect(await stringParagraphs('const a = `${f()}`\n', '.ts')).toEqual([])
    })
  })

  it('埋め込み式を、元のファイルの範囲を持つ Code にして、段落に入れる', async () => {
    await explains('文字列の埋め込み式を含むテンプレート文字列を読む strings plugin のテストです。埋め込み式を含むテンプレート文字列を渡した場合に、埋め込み式が `Code` として段落の子になり、元のファイルの範囲と値 `X` を持つことを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `あ${x}い`\n', '.ts'))
    stepSync('子ノードを比べる', () => {
      expect(paragraph?.children.map(child => [child.type, child.raw, child.range])).toEqual([
        ['Str', 'あ', [11, 12]],
        ['Code', '${x}', [12, 16]],
        ['Str', 'い', [16, 17]],
      ])
    })
    stepSync('Code の位置を比べる', () => {
      expect(paragraph?.children[1]).toMatchObject({ value: 'X', loc: { start: { line: 1, column: 12 }, end: { line: 1, column: 16 } } })
    })
  })

  it('複数行にまたがる埋め込み式は、行を分けず、1 つの Code にする', async () => {
    await explains('文字列の埋め込み式を含むテンプレート文字列を読む strings plugin のテストです。埋め込み式が複数行にまたがる場合、行ごとに分けず、1 つの `Code` として段落の子になることを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `あ${f(\n  x,\n)}い`\n', '.ts'))
    stepSync('子ノードの種類を比べる', () => {
      expect(paragraph?.children.map(child => child.type)).toEqual(['Str', 'Code', 'Str'])
    })
    stepSync('Code の raw を比べる', () => {
      expect(paragraph?.children[1]?.raw).toBe('${f(\n  x,\n)}')
    })
  })

  it('埋め込み式で始まり、埋め込み式で終わるテンプレート文字列も読む', async () => {
    await explains('文字列の埋め込み式を含むテンプレート文字列を読む strings plugin のテストです。埋め込み式で始まり、埋め込み式で終わるテンプレート文字列を渡した場合に、`Code`、`Str`、`Code` の順に子が並ぶことを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs('const a = `${x}あ${y}`\n', '.ts'))
    stepSync('子ノードの種類を比べる', () => {
      expect(paragraph?.children.map(child => child.type)).toEqual(['Code', 'Str', 'Code'])
    })
  })
})

describe('strings plugin: 文字列の本文のエスケープ', () => {
  const rule = 'sentence-length'
  const long = 'あ'.repeat(60)

  it.each([
    ['単引用符の文字列の \\n\\n', `const a = '${long}\\n\\n${long}'\n`],
    ['二重引用符の文字列の \\n\\n', `const a = "${long}\\n\\n${long}"\n`],
    ['テンプレート文字列の \\n\\n', `const a = \`${long}\\n\\n${long}\`\n`],
    ['\\r\\n\\r\\n', `const a = '${long}\\r\\n\\r\\n${long}'\n`],
  ])('%s で段落を分け、文の長さの指摘を出さない', async (name, text) => {
    await explains(`文字列の中のエスケープを読む strings plugin のテストです。\`${name}\` で区切られた 2 つの長い文を渡した場合に、段落が分かれ、規則 \`sentence-length\` の指摘が返らないことを確認します。`)
    await step('段落の分かれ方を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(text, '.ts', rule)).toEqual([])
    })
  })

  it('エスケープしたバックスラッシュに続く n は改行にせず、1 つの文として数える', async () => {
    await explains('文字列の中のエスケープを読む strings plugin のテストです。エスケープしたバックスラッシュの後ろに `n` が続く場合に、改行として扱わず、2 つの長い文が 1 つの文として数えられ、指摘が 1 件返ることを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(`const a = '${long}\\\\n\\\\n${long}'\n`, '.ts', rule)).toHaveLength(1)
    })
  })

  it('文字列の中のエスケープした改行を Break にして、位置を元のファイルのまま保つ', async () => {
    await explains('文字列の中のエスケープを読む strings plugin のテストです。文字列の中にエスケープした改行がある場合に、`Str`・`Break`・`Str` の順に子が並び、それぞれの範囲が元のファイルの位置と一致することを確認します。')
    const [paragraph] = await step('文字列を段落に分ける', () => stringParagraphs(String.raw`const a = 'あ\nい'` + '\n', '.ts'))
    stepSync('Str と Break を比べる', () => {
      expect(paragraph?.children.map(child => [child.type, child.raw, child.range])).toEqual([
        ['Str', 'あ', [11, 12]],
        ['Break', String.raw`\n`, [12, 14]],
        ['Str', 'い', [14, 15]],
      ])
    })
  })

  it('エスケープしたタブも字下げの幅 4 として数え、字下げが 4 以上のコードを取り除く', async () => {
    await explains('文字列の中のエスケープを読む strings plugin のテストです。エスケープしたタブで字下げされた行がある場合に、タブを幅 4 として数え、字下げが 4 以上の行をコードとして外すことを確認します。')
    const paragraphs = await step('文字列を段落に分ける', () => stringParagraphs(String.raw`const a = '\n\tあ\n\n\t\t\tい'` + '\n', '.ts'))
    stepSync('残った段落を比べる', () => {
      expect(paragraphs.map(paragraph => paragraph.raw)).toEqual(['あ'])
    })
  })
})

describe('strings plugin: 文字列をまたぐ文書単位の規則', () => {
  const rule = 'no-mix-dearu-desumasu'
  // 調の語尾は、このファイルの文字列を同じ規則で止めないよう、コードポイントから組み立てる。
  const dearu = String.fromCodePoint(0x30_67, 0x30_42, 0x30_8B)
  const desu = String.fromCodePoint(0x30_67, 0x30_59)

  async function mixHits(first: string, second: string): Promise<unknown[]> {
    const hits = await lintAll(`const a = '${first}。'\nconst b = '${second}。'\n`, '.ts')
    return hits.filter(hit => hit.ruleId.includes(rule))
  }

  it('ファイルの中の別々の文字列で、文の調子がそろわなければ、違反にする', async () => {
    await explains('複数の文字列にまたがる、文書の単位の規則 `no-mix-dearu-desumasu` を読む strings plugin のテストです。別々の文字列で「である」調と「です」調が併用される場合に、指摘が 1 件返ることを確認します。')
    await step('調の混在を判定し、指摘の件数を比べる', async () => {
      expect(await mixHits(`これは試験${dearu}`, `これは試験${desu}`)).toHaveLength(1)
    })
  })

  it('別々の文字列でも、文の調子がそろっていれば、違反にしない', async () => {
    await explains('複数の文字列にまたがる、文書の単位の規則 `no-mix-dearu-desumasu` を読む strings plugin のテストです。別々の文字列がどちらも「です」調の場合に、指摘が 1 件も返らないことを確認します。')
    await step('調の混在を判定し、指摘が無いかを比べる', async () => {
      expect(await mixHits(`これは試験${desu}`, `これも試験${desu}`)).toEqual([])
    })
  })
})

describe('typescriptStrings: 構文の誤りを含むコード', () => {
  // 誤りの部分木に入っても文字列は拾う。構文の誤りそのものは各パッケージの tsc が止めるので、hasError では止めない。
  it('String.raw に不正な unicode のエスケープがあっても、後ろの文字列の違反を返す', async () => {
    await explains('構文の誤りを含むコードから文字列を取り出す `typescriptStrings` のテストです。`String.raw` のテンプレートに不正な unicode のエスケープがある場合に、後ろの文字列の違反を元のファイルの位置で返すことを確認します。')
    await step('TypeScript の文字列を規則にかけ、指摘の位置を比べる', async () => {
      const text = `const p = String.raw\`C:\\ubuntu\`\nconst b = '${sentence}'\n`
      expect(await lint(text, '.ts')).toEqual([at(2, 12)])
    })
  })

  it('閉じていない文字列の行は調べず、終了コード 2 の実行の失敗にもしない', async () => {
    await explains('構文の誤りを含むコードから文字列を取り出す `typescriptStrings` のテストです。引用符が閉じていない文字列を渡した場合に、指摘が 1 件も返らず、エラーにもならないことを確認します。')
    await step('閉じていない文字列を規則にかけ、指摘が無いかを比べる', async () => {
      expect(await lint(`const a = '${sentence}\n`, '.ts')).toEqual([])
    })
  })
})

describe('typescriptStrings: 取り出す区間', () => {
  it('型注釈の string というキーワードは、文字列の区間として取り出さない', async () => {
    await explains('TypeScript のコードから文字列の区間を取り出す `typescriptStrings` のテストです。型注釈に `string` と書かれ、値が文字列のコードを渡した場合に、値の文字列の区間だけが取り出されることを確認します。')
    const text = `let x: string = 'あ'\n`
    await step('文字列の区間を求めて比べる', async () => {
      expect(await typescriptStrings('typescript')(text)).toMatchObject([{ start: 17, end: 18 }])
    })
  })

  const jsxCases: readonly (readonly [Grammar, string])[] = [
    ['tsx', '.tsx'],
    ['javascript', '.jsx'],
  ]

  it.each(jsxCases)('%s の JSX のテキストを文字列の区間として取り出し、違反を元のファイルの行と桁で返す', async (grammar, extension) => {
    await explains(`TypeScript のコードから文字列の区間を取り出す \`typescriptStrings\` のテストです。文法 \`${grammar}\` で JSX のテキストを渡した場合に、テキストが区間として取り出され、違反が元のファイルの位置で返ることを確認します。`)
    const text = `const b = <p>${sentence}</p>\n`
    await step('JSX のテキストの区間を求めて比べる', async () => {
      expect(await typescriptStrings(grammar)(text)).toEqual([{ start: 13, end: 13 + sentence.length }])
    })
    await step('JSX のテキストを規則にかけ、指摘の位置を比べる', async () => {
      expect(await lint(text, extension)).toEqual([at(1, 14)])
    })
  })
})

describe('Processor: TypeScript / JavaScript', () => {
  it('対象の拡張子に、TypeScript・JavaScript・.vue のものを含む', async () => {
    await explains('文字列を取り出す plugin の Processor のテストです。対応する拡張子の一覧を取得した場合に、Python やシェルなどの拡張子に続けて、TypeScript・JavaScript・`.vue` の拡張子が並ぶことを確認します。')
    stepSync('対象の拡張子を比べる', () => {
      expect(new strings.Processor().availableExtensions()).toEqual([
        '.py', '.pyi', '.sh', '.bash', '.json', '.jsonc', '.yaml', '.yml',
        '.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.vue',
      ])
    })
  })
})

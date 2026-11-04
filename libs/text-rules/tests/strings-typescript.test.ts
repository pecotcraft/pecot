import { describe, expect, it } from 'vitest'
import strings, { stringParagraphs } from '../lib/plugins/strings.js'
import { typescriptStrings } from '../lib/plugins/typescript.js'
import type { Grammar } from '../lib/plugins/typescript.js'
import { at, lint, lintAll, sentence } from './helpers/strings.js'

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
  ])('%s の文字列の違反を元ファイルの行と列で返す', async (extension) => {
    expect(await lint(`export const a = 1\nconst b = '${sentence}'\n`, extension)).toEqual([at(2, 12)])
  })

  it('二重引用符の文字列も読む', async () => {
    expect(await lint(`const b = "${sentence}"\n`, '.ts')).toEqual([at(1, 12)])
  })

  it('テンプレート文字列を読む', async () => {
    expect(await lint(`const b = \`${sentence}\`\n`, '.ts')).toEqual([at(1, 12)])
  })

  it('tsx の JSX 属性の文字列を読む', async () => {
    expect(await lint(`const b = <div title="${sentence}" />\n`, '.tsx')).toEqual([at(1, 23)])
  })

  it('日本語を含まない文字列は Paragraph にしない', async () => {
    expect(await stringParagraphs('const a = "only ascii"\nconst b = `x${1}y`\n', '.ts')).toEqual([])
  })

  it('コメントと文字列の違反を range の順に 1 件ずつ返す', async () => {
    const text = `// ${sentence}\nconst a = '${sentence}'\n`
    expect(await lint(text, '.ts')).toEqual([at(1, 4), at(2, 12)])
  })

  it('文字列の中の // と /* で文字列が切れず、コメントとして数えない', async () => {
    expect(await lint(`const a = 'http://x /* ${sentence}'\n`, '.ts')).toEqual([at(1, 24)])
  })

  it('エスケープした引用符で文字列が終わらない', async () => {
    expect(await lint(`const a = 'it\\'s ${sentence}'\n`, '.ts')).toEqual([at(1, 18)])
  })

  it('BOM 付きでも列がずれない', async () => {
    expect(await lint(`\u{FEFF}const a = '${sentence}'\n`, '.ts')).toEqual([at(1, 12)])
  })

  it('サロゲートペアの後ろでも、列を 1 文字として数えてずれない', async () => {
    expect(await lint(`const a = '\u{1F600}${sentence}'\n`, '.ts')).toEqual([at(1, 13)])
  })

  it('閉じていない文字列は数えず、後ろの文字列は読む', async () => {
    expect(await lint(`const a = 'x\nconst b = "${sentence}"\n`, '.ts')).toEqual([at(2, 12)])
  })

  it('複数行の文字列を行ごとに数える', async () => {
    expect(await lint(`const a = \`${sentence}\n${sentence}\`\n`, '.ts')).toEqual([at(1, 12), at(2, 1)])
  })

  it('CRLF の行末の CR を Str に含めず、2 行目の列を数える', async () => {
    expect(await lint(`const a = '${sentence}'\r\nconst b = '${sentence}'\r\n`, '.ts')).toEqual([at(1, 12), at(2, 12)])
  })

  it('空文字の入力でも Document を返す', async () => {
    expect(await stringParagraphs('', '.ts')).toEqual([])
  })
})

describe('strings plugin: テンプレート文字列の ${}', () => {
  it('${} を挟んで括弧が閉じる文を、割らずに 1 つの文として読む', async () => {
    expect(await lintAll('const a = `${1}の値（${2}）を使います。`\n', '.ts')).toEqual([])
  })

  it('${} の後ろの行にある違反を、元ファイルの行と列で返す', async () => {
    expect(await lint(`const a = \`\${1}\n${sentence}\`\n`, '.ts')).toEqual([at(2, 1)])
  })

  it('${} の中の文字列は、外側とは別に読む', async () => {
    expect(await lint(`const a = \`\${x ? '${sentence}' : ''}\`\n`, '.ts')).toEqual([at(1, 19)])
  })

  it('${} の中が日本語だけのテンプレート文字列は数えない', async () => {
    expect(await stringParagraphs('const a = `${"あ"}`\n', '.ts')).toHaveLength(1)
    expect(await stringParagraphs('const a = `${f()}`\n', '.ts')).toEqual([])
  })

  it('${} を、元ファイルの範囲を持つ Code に、value は X にして Paragraph に入れる', async () => {
    const [paragraph] = await stringParagraphs('const a = `あ${x}い`\n', '.ts')
    expect(paragraph?.children.map(child => [child.type, child.raw, child.range])).toEqual([
      ['Str', 'あ', [11, 12]],
      ['Code', '${x}', [12, 16]],
      ['Str', 'い', [16, 17]],
    ])
    expect(paragraph?.children[1]).toMatchObject({ value: 'X', loc: { start: { line: 1, column: 12 }, end: { line: 1, column: 16 } } })
  })

  it('複数行にまたがる ${} は行を分けず、1 つの Code にする', async () => {
    const [paragraph] = await stringParagraphs('const a = `あ${f(\n  x,\n)}い`\n', '.ts')
    expect(paragraph?.children.map(child => child.type)).toEqual(['Str', 'Code', 'Str'])
    expect(paragraph?.children[1]?.raw).toBe('${f(\n  x,\n)}')
  })

  it('${} から始まり、${} で終わる行も読む', async () => {
    const [paragraph] = await stringParagraphs('const a = `${x}あ${y}`\n', '.ts')
    expect(paragraph?.children.map(child => child.type)).toEqual(['Code', 'Str', 'Code'])
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
  ])('%s で段落を分け、sentence-length を出さない', async (_name, text) => {
    expect(await lint(text, '.ts', rule)).toEqual([])
  })

  it('エスケープした \\ に続く n は改行にせず、1 つの文として数える', async () => {
    expect(await lint(`const a = '${long}\\\\n\\\\n${long}'\n`, '.ts', rule)).toHaveLength(1)
  })

  it('エスケープの \\n を Break にして、Str と Break の位置を原文のまま保つ', async () => {
    const [paragraph] = await stringParagraphs(String.raw`const a = 'あ\nい'` + '\n', '.ts')
    expect(paragraph?.children.map(child => [child.type, child.raw, child.range])).toEqual([
      ['Str', 'あ', [11, 12]],
      ['Break', String.raw`\n`, [12, 14]],
      ['Str', 'い', [14, 15]],
    ])
  })

  it('エスケープの \\t も字下げの幅 4 として数え、字下げ 4 以上のコードを外す', async () => {
    const paragraphs = await stringParagraphs(String.raw`const a = '\n\tあ\n\n\t\t\tい'` + '\n', '.ts')
    expect(paragraphs.map(paragraph => paragraph.raw)).toEqual(['あ'])
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

  it('ファイル内の別々の文字列で調が揃わなければ違反にする（仕様）', async () => {
    expect(await mixHits(`これは試験${dearu}`, `これは試験${desu}`)).toHaveLength(1)
  })

  it('調が揃っていれば違反にしない', async () => {
    expect(await mixHits(`これは試験${desu}`, `これも試験${desu}`)).toEqual([])
  })
})

describe('typescriptStrings: 構文の誤りを含むコード', () => {
  // 誤りの部分木に入っても文字列は拾う。構文の誤りそのものは各パッケージの tsc が止めるので、hasError では止めない。
  it('String.raw の不正な unicode エスケープを含んでいても、後ろの文字列の違反を判定する', async () => {
    const text = `const p = String.raw\`C:\\ubuntu\`\nconst b = '${sentence}'\n`
    expect(await lint(text, '.ts')).toEqual([at(2, 12)])
  })

  it('閉じていない文字列の行は判定せず、exit 2 にもしない（意図した制約）', async () => {
    expect(await lint(`const a = '${sentence}\n`, '.ts')).toEqual([])
  })
})

describe('typescriptStrings: 取り出す区間', () => {
  it('型注釈の string キーワードは区間にしない', async () => {
    const text = `let x: string = 'あ'\n`
    expect(await typescriptStrings('typescript')(text)).toMatchObject([{ start: 17, end: 18 }])
  })

  const jsxCases: readonly (readonly [Grammar, string])[] = [
    ['tsx', '.tsx'],
    ['javascript', '.jsx'],
  ]

  it.each(jsxCases)('%s の JSX のテキストを区間にして、違反を元ファイルの行と列で返す', async (grammar, extension) => {
    const text = `const b = <p>${sentence}</p>\n`
    expect(await typescriptStrings(grammar)(text)).toEqual([{ start: 13, end: 13 + sentence.length }])
    expect(await lint(text, extension)).toEqual([at(1, 14)])
  })
})

describe('Processor: TypeScript / JavaScript', () => {
  it('対象の拡張子に TypeScript / JavaScript と .vue を加える', () => {
    expect(new strings.Processor().availableExtensions()).toEqual([
      '.py', '.pyi', '.sh', '.bash', '.json', '.jsonc', '.yaml', '.yml',
      '.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.vue',
    ])
  })
})

import { describe, expect, it } from 'vitest'

import type {
  EvidenceSpecParseResult,
  NormalizedEvidenceSpec,
  SpecValidationError,
} from '../spec-schema.js'
import { parseEvidenceSpec } from '../spec-schema.js'
import { explains } from '../../../../tests/_helpers/explains.js'

function expectSpec(result: EvidenceSpecParseResult): NormalizedEvidenceSpec {
  if (!result.ok) {
    throw new Error(`検証が失敗した: ${JSON.stringify(result.errors)}`)
  }
  return result.spec
}

function expectErrors(result: EvidenceSpecParseResult): readonly SpecValidationError[] {
  if (result.ok) {
    throw new Error('検証が成功してしまった')
  }
  return result.errors
}

function pathsOf(result: EvidenceSpecParseResult): readonly string[] {
  return expectErrors(result).map(error => error.path)
}

/**
最小の有効 spec に `overrides` を重ねて検証する。
*/
function parseWith(overrides: Readonly<Record<string, unknown>>): EvidenceSpecParseResult {
  return parseEvidenceSpec({ ...minimalSpec(), ...overrides })
}

/**
最小の有効 spec。個別テストはここへ差分だけ足す。
*/
function minimalSpec(): Record<string, unknown> {
  return {
    title: 'ログイン機能 動作確認エビデンス',
    createdDate: '2026-08-07',
    items: [{ imagePath: '/abs/path/01-login.png', caption: 'ログイン画面を表示' }],
  }
}

/**
items[0].annotations にだけ差分を入れた spec を検証する。
*/
function withAnnotations(annotations: unknown): EvidenceSpecParseResult {
  return parseWith({
    items: [{ imagePath: '/a.png', annotations }],
  })
}

/**
items[0].annotations[0] を highlight にして box にだけ差分を入れる。
*/
function withBox(box: unknown): EvidenceSpecParseResult {
  return withAnnotations([{ type: 'highlight', box }])
}

describe('parseEvidenceSpec — 受理', () => {
  it('すべてのフィールドを持つ定義は、正規化して返す', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、受理する場合のテストです。`title`、`createdDate`、`extraHeaders`、3 種類の注記を持つ `items` を渡した場合に、検証に成功し、同じ内容の定義を返すことを確認します。')
    const result = parseEvidenceSpec({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-07',
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      items: [
        {
          imagePath: '/abs/path/01-login.png',
          caption: 'ログイン画面を表示',
          annotations: [
            {
              type: 'callout',
              text: 'ここをクリック',
              box: { x: 0.55, y: 0.1, w: 0.3, h: 0.12 },
              anchor: { x: 0.48, y: 0.31 },
            },
            { type: 'highlight', box: { x: 0.4, y: 0.25, w: 0.2, h: 0.1 } },
            { type: 'arrow', from: { x: 0.2, y: 0.5 }, to: { x: 0.38, y: 0.3 } },
          ],
        },
      ],
    })

    expect(expectSpec(result)).toStrictEqual({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-07',
      extraHeaders: [{ label: '作成者', value: 'K. Hayakawa' }],
      items: [
        {
          imagePath: '/abs/path/01-login.png',
          caption: 'ログイン画面を表示',
          annotations: [
            {
              type: 'callout',
              text: 'ここをクリック',
              box: { x: 0.55, y: 0.1, w: 0.3, h: 0.12 },
              anchor: { x: 0.48, y: 0.31 },
            },
            { type: 'highlight', box: { x: 0.4, y: 0.25, w: 0.2, h: 0.1 } },
            { type: 'arrow', from: { x: 0.2, y: 0.5 }, to: { x: 0.38, y: 0.3 } },
          ],
        },
      ],
    })
  })

  it('extraHeaders と annotations を省略した場合は、空の配列で補う', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、受理する場合のテストです。`extraHeaders` と `annotations` を省略した定義を渡した場合に、どちらも空の配列を補った定義を返すことを確認します。')
    expect(expectSpec(parseWith({}))).toStrictEqual({
      title: 'ログイン機能 動作確認エビデンス',
      createdDate: '2026-08-07',
      extraHeaders: [],
      items: [
        {
          imagePath: '/abs/path/01-login.png',
          caption: 'ログイン画面を表示',
          annotations: [],
        },
      ],
    })
  })

  it('extraHeaders の value は、空文字を許可する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、受理する場合のテストです。`extraHeaders` の `value` が空文字の定義を渡した場合に、検証に成功し、空文字をそのまま返すことを確認します。')
    const result = parseWith({
      extraHeaders: [{ label: '環境', value: '' }],
    })

    expect(expectSpec(result).extraHeaders).toStrictEqual([{ label: '環境', value: '' }])
  })

  it('複数の extraHeaders は、宣言した順のまま保持する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、受理する場合のテストです。2 件の `extraHeaders` を渡した場合に、ラベルの五十音順などに並べ替えず、宣言した順のまま返すことを確認します。')
    // 宣言順がそのままヘッダー行の並び順になる (label の五十音順等へ並べ替えない)。
    const result = parseWith({
      extraHeaders: [
        { label: '環境', value: 'staging' },
        { label: '作成者', value: 'K. Hayakawa' },
      ],
    })

    expect(expectSpec(result).extraHeaders).toStrictEqual([
      { label: '環境', value: 'staging' },
      { label: '作成者', value: 'K. Hayakawa' },
    ])
  })

  it('相対座標が境界の 0 と 1 の場合も、受理する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、受理する場合のテストです。`box` の `x` と `y` が 0 で、`w` と `h` が 1 の `highlight` を渡した場合に、検証に成功することを確認します。')
    const result = parseWith({
      items: [{
        imagePath: '/a.png',
        annotations: [{ type: 'highlight', box: { x: 0, y: 0, w: 1, h: 1 } }],
      }],
    })

    expect(expectSpec(result).items[0]?.annotations).toStrictEqual([
      { type: 'highlight', box: { x: 0, y: 0, w: 1, h: 1 } },
    ])
  })

  it('複数の item の順序を保持し、caption の指定と補完を item ごとに独立して扱う', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、受理する場合のテストです。`caption` を省略した item と指定した item が混在する場合に、順序を保ち、省略した item にだけファイル名から補った `caption` を入れることを確認します。')
    // SC-002: items 配列順 = 通し番号 = シート上の縦並び順。
    // 並べ替えや、ある item の caption 明示が他 item の補完へ波及しないことを見る。
    const result = parseWith({
      items: [
        { imagePath: '/work/03-logout.png' },
        { imagePath: '/work/01-login.png', caption: '手順 2: ログイン' },
        { imagePath: '/work/02-submit.jpeg', annotations: [] },
      ],
    })

    expect(expectSpec(result).items).toStrictEqual([
      { imagePath: '/work/03-logout.png', caption: '03-logout', annotations: [] },
      { imagePath: '/work/01-login.png', caption: '手順 2: ログイン', annotations: [] },
      { imagePath: '/work/02-submit.jpeg', caption: '02-submit', annotations: [] },
    ])
  })

  it('x と w の合計がちょうど 1 の box は、受理する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、受理する場合のテストです。`x` と `w` の合計が 1.0 になる `box` を渡した場合に、範囲内として検証に成功することを確認します。')
    const result = parseWith({
      items: [{
        imagePath: '/a.png',
        annotations: [{ type: 'highlight', box: { x: 0.4, y: 0.4, w: 0.6, h: 0.6 } }],
      }],
    })

    expect(expectSpec(result).items[0]?.annotations).toHaveLength(1)
  })
})

describe('parseEvidenceSpec — caption 補完 (FR-004)', () => {
  it.each([
    ['日本語ファイル名', '/work/エビデンス/ログイン画面.png', 'ログイン画面'],
    ['複数ドット', '/work/01.login.step.jpeg', '01.login.step'],
    ['拡張子なし', '/work/screenshot', 'screenshot'],
    ['ドット始まりで拡張子なし', '/work/.hidden', '.hidden'],
    ['相対パス', 'shots/02-submit.PNG', '02-submit'],
  ])('caption を補う場合は、%s（%s）のとき、caption が %s になる', async (_label, imagePath, expected) => {
    await explains(`エビデンスの定義（spec）を検証する \`parseEvidenceSpec\` の、\`caption\` を補う場合のテストです。\`imagePath\` が \`${imagePath}\` で \`caption\` を省略した場合に、拡張子を除いた \`${expected}\` を補うことを確認します。`)
    const result = parseWith({ items: [{ imagePath }] })

    expect(expectSpec(result).items[0]?.caption).toBe(expected)
  })

  it('指定された caption は、空文字でも、そのまま保持する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`caption` を補う場合のテストです。`caption` に空文字を指定した item を渡した場合に、ファイル名で補わず、空文字のままにすることを確認します。')
    const result = parseWith({
      items: [{ imagePath: '/work/a.png', caption: '' }],
    })

    expect(expectSpec(result).items[0]?.caption).toBe('')
  })
})

describe('parseEvidenceSpec — 補う前の spec (written)', () => {
  it('caption を省略した項目は、補う前の定義に caption を持たず、指定した caption は空文字でも保持する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、補う前の定義 `written` のテストです。`caption` を省略した item と空文字の item を渡した場合に、`written` では省略した item だけが `caption` を持たず、`spec` には補った値が入ることを確認します。')
    const result = parseWith({
      items: [{ imagePath: '/work/a.png' }, { imagePath: '/work/b.png', caption: '' }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('受理されるはず')
    expect(result.written.items).toStrictEqual([
      { imagePath: '/work/a.png', annotations: [] },
      { imagePath: '/work/b.png', caption: '', annotations: [] },
    ])
    expect(result.spec.items.map(item => item.caption)).toStrictEqual(['a', ''])
  })
})

describe('parseEvidenceSpec — ルートの検証', () => {
  it.each([
    ['配列', []],
    ['文字列', 'spec'],
    ['数値', 1],
    ['undefined', undefined],
  ])('ルートが %s の場合は、ルートのエラーになる', async (_label, value) => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、ルートの検証のテストです。ルートが配列、文字列、数値、`undefined` のようにオブジェクトでない値の場合に、パスが空文字のエラーになることを確認します。')
    expect(pathsOf(parseEvidenceSpec(value))).toStrictEqual([''])
  })

  it('ルートが null の場合は、ルートのエラーになる', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、ルートの検証のテストです。`null` を渡した場合に、パスが空文字のエラーになることを確認します。')
    // eslint-disable-next-line unicorn/no-null -- JSON.parse が実際に返し得る値なので、入力として null そのものを渡して検証する
    expect(pathsOf(parseEvidenceSpec(null))).toStrictEqual([''])
  })

  it('未知のトップレベルのキーは、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、ルートの検証のテストです。定義に `footer` のような未知のキーがある場合に、`unknown key` のエラーとして、そのキーのパスを返すことを確認します。')
    const result = parseWith({ footer: 'x' })

    expect(expectErrors(result)).toStrictEqual([{ path: 'footer', message: 'unknown key' }])
  })

  it('最初のエラーで打ち切らず、すべてのエラーを返す', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、ルートの検証のテストです。`title` が空、`createdDate` が不正、`items` が空の定義を渡した場合に、3 つのパスのエラーをすべて返すことを確認します。')
    const result = parseEvidenceSpec({ title: '', createdDate: '2026/08/07', items: [] })

    expect(pathsOf(result)).toStrictEqual(['title', 'createdDate', 'items'])
  })

  it('title がない場合は、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、ルートの検証のテストです。`title` を持たない定義を渡した場合に、`title` のエラーだけを返すことを確認します。')
    const { createdDate, items } = minimalSpec()

    expect(pathsOf(parseEvidenceSpec({ createdDate, items }))).toStrictEqual(['title'])
  })

  it.each([
    ['title が空文字', ''],
    ['title が数値', 3],
  ])('%s の場合は、拒否する', async (_label, title) => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、ルートの検証のテストです。`title` が空文字や数値の場合に、`title` のエラーだけを返すことを確認します。')
    expect(pathsOf(parseWith({ title }))).toStrictEqual(['title'])
  })
})

describe('parseEvidenceSpec — createdDate', () => {
  it.each([
    ['2026-08-07'],
    ['2028-02-29'],
    ['2026-12-31'],
  ])('createdDate が %s の場合は、受理する', async (createdDate) => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`createdDate` の検証のテストです。`2026-08-07` のような正しい日付や、閏日の `2028-02-29` を渡した場合に、検証に成功し、同じ値を返すことを確認します。')
    expect(expectSpec(parseWith({ createdDate })).createdDate)
      .toBe(createdDate)
  })

  it.each([
    ['スラッシュ区切り', '2026/08/07'],
    ['桁数不足', '2026-8-7'],
    ['末尾に時刻', '2026-08-07T00:00:00Z'],
    ['空文字', ''],
    ['暦にない日 (2 月 31 日)', '2026-02-31'],
    ['暦にない月', '2026-13-01'],
    ['閏日でない年の 2 月 29 日', '2026-02-29'],
    ['0 日', '2026-08-00'],
  ])('createdDate が不正な値（%s）の場合は、拒否する', async (_label, createdDate) => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`createdDate` の検証のテストです。スラッシュ区切りや、暦にない日付など、`YYYY-MM-DD` の正しい日付ではない値を渡した場合に、`createdDate` のエラーを返すことを確認します。')
    expect(pathsOf(parseWith({ createdDate })))
      .toStrictEqual(['createdDate'])
  })

  it('createdDate が数値の場合は、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`createdDate` の検証のテストです。数値の `createdDate` を渡した場合に、`createdDate` のエラーを返すことを確認します。')
    expect(pathsOf(parseWith({ createdDate: 20_260_807 })))
      .toStrictEqual(['createdDate'])
  })
})

describe('parseEvidenceSpec — items', () => {
  it.each([
    ['非配列', 'items'],
    ['object', {}],
  ])('items が %s の場合は、型が一致しないものとして拒否する', async (_label, items) => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`items` の検証のテストです。`items` が文字列やオブジェクトの場合に、`must be an array` のエラーを返すことを確認します。')
    expect(expectErrors(parseWith({ items })))
      .toStrictEqual([{ path: 'items', message: 'must be an array' }])
  })

  it('items がない場合は、型の不一致とは別の、欠落を示すメッセージで拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`items` の検証のテストです。`items` を持たない定義を渡した場合に、`is required` のエラーを返すことを確認します。')
    const { title, createdDate } = minimalSpec()

    expect(expectErrors(parseEvidenceSpec({ title, createdDate })))
      .toStrictEqual([{ path: 'items', message: 'is required' }])
  })

  it('items が空の配列の場合は、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`items` の検証のテストです。`items` が空の配列の場合に、`must have at least one item` のエラーを返すことを確認します。')
    const result = parseWith({ items: [] })

    expect(expectErrors(result)).toStrictEqual([{ path: 'items', message: 'must have at least one item' }])
  })

  it('item がオブジェクトでない場合は、その item のパスで拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`items` の検証のテストです。`items` の要素が文字列の場合に、`items[0]` のパスのエラーを返すことを確認します。')
    expect(pathsOf(parseWith({ items: ['/a.png'] })))
      .toStrictEqual(['items[0]'])
  })

  it.each([
    ['imagePath 欠落', {}],
    ['imagePath が空文字', { imagePath: '' }],
    ['imagePath が数値', { imagePath: 1 }],
  ])('%s の場合は、items[0].imagePath のエラーとして拒否する', async (_label, item) => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`items` の検証のテストです。`imagePath` がない場合、空文字の場合、数値の場合に、`items[0].imagePath` のエラーを返すことを確認します。')
    expect(pathsOf(parseWith({ items: [item] })))
      .toStrictEqual(['items[0].imagePath'])
  })

  it('caption が文字列でない場合は、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`items` の検証のテストです。`caption` が数値の item を渡した場合に、`items[0].caption` のエラーを返すことを確認します。')
    expect(pathsOf(parseWith({
      items: [{ imagePath: '/a.png', caption: 42 }],
    }))).toStrictEqual(['items[0].caption'])
  })

  it('item の未知のキーは、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`items` の検証のテストです。item に `order` のような未知のキーがある場合に、`items[0].order` のエラーを返すことを確認します。')
    expect(pathsOf(parseWith({
      items: [{ imagePath: '/a.png', order: 2 }],
    }))).toStrictEqual(['items[0].order'])
  })

  it('複数の item のエラーを、添字付きのパスで、すべて返す', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`items` の検証のテストです。3 件の item のうち 2 件が不正な場合に、`items[0].imagePath` と `items[2].imagePath` の 2 件のエラーを返すことを確認します。')
    const result = parseWith({
      items: [{ imagePath: '' }, { imagePath: '/b.png' }, { imagePath: 3 }],
    })

    expect(pathsOf(result)).toStrictEqual(['items[0].imagePath', 'items[2].imagePath'])
  })
})

describe('parseEvidenceSpec — extraHeaders', () => {
  it('extraHeaders が配列でない場合は、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`extraHeaders` の検証のテストです。`extraHeaders` がオブジェクトの場合に、`extraHeaders` のエラーを返すことを確認します。')
    expect(pathsOf(parseWith({ extraHeaders: { label: 'a' } })))
      .toStrictEqual(['extraHeaders'])
  })

  it('extraHeaders の要素がオブジェクトでない場合は、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`extraHeaders` の検証のテストです。`extraHeaders` の要素が文字列の場合に、`extraHeaders[0]` のエラーを返すことを確認します。')
    expect(pathsOf(parseWith({ extraHeaders: ['作成者'] })))
      .toStrictEqual(['extraHeaders[0]'])
  })

  it.each([
    ['label 欠落', { value: 'x' }, 'extraHeaders[0].label'],
    ['label が空文字', { label: '', value: 'x' }, 'extraHeaders[0].label'],
    ['value 欠落', { label: '作成者' }, 'extraHeaders[0].value'],
    ['value が数値', { label: '作成者', value: 1 }, 'extraHeaders[0].value'],
    ['未知キー', { label: '作成者', value: 'x', bold: true }, 'extraHeaders[0].bold'],
  ])('extraHeaders で %s の場合は、拒否する', async (_label, field, expectedPath) => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`extraHeaders` の検証のテストです。`label` や `value` がない場合、型が不正な場合、未知のキーがある場合に、該当するキーのパスのエラーを返すことを確認します。')
    expect(pathsOf(parseWith({ extraHeaders: [field] })))
      .toStrictEqual([expectedPath])
  })
})

describe('parseEvidenceSpec — annotations', () => {
  it('annotations が配列でない場合は、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`annotations` の検証のテストです。`annotations` がオブジェクトの場合に、`items[0].annotations` のエラーを返すことを確認します。')
    expect(pathsOf(withAnnotations({ type: 'arrow' })))
      .toStrictEqual(['items[0].annotations'])
  })

  it('annotations の要素がオブジェクトでない場合は、拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`annotations` の検証のテストです。`annotations` の要素が文字列の場合に、`items[0].annotations[0]` のエラーを返すことを確認します。')
    expect(pathsOf(withAnnotations(['callout']))).toStrictEqual(['items[0].annotations[0]'])
  })

  it.each([
    ['type 欠落', {}],
    ['type が数値', { type: 1 }],
  ])('注記で %s の場合は、拒否する', async (_label, annotation) => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`annotations` の検証のテストです。注記の `type` がない場合と、数値の場合に、`items[0].annotations[0].type` のエラーを返すことを確認します。')
    expect(pathsOf(withAnnotations([annotation])))
      .toStrictEqual(['items[0].annotations[0].type'])
  })

  it('未知の type は、その値を含むメッセージで拒否する', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`annotations` の検証のテストです。`type` が `underline` の注記を渡した場合に、`unknown annotation type: underline` のエラーを返すことを確認します。')
    const result = withAnnotations([{ type: 'underline', box: { x: 0, y: 0, w: 1, h: 1 } }])

    expect(expectErrors(result)).toStrictEqual([{
      path: 'items[0].annotations[0].type',
      message: 'unknown annotation type: underline',
    }])
  })

  it('エラーのパスに、注記の添字を含める', async () => {
    await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`annotations` の検証のテストです。2 番目の注記の `box.x` が範囲外の場合に、`items[0].annotations[1].box.x` のパスと、範囲外の値を示すメッセージのエラーを返すことを確認します。')
    const result = withAnnotations([
      { type: 'highlight', box: { x: 0.4, y: 0.25, w: 0.2, h: 0.1 } },
      {
        type: 'callout',
        text: 'ここ',
        box: { x: 1.5, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: 0.1 },
      },
    ])

    expect(expectErrors(result)).toStrictEqual([{
      path: 'items[0].annotations[1].box.x',
      message: 'out of range 0.0-1.0: 1.5',
    }])
  })

  describe('callout', () => {
    it('callout の text が空文字の場合は、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`callout` の検証のテストです。`text` が空文字の `callout` を渡した場合に、`items[0].annotations[0].text` のエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{
        type: 'callout',
        text: '',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: 0.1 },
      }]))).toStrictEqual(['items[0].annotations[0].text'])
    })

    it.each([
      ['LF', 'ログイン\nボタン'],
      ['CR', 'ログイン\rボタン'],
    ])('callout の text に改行（%s）が含まれる場合は、拒否する', async (_label, text) => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`callout` の検証のテストです。`text` に改行（LF または CR）が含まれる場合に、`callout text must not contain a line break` のエラーを返すことを確認します。')
      const result = withAnnotations([{
        type: 'callout',
        text,
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: 0.1 },
      }])

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].text',
        message: 'callout text must not contain a line break',
      }])
    })

    // 拒否するのは改行だけ。タブが a:t に生で出ることは ooxml.test.ts 側で pin する。
    it('callout の text にタブが含まれる場合は、受理する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`callout` の検証のテストです。`text` にタブを含む `callout` を渡した場合に、改行とは異なり、検証に成功することを確認します。')
      const result = withAnnotations([{
        type: 'callout',
        text: 'ログイン\tボタン',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: 0.1 },
      }])

      expect(result.ok).toBe(true)
    })

    it('callout の box と anchor がない場合は、両方のエラーをまとめて返す', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`callout` の検証のテストです。`box` と `anchor` がない `callout` を渡した場合に、`box` と `anchor` の 2 件のエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{ type: 'callout', text: 'ここ' }]))).toStrictEqual([
        'items[0].annotations[0].box',
        'items[0].annotations[0].anchor',
      ])
    })

    it('callout の anchor の座標が範囲外の場合は、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`callout` の検証のテストです。`anchor` の `y` が負の値の場合に、`items[0].annotations[0].anchor.y` のエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{
        type: 'callout',
        text: 'ここ',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: -0.01 },
      }]))).toStrictEqual(['items[0].annotations[0].anchor.y'])
    })

    it('callout の未知のキーは、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`callout` の検証のテストです。`callout` に `color` のような未知のキーがある場合に、そのキーのパスのエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{
        type: 'callout',
        text: 'ここ',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: 0.1 },
        color: 'red',
      }]))).toStrictEqual(['items[0].annotations[0].color'])
    })
  })

  describe('highlight', () => {
    it('highlight の w が 0 の場合は、box.w のパスで拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`highlight` の検証のテストです。`w` が 0 の `highlight` を渡した場合に、`box.w` のパスで、0 より大きい値が必要であることを示すエラーを返すことを確認します。')
      const result = withBox({ x: 0.1, y: 0.1, w: 0, h: 0.2 })

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].box.w',
        message: 'highlight box w must be > 0: 0',
      }])
    })

    it('highlight の h が 0 の場合は、box.h のパスで拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`highlight` の検証のテストです。`h` が 0 の `highlight` を渡した場合に、`box.h` のパスで、0 より大きい値が必要であることを示すエラーを返すことを確認します。')
      const result = withBox({ x: 0.1, y: 0.1, w: 0.2, h: 0 })

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].box.h',
        message: 'highlight box h must be > 0: 0',
      }])
    })

    it('highlight の w と h がどちらも 0 の場合は、2 件のエラーをまとめて返す', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`highlight` の検証のテストです。`w` と `h` がどちらも 0 の `highlight` を渡した場合に、`box.w` と `box.h` の 2 件のエラーを返すことを確認します。')
      expect(pathsOf(withBox({ x: 0.1, y: 0.1, w: 0, h: 0 }))).toStrictEqual([
        'items[0].annotations[0].box.w',
        'items[0].annotations[0].box.h',
      ])
    })

    it('highlight の未知のキーは、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`highlight` の検証のテストです。`highlight` に `text` のような未知のキーがある場合に、そのキーのパスのエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{
        type: 'highlight',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        text: 'ここ',
      }]))).toStrictEqual(['items[0].annotations[0].text'])
    })
  })

  describe('arrow', () => {
    it('arrow の from と to が同じ座標の場合は、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`arrow` の検証のテストです。始点と終点が同じ座標の `arrow` を渡した場合に、`arrow from and to must not be the same point` のエラーを返すことを確認します。')
      const result = withAnnotations([{
        type: 'arrow',
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.2, y: 0.5 },
      }])

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0]',
        message: 'arrow from and to must not be the same point',
      }])
    })

    it('arrow の from と to の x だけが異なる場合は、受理する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`arrow` の検証のテストです。始点と終点で `x` だけが異なる `arrow` を渡した場合に、検証に成功することを確認します。')
      const result = withAnnotations([{
        type: 'arrow',
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.21, y: 0.5 },
      }])

      expect(expectSpec(result).items[0]?.annotations).toHaveLength(1)
    })

    it('arrow の to がない場合は、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`arrow` の検証のテストです。`to` がない `arrow` を渡した場合に、`items[0].annotations[0].to` のエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{ type: 'arrow', from: { x: 0.2, y: 0.5 } }])))
        .toStrictEqual(['items[0].annotations[0].to'])
    })

    it('arrow の未知のキーは、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、`arrow` の検証のテストです。`arrow` に `width` のような未知のキーがある場合に、そのキーのパスのエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{
        type: 'arrow',
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.3, y: 0.5 },
        width: 2,
      }]))).toStrictEqual(['items[0].annotations[0].width'])
    })
  })

  describe('Point / Rect', () => {
    it('box がオブジェクトでない場合は、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、座標（`Point` と `Rect`）の検証のテストです。`box` が配列の場合に、`items[0].annotations[0].box` のエラーを返すことを確認します。')
      expect(pathsOf(withBox([0, 0, 1, 1]))).toStrictEqual(['items[0].annotations[0].box'])
    })

    it.each([
      ['x 欠落', { y: 0.1, w: 0.2, h: 0.2 }, 'items[0].annotations[0].box.x'],
      ['y が文字列', { x: 0.1, y: '0.1', w: 0.2, h: 0.2 }, 'items[0].annotations[0].box.y'],
      ['w が NaN', { x: 0.1, y: 0.1, w: NaN, h: 0.2 }, 'items[0].annotations[0].box.w'],
      ['h が Infinity', {
        x: 0.1, y: 0.1, w: 0.2, h: Infinity,
      }, 'items[0].annotations[0].box.h'],
      ['x が負', { x: -0.1, y: 0.1, w: 0.2, h: 0.2 }, 'items[0].annotations[0].box.x'],
      ['y が 1 超', { x: 0.1, y: 1.1, w: 0.2, h: 0.2 }, 'items[0].annotations[0].box.y'],
    ])('box で %s の場合は、拒否する', async (_label, box, expectedPath) => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、座標（`Point` と `Rect`）の検証のテストです。`box` の値がない場合、文字列や `NaN` や `Infinity` の場合、範囲外の場合に、該当するキーのパスのエラーを返すことを確認します。')
      expect(pathsOf(withBox(box))).toStrictEqual([expectedPath])
    })

    it('box の未知のキーは、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、座標（`Point` と `Rect`）の検証のテストです。`box` に `r` のような未知のキーがある場合に、`items[0].annotations[0].box.r` のエラーを返すことを確認します。')
      expect(pathsOf(withBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.2, r: 4 })))
        .toStrictEqual(['items[0].annotations[0].box.r'])
    })

    it('x と w の合計が 1 を超える box は、w のパスで拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、座標（`Point` と `Rect`）の検証のテストです。`x` が 0.9 で `w` が 0.2 の `box` を渡した場合に、`box.w` のパスで、`x + w exceeds 1` のエラーを返すことを確認します。')
      const result = withBox({ x: 0.9, y: 0.1, w: 0.2, h: 0.2 })

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].box.w',
        message: 'x + w exceeds 1 (x: 0.9, w: 0.2)',
      }])
    })

    it('y と h の合計が 1 を超える box は、h のパスで拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、座標（`Point` と `Rect`）の検証のテストです。`y` が 0.9 で `h` が 0.2 の `box` を渡した場合に、`box.h` のパスで、`y + h exceeds 1` のエラーを返すことを確認します。')
      const result = withBox({ x: 0.1, y: 0.9, w: 0.2, h: 0.2 })

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].box.h',
        message: 'y + h exceeds 1 (y: 0.9, h: 0.2)',
      }])
    })

    it('縦と横の両方がはみ出す box は、2 件のエラーをまとめて返す', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、座標（`Point` と `Rect`）の検証のテストです。`x + w` と `y + h` がどちらも 1 を超える `box` を渡した場合に、`box.w` と `box.h` の 2 件のエラーを返すことを確認します。')
      expect(pathsOf(withBox({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }))).toStrictEqual([
        'items[0].annotations[0].box.w',
        'items[0].annotations[0].box.h',
      ])
    })

    it('anchor がオブジェクトでない場合は、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、座標（`Point` と `Rect`）の検証のテストです。`anchor` が数値の `callout` を渡した場合に、`items[0].annotations[0].anchor` のエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{
        type: 'callout',
        text: 'ここ',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: 0.1,
      }]))).toStrictEqual(['items[0].annotations[0].anchor'])
    })

    it('Point の未知のキーは、拒否する', async () => {
      await explains('エビデンスの定義（spec）を検証する `parseEvidenceSpec` の、座標（`Point` と `Rect`）の検証のテストです。`arrow` の `from` に `z` のような未知のキーがある場合に、`items[0].annotations[0].from.z` のエラーを返すことを確認します。')
      expect(pathsOf(withAnnotations([{
        type: 'arrow',
        from: { x: 0.2, y: 0.5, z: 0 },
        to: { x: 0.3, y: 0.5 },
      }]))).toStrictEqual(['items[0].annotations[0].from.z'])
    })
  })
})

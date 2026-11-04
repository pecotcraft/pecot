import { describe, expect, it } from 'vitest'

import type {
  EvidenceSpecParseResult,
  NormalizedEvidenceSpec,
  SpecValidationError,
} from '../spec-schema.js'
import { parseEvidenceSpec } from '../spec-schema.js'

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
  it('contracts §2 の全フィールドを揃えた spec を正規化して返す', () => {
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

  it('extraHeaders / annotations を省略すると空配列で埋める', () => {
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

  it('extraHeaders の value は空文字を許す', () => {
    const result = parseWith({
      extraHeaders: [{ label: '環境', value: '' }],
    })

    expect(expectSpec(result).extraHeaders).toStrictEqual([{ label: '環境', value: '' }])
  })

  it('複数の extraHeaders を宣言順のまま保存する', () => {
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

  it('0 と 1 を含む境界の相対座標を受理する', () => {
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

  it('複数 item の配列順を保存し、caption の明示と補完を item 別に独立して扱う', () => {
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

  it('x + w がちょうど 1.0 の Rect を受理する (等号を含む契約)', () => {
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
  ])('%s: %s -> %s', (_label, imagePath, expected) => {
    const result = parseWith({ items: [{ imagePath }] })

    expect(expectSpec(result).items[0]?.caption).toBe(expected)
  })

  it('明示された caption は空文字でもそのまま保つ', () => {
    const result = parseWith({
      items: [{ imagePath: '/work/a.png', caption: '' }],
    })

    expect(expectSpec(result).items[0]?.caption).toBe('')
  })
})

describe('parseEvidenceSpec — 補う前の spec (written)', () => {
  it('caption を省略した項目は caption を持たず、明示した caption は空文字でも保つ', () => {
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
  ])('%s はルートエラーになる', (_label, value) => {
    expect(pathsOf(parseEvidenceSpec(value))).toStrictEqual([''])
  })

  it('null はルートエラーになる', () => {
    // eslint-disable-next-line unicorn/no-null -- JSON.parse が実際に返し得る値なので、入力として null そのものを渡して検証する
    expect(pathsOf(parseEvidenceSpec(null))).toStrictEqual([''])
  })

  it('未知のトップレベルキーを拒否する', () => {
    const result = parseWith({ footer: 'x' })

    expect(expectErrors(result)).toStrictEqual([{ path: 'footer', message: '未知のキーです' }])
  })

  it('エラーを最初の 1 件で打ち切らず全件返す', () => {
    const result = parseEvidenceSpec({ title: '', createdDate: '2026/08/07', items: [] })

    expect(pathsOf(result)).toStrictEqual(['title', 'createdDate', 'items'])
  })

  it('title 欠落を拒否する', () => {
    const { createdDate, items } = minimalSpec()

    expect(pathsOf(parseEvidenceSpec({ createdDate, items }))).toStrictEqual(['title'])
  })

  it.each([
    ['title が空文字', ''],
    ['title が数値', 3],
  ])('%s なら拒否する', (_label, title) => {
    expect(pathsOf(parseWith({ title }))).toStrictEqual(['title'])
  })
})

describe('parseEvidenceSpec — createdDate', () => {
  it.each([
    ['2026-08-07'],
    ['2028-02-29'],
    ['2026-12-31'],
  ])('%s を受理する', (createdDate) => {
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
  ])('%s を拒否する', (_label, createdDate) => {
    expect(pathsOf(parseWith({ createdDate })))
      .toStrictEqual(['createdDate'])
  })

  it('数値の createdDate を拒否する', () => {
    expect(pathsOf(parseWith({ createdDate: 20_260_807 })))
      .toStrictEqual(['createdDate'])
  })
})

describe('parseEvidenceSpec — items', () => {
  it.each([
    ['非配列', 'items'],
    ['object', {}],
  ])('items が %s なら型不一致として拒否する', (_label, items) => {
    expect(expectErrors(parseWith({ items })))
      .toStrictEqual([{ path: 'items', message: '配列である必要があります' }])
  })

  it('items 欠落は型不一致と区別した欠落専用メッセージで拒否する', () => {
    const { title, createdDate } = minimalSpec()

    expect(expectErrors(parseEvidenceSpec({ title, createdDate })))
      .toStrictEqual([{ path: 'items', message: '必須です' }])
  })

  it('items が空配列なら拒否する', () => {
    const result = parseWith({ items: [] })

    expect(expectErrors(result)).toStrictEqual([{ path: 'items', message: '1 件以上必要です' }])
  })

  it('item が object でなければ item のパスで拒否する', () => {
    expect(pathsOf(parseWith({ items: ['/a.png'] })))
      .toStrictEqual(['items[0]'])
  })

  it.each([
    ['imagePath 欠落', {}],
    ['imagePath が空文字', { imagePath: '' }],
    ['imagePath が数値', { imagePath: 1 }],
  ])('%s を items[0].imagePath として拒否する', (_label, item) => {
    expect(pathsOf(parseWith({ items: [item] })))
      .toStrictEqual(['items[0].imagePath'])
  })

  it('caption が文字列でなければ拒否する', () => {
    expect(pathsOf(parseWith({
      items: [{ imagePath: '/a.png', caption: 42 }],
    }))).toStrictEqual(['items[0].caption'])
  })

  it('item の未知キーを拒否する', () => {
    expect(pathsOf(parseWith({
      items: [{ imagePath: '/a.png', order: 2 }],
    }))).toStrictEqual(['items[0].order'])
  })

  it('複数 item のエラーを添字付きで全件返す', () => {
    const result = parseWith({
      items: [{ imagePath: '' }, { imagePath: '/b.png' }, { imagePath: 3 }],
    })

    expect(pathsOf(result)).toStrictEqual(['items[0].imagePath', 'items[2].imagePath'])
  })
})

describe('parseEvidenceSpec — extraHeaders', () => {
  it('配列でなければ拒否する', () => {
    expect(pathsOf(parseWith({ extraHeaders: { label: 'a' } })))
      .toStrictEqual(['extraHeaders'])
  })

  it('要素が object でなければ拒否する', () => {
    expect(pathsOf(parseWith({ extraHeaders: ['作成者'] })))
      .toStrictEqual(['extraHeaders[0]'])
  })

  it.each([
    ['label 欠落', { value: 'x' }, 'extraHeaders[0].label'],
    ['label が空文字', { label: '', value: 'x' }, 'extraHeaders[0].label'],
    ['value 欠落', { label: '作成者' }, 'extraHeaders[0].value'],
    ['value が数値', { label: '作成者', value: 1 }, 'extraHeaders[0].value'],
    ['未知キー', { label: '作成者', value: 'x', bold: true }, 'extraHeaders[0].bold'],
  ])('%s を拒否する', (_label, field, expectedPath) => {
    expect(pathsOf(parseWith({ extraHeaders: [field] })))
      .toStrictEqual([expectedPath])
  })
})

describe('parseEvidenceSpec — annotations', () => {
  it('配列でなければ拒否する', () => {
    expect(pathsOf(withAnnotations({ type: 'arrow' })))
      .toStrictEqual(['items[0].annotations'])
  })

  it('要素が object でなければ拒否する', () => {
    expect(pathsOf(withAnnotations(['callout']))).toStrictEqual(['items[0].annotations[0]'])
  })

  it.each([
    ['type 欠落', {}],
    ['type が数値', { type: 1 }],
  ])('%s を拒否する', (_label, annotation) => {
    expect(pathsOf(withAnnotations([annotation])))
      .toStrictEqual(['items[0].annotations[0].type'])
  })

  it('未知の type を値付きで拒否する', () => {
    const result = withAnnotations([{ type: 'underline', box: { x: 0, y: 0, w: 1, h: 1 } }])

    expect(expectErrors(result)).toStrictEqual([{
      path: 'items[0].annotations[0].type',
      message: '未知の注記種別です (値: underline)',
    }])
  })

  it('注記の添字を含むパスを返す (contracts §2 の例示形式)', () => {
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
      message: '0.0–1.0 の範囲外です (値: 1.5)',
    }])
  })

  describe('callout', () => {
    it('text が空文字なら拒否する', () => {
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
    ])('text の改行 (%s) を拒否する', (_label, text) => {
      const result = withAnnotations([{
        type: 'callout',
        text,
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: 0.1 },
      }])

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].text',
        message: 'callout の text に改行は含められません',
      }])
    })

    // 拒否するのは改行だけ。タブが a:t に生で出ることは ooxml.test.ts 側で pin する。
    it('タブを含む text は受理する', () => {
      const result = withAnnotations([{
        type: 'callout',
        text: 'ログイン\tボタン',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: 0.1 },
      }])

      expect(result.ok).toBe(true)
    })

    it('box / anchor の欠落を両方まとめて返す', () => {
      expect(pathsOf(withAnnotations([{ type: 'callout', text: 'ここ' }]))).toStrictEqual([
        'items[0].annotations[0].box',
        'items[0].annotations[0].anchor',
      ])
    })

    it('anchor の範囲外座標を拒否する', () => {
      expect(pathsOf(withAnnotations([{
        type: 'callout',
        text: 'ここ',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: { x: 0.1, y: -0.01 },
      }]))).toStrictEqual(['items[0].annotations[0].anchor.y'])
    })

    it('未知キーを拒否する', () => {
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
    it('w が 0 なら box.w のパスで拒否する', () => {
      const result = withBox({ x: 0.1, y: 0.1, w: 0, h: 0.2 })

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].box.w',
        message: 'highlight の box は w > 0 である必要があります (値: 0)',
      }])
    })

    it('h が 0 なら box.h のパスで拒否する', () => {
      const result = withBox({ x: 0.1, y: 0.1, w: 0.2, h: 0 })

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].box.h',
        message: 'highlight の box は h > 0 である必要があります (値: 0)',
      }])
    })

    it('w と h が両方 0 なら 2 件まとめて返す', () => {
      expect(pathsOf(withBox({ x: 0.1, y: 0.1, w: 0, h: 0 }))).toStrictEqual([
        'items[0].annotations[0].box.w',
        'items[0].annotations[0].box.h',
      ])
    })

    it('未知キーを拒否する', () => {
      expect(pathsOf(withAnnotations([{
        type: 'highlight',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        text: 'ここ',
      }]))).toStrictEqual(['items[0].annotations[0].text'])
    })
  })

  describe('arrow', () => {
    it('from と to が同一座標なら拒否する', () => {
      const result = withAnnotations([{
        type: 'arrow',
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.2, y: 0.5 },
      }])

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0]',
        message: 'arrow の from と to が同一座標です',
      }])
    })

    it('x だけ違えば受理する', () => {
      const result = withAnnotations([{
        type: 'arrow',
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.21, y: 0.5 },
      }])

      expect(expectSpec(result).items[0]?.annotations).toHaveLength(1)
    })

    it('to の欠落を拒否する', () => {
      expect(pathsOf(withAnnotations([{ type: 'arrow', from: { x: 0.2, y: 0.5 } }])))
        .toStrictEqual(['items[0].annotations[0].to'])
    })

    it('未知キーを拒否する', () => {
      expect(pathsOf(withAnnotations([{
        type: 'arrow',
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.3, y: 0.5 },
        width: 2,
      }]))).toStrictEqual(['items[0].annotations[0].width'])
    })
  })

  describe('Point / Rect', () => {
    it('object でない box を拒否する', () => {
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
    ])('%s を拒否する', (_label, box, expectedPath) => {
      expect(pathsOf(withBox(box))).toStrictEqual([expectedPath])
    })

    it('未知キーを持つ box を拒否する', () => {
      expect(pathsOf(withBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.2, r: 4 })))
        .toStrictEqual(['items[0].annotations[0].box.r'])
    })

    it('x + w が 1 を超える Rect を w のパスで拒否する', () => {
      const result = withBox({ x: 0.9, y: 0.1, w: 0.2, h: 0.2 })

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].box.w',
        message: 'x + w が 1 を超えます (x: 0.9, w: 0.2)',
      }])
    })

    it('y + h が 1 を超える Rect を h のパスで拒否する', () => {
      const result = withBox({ x: 0.1, y: 0.9, w: 0.2, h: 0.2 })

      expect(expectErrors(result)).toStrictEqual([{
        path: 'items[0].annotations[0].box.h',
        message: 'y + h が 1 を超えます (y: 0.9, h: 0.2)',
      }])
    })

    it('両軸のはみ出しを 2 件まとめて返す', () => {
      expect(pathsOf(withBox({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }))).toStrictEqual([
        'items[0].annotations[0].box.w',
        'items[0].annotations[0].box.h',
      ])
    })

    it('object でない anchor (Point) を拒否する', () => {
      expect(pathsOf(withAnnotations([{
        type: 'callout',
        text: 'ここ',
        box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        anchor: 0.1,
      }]))).toStrictEqual(['items[0].annotations[0].anchor'])
    })

    it('未知キーを持つ Point を拒否する', () => {
      expect(pathsOf(withAnnotations([{
        type: 'arrow',
        from: { x: 0.2, y: 0.5, z: 0 },
        to: { x: 0.3, y: 0.5 },
      }]))).toStrictEqual(['items[0].annotations[0].from.z'])
    })
  })
})

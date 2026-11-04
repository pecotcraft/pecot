// computeEnvHash / computeSlideHash の純関数検証。
// envHash は、次の両面を確認する。
// 材料 1 つの変化で必ず変わること。入力順やキー順では変わらないこと。
// slideHash は、R2 の位置依存挙動（末尾追加・中間挿入・削除・並べ替え）を確認する。
// どちらも、実データ形式の slides.md 文字列を @slidev/parser で分解して確かめる。
//
// 対象モジュールと同じく、設計上の用語 envHash を使うため name-replacements を disable する。
/* eslint-disable unicorn/name-replacements */

import { createHash } from 'node:crypto'

import { parseSync } from '@slidev/parser'
import { describe, expect, it } from 'vitest'

import { isRecord } from '../../_shared/json.js'
import { computeEnvHash, computeSlideHash, type EnvHashInput } from '../cache-key.js'

const baseInput: EnvHashInput = {
  headmatter: {
    theme: 'none',
    title: 'your-project 開発レポート',
    canvasWidth: 960,
    aspectRatio: '16/9',
    debug: false,
    fonts: { sans: ['Inter', 'Noto Sans JP'], weights: [400, 700] },
  },
  sharedFiles: [
    { path: 'layouts/cover.vue', hash: 'a'.repeat(64) },
    { path: 'components/LCodeBlock.vue', hash: 'b'.repeat(64) },
    { path: 'package.json', hash: 'c'.repeat(64) },
  ],
  bundleHash: 'd'.repeat(64),
  chromiumVersion: '141.0.7390.37',
  conversionConstants: {
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 5,
    targets: ['.terminal-window', '.diagram-block'],
    route: 'single-pass',
  },
  buildOptions: { theme: undefined },
  pluginVersion: '2.5.0',
  schemaVersion: 1,
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
null を含む fixture を作るための JSON 経由の構築（domain では null リテラルを書けない）。
*/
function jsonRecord(text: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new TypeError('fixture は JSON オブジェクトであること')
  return parsed
}

describe('computeEnvHash', () => {
  it('同一入力からは同一ハッシュを返す', () => {
    expect(computeEnvHash(baseInput)).toBe(computeEnvHash({ ...baseInput }))
  })

  it('sha256 hex 形式の文字列を返す', () => {
    expect(computeEnvHash(baseInput)).toMatch(/^[\da-f]{64}$/)
  })

  it('共有ファイル一覧の並び順が違ってもハッシュは変わらない', () => {
    const reordered: EnvHashInput = {
      ...baseInput,
      sharedFiles: baseInput.sharedFiles.toReversed(),
    }
    expect(computeEnvHash(reordered)).toBe(computeEnvHash(baseInput))
  })

  it('headmatter のキー順が違ってもハッシュは変わらない', () => {
    const reordered: EnvHashInput = {
      ...baseInput,
      headmatter: {
        fonts: { weights: [400, 700], sans: ['Inter', 'Noto Sans JP'] },
        debug: false,
        aspectRatio: '16/9',
        canvasWidth: 960,
        title: 'your-project 開発レポート',
        theme: 'none',
      },
    }
    expect(computeEnvHash(reordered)).toBe(computeEnvHash(baseInput))
  })

  it('null / undefined を含む headmatter でも決定論的に扱える', () => {
    const withNull: EnvHashInput = {
      ...baseInput,
      headmatter: jsonRecord('{"theme":"none","highlighter":null,"canvasWidth":960}'),
    }
    const withUndefined: EnvHashInput = {
      ...baseInput,
      headmatter: { theme: 'none', highlighter: undefined, canvasWidth: 960 },
    }
    expect(computeEnvHash(withNull)).toBe(computeEnvHash(withNull))
    // null と undefined は「値なし」として同一に扱う。
    expect(computeEnvHash(withNull)).toBe(computeEnvHash(withUndefined))
  })

  const variations: readonly (readonly [string, EnvHashInput])[] = [
    ['headmatter の値', { ...baseInput, headmatter: { ...baseInput.headmatter, canvasWidth: 1280 } }],
    ['共有ファイルの内容ハッシュ', {
      ...baseInput,
      sharedFiles: [
        { path: 'layouts/cover.vue', hash: 'f'.repeat(64) },
        ...baseInput.sharedFiles.slice(1),
      ],
    }],
    ['共有ファイルの構成（1 件追加）', {
      ...baseInput,
      sharedFiles: [...baseInput.sharedFiles, { path: 'styles/index.css', hash: 'e'.repeat(64) }],
    }],
    ['bundle 実体ハッシュ', { ...baseInput, bundleHash: '0'.repeat(64) }],
    ['Chromium バージョン', { ...baseInput, chromiumVersion: '142.0.0.1' }],
    ['変換定数', {
      ...baseInput,
      conversionConstants: { ...baseInput.conversionConstants, deviceScaleFactor: 4 },
    }],
    ['変換方式（route）', {
      ...baseInput,
      conversionConstants: { ...baseInput.conversionConstants, route: 'per-step' },
    }],
    ['プラグインバージョン', { ...baseInput, pluginVersion: '2.6.0' }],
    ['スキーマバージョン', { ...baseInput, schemaVersion: 2 }],
    ['ビルドオプション（--theme）', { ...baseInput, buildOptions: { theme: 'custom-theme' } }],
  ]

  it.each(variations)('%s が変わるとハッシュも変わる', (_name, changed) => {
    expect(computeEnvHash(changed)).not.toBe(computeEnvHash(baseInput))
  })

  it('bundle は宣言バージョンが同じでも中身が違えばハッシュが変わる', () => {
    // ワークスペースに宣言 1.1.10 / 実体 1.1.7 の乖離が実在したため、実体の内容で判定する。
    const declaredSameVersion = 'export const VERSION = "1.1.10"\n'
    const bundleA = `${declaredSameVersion}export function convert() { return 1 }\n`
    const bundleB = `${declaredSameVersion}export function convert() { return 2 }\n`
    expect(computeEnvHash({ ...baseInput, bundleHash: sha256Of(bundleA) }))
      .not.toBe(computeEnvHash({ ...baseInput, bundleHash: sha256Of(bundleB) }))
  })
})

const coverBlock = [
  '---',
  'theme: none',
  'title: テストデッキ',
  'canvasWidth: 960',
  '---',
  '',
  '# 表紙',
  '',
].join('\n')

const sectionBlock = [
  '---',
  'layout: section',
  'sectionNumber: "01"',
  '---',
  '',
  '# セクション',
  '',
].join('\n')

const detailBlock = [
  '---',
  'src: ./pages/detail.md',
  '---',
  '',
].join('\n')

const closingBlock = [
  '---',
  'layout: default',
  '---',
  '',
  '# まとめ',
  '',
].join('\n')

const extraBlock = [
  '---',
  'layout: default',
  '---',
  '',
  '# 追加ページ',
  '',
].join('\n')

function slideHashesOf(blocks: readonly string[]): readonly string[] {
  const parsed = parseSync(blocks.join(''), '/deck/slides.md')
  return parsed.slides.map((slide, index) =>
    computeSlideHash({ slideNumber: index + 1, blockRaw: slide.raw }))
}

const baseBlocks = [coverBlock, sectionBlock, detailBlock, closingBlock]

describe('computeSlideHash', () => {
  it('同一入力からは同一ハッシュを返す', () => {
    const input = { slideNumber: 3, blockRaw: sectionBlock, bodyRaw: '# 本文\n' }
    expect(computeSlideHash(input)).toBe(computeSlideHash({ ...input }))
    expect(computeSlideHash(input)).toMatch(/^[\da-f]{64}$/)
  })

  it('自スライドブロックが変わるとハッシュも変わる', () => {
    expect(computeSlideHash({ slideNumber: 1, blockRaw: sectionBlock }))
      .not.toBe(computeSlideHash({ slideNumber: 1, blockRaw: closingBlock }))
  })

  it('本文（src 分離時）が変わるとハッシュも変わる', () => {
    expect(computeSlideHash({ slideNumber: 1, blockRaw: detailBlock, bodyRaw: '# A\n' }))
      .not.toBe(computeSlideHash({ slideNumber: 1, blockRaw: detailBlock, bodyRaw: '# B\n' }))
  })

  it('raw 末尾の改行差はハッシュに影響しない', () => {
    // @slidev/parser の raw は末尾スライドだけ末尾改行を含む。正規化しないと
    // 「末尾に 1 枚追加」で直前のスライドがミスになる。
    expect(computeSlideHash({ slideNumber: 2, blockRaw: `${sectionBlock}\n\n` }))
      .toBe(computeSlideHash({ slideNumber: 2, blockRaw: sectionBlock.trimEnd() }))
    expect(computeSlideHash({ slideNumber: 2, blockRaw: detailBlock, bodyRaw: '# 本文\n\n' }))
      .toBe(computeSlideHash({ slideNumber: 2, blockRaw: detailBlock, bodyRaw: '# 本文' }))
  })

  it('本文なし（inline）と空本文は区別される', () => {
    expect(computeSlideHash({ slideNumber: 1, blockRaw: detailBlock }))
      .not.toBe(computeSlideHash({ slideNumber: 1, blockRaw: detailBlock, bodyRaw: '' }))
  })

  it('デッキ内位置が変わるとハッシュも変わる（ページ番号が描画に含まれるため）', () => {
    expect(computeSlideHash({ slideNumber: 2, blockRaw: sectionBlock }))
      .not.toBe(computeSlideHash({ slideNumber: 3, blockRaw: sectionBlock }))
  })
})

describe('slides.md の構成変更と slideHash', () => {
  it('末尾へのスライド追加では既存スライドのハッシュが変わらない', () => {
    const before = slideHashesOf(baseBlocks)
    const after = slideHashesOf([...baseBlocks, extraBlock])
    expect(after).toHaveLength(before.length + 1)
    expect(after.slice(0, before.length)).toStrictEqual(before)
  })

  it('中間挿入では、挿入位置の前側は不変で、後ろ側は全変化する', () => {
    const before = slideHashesOf(baseBlocks)
    const after = slideHashesOf([coverBlock, sectionBlock, extraBlock, detailBlock, closingBlock])
    expect(after.slice(0, 2)).toStrictEqual(before.slice(0, 2))
    // detail / closing は位置がシフトしたので別ハッシュ（= 再変換対象）。
    expect(after[3]).not.toBe(before[2])
    expect(after[4]).not.toBe(before[3])
  })

  it('中間削除では、削除位置の前側は不変で、後ろ側は全変化する', () => {
    const before = slideHashesOf(baseBlocks)
    const after = slideHashesOf([coverBlock, detailBlock, closingBlock])
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[2])
    expect(after[2]).not.toBe(before[3])
  })

  it('並べ替えでは位置が変わらないスライドのハッシュは変わらない', () => {
    const before = slideHashesOf(baseBlocks)
    const after = slideHashesOf([coverBlock, detailBlock, sectionBlock, closingBlock])
    expect(after[0]).toBe(before[0])
    expect(after[3]).toBe(before[3])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).not.toBe(before[2])
  })

  it('コードフェンス内の --- はスライド区切りとして扱われない', () => {
    const fencedBlock = [
      '---',
      'layout: default',
      '---',
      '',
      '# コード例',
      '',
      '```md',
      '---',
      'layout: cover',
      '---',
      '',
      'フェンス内の区切り',
      '```',
      '',
    ].join('\n')
    const hashes = slideHashesOf([coverBlock, fencedBlock, closingBlock])
    expect(hashes).toHaveLength(3)
    // フェンス内の変更は当該スライドだけを無効化する（分解が崩れていれば枚数が増える）。
    const edited = slideHashesOf([
      coverBlock,
      fencedBlock.replace('フェンス内の区切り', 'フェンス内の区切り（編集）'),
      closingBlock,
    ])
    expect(edited).toHaveLength(3)
    expect(edited[0]).toBe(hashes[0])
    expect(edited[1]).not.toBe(hashes[1])
    expect(edited[2]).toBe(hashes[2])
  })
})

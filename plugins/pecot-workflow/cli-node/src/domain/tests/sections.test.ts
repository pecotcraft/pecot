import { describe, expect, it } from 'vitest'

import {
  CHECKBOX_ERROR,
  CLOSED_HEADINGS_BY_TEMPLATE,
  EMOJI_ERROR,
  extractSectionsFromTemplate,
  FOLD_SUMMARY_BY_TEMPLATE,
  HORIZONTAL_RULE_ERROR,
  PLAN_FOLD_SUMMARY,
  SOFT_BREAK_ERROR,
  SUMMARY_MAX_CHARS,
  SUMMARY_MULTI_SENTENCE_ERROR,
  SUMMARY_NOT_JAPANESE_ERROR,
  validateBodyStyle,
  validateClosedHeadings,
  validateFoldBalance,
  validateFoldSummaries,
  validateHeadingSummaries,
  validateSections,
} from '../sections.js'
import type { SectionHeading } from '../sections.js'
import { splitCodePoints } from '../python-format.js'

// fixture の日本語本文と分けて持つ HTML コメントの開きタグと、クエリ付き URL
const COMMENT_OPEN = '<!--'
const QUERY_URL = 'https://example.com/a?x=1'

function heading(level: number, name: string): SectionHeading {
  return { level, name }
}

describe('extractSectionsFromTemplate', () => {
  it('見出しレベルが正しく抽出される', () => {
    const template = '---\nissue_ref: ""\n---\n\n### 完了した作業\n- 内容\n\n#### 残タスク\n- なし\n'
    expect(extractSectionsFromTemplate(template)).toEqual([heading(3, '完了した作業'), heading(4, '残タスク')])
  })

  it('em-dash 一行サマリは切り落とさずそのまま返す（検証側が要否を判断する）', () => {
    const template = '---\n---\n\n## Verified — <何を検証したか>\n## Risks\n'
    expect(extractSectionsFromTemplate(template)).toEqual([heading(2, 'Verified — <何を検証したか>'), heading(2, 'Risks')])
  })

  it('##から######まで全てのレベルを抽出', () => {
    const template = '---\n---\n\n## レベル2\n### レベル3\n#### レベル4\n##### レベル5\n###### レベル6\n'
    expect(extractSectionsFromTemplate(template)).toEqual([
      heading(2, 'レベル2'),
      heading(3, 'レベル3'),
      heading(4, 'レベル4'),
      heading(5, 'レベル5'),
      heading(6, 'レベル6'),
    ])
  })

  it('フロントマターがない場合も抽出可能', () => {
    expect(extractSectionsFromTemplate('### セクション1\n内容\n#### セクション2\n内容\n')).toEqual([heading(3, 'セクション1'), heading(4, 'セクション2')])
  })

  it('フロントマターの中の見出しは抽出しない', () => {
    expect(extractSectionsFromTemplate('---\n## 中の見出し\n---\n## 外の見出し\n')).toEqual([heading(2, '外の見出し')])
  })

  it('閉じていないフロントマターは全体を本文として読む', () => {
    expect(extractSectionsFromTemplate('---\n## 見出し\n')).toEqual([heading(2, '見出し')])
  })

  it('本文中の --- 以降も本文として読む', () => {
    expect(extractSectionsFromTemplate('---\na: b\n---\n## 一\n---\n## 二\n')).toEqual([heading(2, '一'), heading(2, '二')])
  })

  it('CRLF の行末は見出し名に含めない', () => {
    expect(extractSectionsFromTemplate('## 見出し\r\n')).toEqual([heading(2, '見出し')])
  })

  it('冒頭の書き方ガイド（HTML コメント）の中の見出し行は抽出しない', () => {
    const template = `---\nissue_ref: ""\n---\n\n${COMMENT_OPEN}\n書き方:\n### 例の見出し — コメントの中\n-->\n\n### Done — <完了>\n`
    expect(extractSectionsFromTemplate(template)).toEqual([heading(3, 'Done — <完了>')])
  })

  it('# が 1 つや 7 つの行は見出しにしない', () => {
    expect(extractSectionsFromTemplate('# 一\n####### 七\n##なし\n')).toEqual([])
  })
})

describe('validateSections（必須セクション検証: 見出しレベル・em-dash サマリ）', () => {
  it('全セクションが正しいレベルで存在する場合は空リスト', () => {
    const body = '\n### 完了した作業\n- タスク1\n\n### 現在の状態\n- 状態1\n'
    expect(validateSections(body, [heading(3, '完了した作業'), heading(3, '現在の状態')])).toEqual([])
  })

  it('セクションが不足している場合はレベル付きで返す', () => {
    const body = '\n### 完了した作業\n- タスク1\n'
    expect(validateSections(body, [heading(3, '完了した作業'), heading(3, '現在の状態')])).toEqual(['### 現在の状態'])
  })

  it('見出しレベルが違う場合は不足として検出', () => {
    const body = '\n## サマリー\nテスト\n\n## 完了した作業\n- タスク1\n'
    // テンプレートでは ### (level 3) を期待、## があっても不足
    expect(validateSections(body, [heading(2, 'サマリー'), heading(3, '完了した作業')])).toEqual(['### 完了した作業'])
  })

  it('最初の h2 も、ほかの見出しと同じくテンプレの名前で始まる必要がある', () => {
    expect(validateSections('\n## Summary\nテスト\n', [heading(2, 'Summary')])).toEqual([])
    expect(validateSections('\n## 何でもいい見出し\nテスト\n', [heading(2, 'Summary')])).toEqual(['## Summary'])
  })

  it('最初の h2 が無い場合は、その名前の見出しの不足として検出', () => {
    const body = '\n### 完了した作業\n- タスク1\n'
    expect(validateSections(body, [heading(2, 'サマリー'), heading(3, '完了した作業')])).toContain('## サマリー')
  })

  it('#### 形式のセクションを正しく検出', () => {
    expect(validateSections('\n#### 残タスク\n- なし\n', [heading(4, '残タスク')])).toEqual([])
  })

  it('h4 を期待している箇所に h3 があっても不足として検出', () => {
    expect(validateSections('\n### 残タスク\n- なし\n', [heading(4, '残タスク')])).toEqual(['#### 残タスク'])
  })

  it('異なるレベルの見出しが混在', () => {
    const body = '\n### 完了した作業\n- タスク1\n\n#### 残タスク\n- なし\n'
    expect(validateSections(body, [heading(3, '完了した作業'), heading(4, '残タスク'), heading(4, '確認事項')])).toEqual(['#### 確認事項'])
  })

  it('required_sections が空の場合は空リストを返す', () => {
    expect(validateSections('テスト本文', [])).toEqual([])
  })

  it('セクション名に特殊文字が含まれる場合も正しく検出', () => {
    expect(validateSections('\n### 注意事項・コンテキスト\n- 内容\n', [heading(3, '注意事項・コンテキスト')])).toEqual([])
  })

  it('正規表現の記号を含むセクション名は文字どおりに比べる', () => {
    expect(validateSections('### a.b (c)\n', [heading(3, 'a.b (c)')])).toEqual([])
    expect(validateSections('### axb (c)\n', [heading(3, 'a.b (c)')])).toEqual(['### a.b (c)'])
  })

  it('セクション名の途中マッチは不足扱い（em-dash 区切りが必須）', () => {
    const result = validateSections('## VerifiedExtra — まぎらわしい\n\n- aaa', [heading(2, 'Verified — <summary>')])
    expect(result).toEqual(['## Verified — <summary>'])
  })

  it('テンプレが em-dash サマリを宣言していれば半角ハイフンは不足扱い', () => {
    const result = validateSections('## Verified - テスト通過\n\n- aaa', [heading(2, 'Verified — <summary>')])
    expect(result).toEqual(['## Verified — <summary>'])
  })

  it('見出しがあればサマリの規則違反は不足に数えない（validateHeadingSummaries の担当）', () => {
    const over = `${'a'.repeat(SUMMARY_MAX_CHARS + 1)}。b`
    expect(validateSections(`## Verified — ${over}`, [heading(2, 'Verified — <summary>')])).toEqual([])
  })

  it('未編集プレースホルダの報告は validateBodyStyle の担当（#962 で移設）', () => {
    const body = '## Verified — <何を検証したかを1行で>\n\n<details><summary>log</summary></details>'
    const result = validateSections(body, [heading(2, 'Verified — <summary>')])
    expect(result.every(message => !message.includes('unedited placeholder'))).toBe(true)
  })
})

describe('validateHeadingSummaries（em-dash サマリは 50 文字以内・日本語を含む 1 文 #1185）', () => {
  const required = [heading(2, 'Verified — <summary>')]

  it('サマリが上限を超えると文字数付きで返す', () => {
    const over = 'あ'.repeat(SUMMARY_MAX_CHARS + 1)
    expect(validateHeadingSummaries(`## Verified — ${over}`, required)).toEqual([
      `## Verified — the summary is ${String(SUMMARY_MAX_CHARS + 1)} characters (limit: ${String(SUMMARY_MAX_CHARS)})`,
    ])
  })

  it('文字数はコードポイントで数える', () => {
    const emoji = '\u{1F600}'.repeat(SUMMARY_MAX_CHARS)
    expect(validateHeadingSummaries(`## Verified — ${emoji}あ`, required)).toEqual([`## Verified — the summary is ${String(SUMMARY_MAX_CHARS + 1)} characters (limit: ${String(SUMMARY_MAX_CHARS)})`])
    expect(validateHeadingSummaries(`## Verified — ${'\u{1F600}'.repeat(SUMMARY_MAX_CHARS - 1)}あ`, required)).toEqual([])
  })

  it('見出しが無いものは返さない（不足は validateSections が返す）', () => {
    expect(validateHeadingSummaries('## Verified - 通過', required)).toEqual([])
  })

  it('em-dash を宣言しない見出しはサマリを確認しない', () => {
    expect(validateHeadingSummaries('### Repro\n', [heading(3, 'Repro')])).toEqual([])
  })

  it('ASCII だけのサマリは不可', () => {
    expect(validateHeadingSummaries('## Verified — all tests pass', required)).toEqual([`## Verified — ${SUMMARY_NOT_JAPANESE_ERROR}`])
  })

  it('ASCII と日本語が両方あれば可', () => {
    expect(validateHeadingSummaries('## Verified — v0.5.0 の公開', required)).toEqual([])
  })

  it.each([
    ['々', 'noma'],
    ['テスト', 'katakana'],
    ['てすと', 'hiragana'],
    ['検証', 'kanji'],
    [String.fromCodePoint(0xFF_83, 0xFF_7D, 0xFF_84), 'halfwidth-kana'],
  ])('日本語の文字種として数える: %s（%s）', (summary) => {
    expect(validateHeadingSummaries(`## Verified — ${summary}`, required)).toEqual([])
  })

  it('2 文は不可', () => {
    expect(validateHeadingSummaries('## Verified — 通過した。残りなし', required)).toEqual([`## Verified — ${SUMMARY_MULTI_SENTENCE_ERROR}`])
  })

  it.each(['！', '？', '!', '?'])('途中の文末記号 %s も 2 文として弾く', (mark) => {
    expect(validateHeadingSummaries(`## Verified — 完了${mark} 次へ`, required)).toEqual([`## Verified — ${SUMMARY_MULTI_SENTENCE_ERROR}`])
  })

  it('半角 . は文末に数えない（v1.2 のような表記があるため）', () => {
    expect(validateHeadingSummaries('## Verified — v1.2 を公開', required)).toEqual([])
  })

  it('末尾の句点は可', () => {
    expect(validateHeadingSummaries('## Verified — 全件通過した。', required)).toEqual([])
  })

  it.each(['「完了。」', '（全件通過した。）', `『完了${String.fromCodePoint(0xFF_01)}』`])('閉じ括弧の前の文末は末尾の括弧を除いて判定する: %s', (summary) => {
    expect(validateHeadingSummaries(`## Verified — ${summary}`, required)).toEqual([])
  })

  it('文字数・日本語・1 文の違反は同じ見出しについて全て返す', () => {
    const summary = `${'あ'.repeat(SUMMARY_MAX_CHARS - 1)}。いい`
    expect(validateHeadingSummaries(`## Verified — ${summary}`, required)).toEqual([
      `## Verified — the summary is ${String(splitCodePoints(summary).length)} characters (limit: ${String(SUMMARY_MAX_CHARS)})`,
      `## Verified — ${SUMMARY_MULTI_SENTENCE_ERROR}`,
    ])
  })

  it('em-dash を宣言しない最初の h2 は、名前の前方一致だけを見る', () => {
    expect(validateSections('## Release v1', [heading(2, 'Release')])).toEqual([])
    expect(validateHeadingSummaries('## Release v1', [heading(2, 'Release')])).toEqual([])
  })
})

describe('validateBodyStyle: チェックボックス記法（#962）', () => {
  it('未チェックの箱は不可', () => {
    expect(validateBodyStyle('## Progress — テスト\n\n- [ ] やること\n').some(message => message.includes('checkbox syntax'))).toBe(true)
  })

  it('チェック済みの箱は不可', () => {
    expect(validateBodyStyle('- [x] 完了\n').some(message => message.includes('checkbox syntax'))).toBe(true)
  })

  it('* と + の箇条書きも不可', () => {
    expect(validateBodyStyle('* [ ] a\n').some(message => message.includes('checkbox syntax'))).toBe(true)
    expect(validateBodyStyle('+ [X] a\n').some(message => message.includes('checkbox syntax'))).toBe(true)
  })

  it.each(['1. [ ] a', '2) [x] b', '10. [X] c'])('番号付きリストの箱は不可: %s', (line) => {
    expect(validateBodyStyle(`${line}\n`)).toEqual([CHECKBOX_ERROR])
  })

  it('番号付きリストのリンクは箱ではない', () => {
    expect(validateBodyStyle('1. [x](https://example.com/x) を参照\n')).toEqual([])
  })

  it('`- [x](url)` のようなリンク項目は誤検知しない', () => {
    expect(validateBodyStyle('- [x](https://example.com/x) を参照\n- [ref](https://example.com/r) も参照\n')).toEqual([])
  })

  it.each(['> - [ ] x', '> > * [x] y', '- - [ ] z', '>- [ ] w'])('引用・入れ子リストの中のタスクリストも不可: %s', (line) => {
    expect(validateBodyStyle(`${line}\n`)).toEqual([CHECKBOX_ERROR])
  })

  it('引用の中のリンク項目は箱ではない', () => {
    expect(validateBodyStyle('> - [x](https://example.com/x) を参照\n')).toEqual([])
  })

  it('複数行あってもチェックボックスの報告は 1 件にまとめる', () => {
    const messages = validateBodyStyle('- [ ] a\n- [ ] b\n- [x] c\n')
    expect(messages.filter(message => message.includes('checkbox syntax'))).toHaveLength(1)
  })
})

describe('validateBodyStyle: コードフェンス・インラインコード・HTML コメントのマスク（#962）', () => {
  it('フェンスの中身は対象外', () => {
    expect(validateBodyStyle('## Verified — テスト\n\n```markdown\n- [ ] やること\n<未編集>\n```\n')).toEqual([])
  })

  it('チルダのフェンスも使える', () => {
    expect(validateBodyStyle('~~~\n- [ ] やること\n~~~\n')).toEqual([])
  })

  it('リスト配下のインデントフェンスも中身をマスクする', () => {
    expect(validateBodyStyle('- 手順\n\n  ```bash\n  - [ ] not a task\n  echo \'<未編集>\'\n  ```\n\n- 次\n')).toEqual([])
  })

  it('開きより長い閉じフェンスでも閉じる', () => {
    expect(validateBodyStyle('```\n- [ ] a\n````\n\n本文\n')).toEqual([])
  })

  it('未閉じフェンスは黙殺せずエラー（フェンス以降の検証バイパス防止）', () => {
    expect(validateBodyStyle('```bash\necho hi\n\n- [ ] やること\n')).toEqual(['code fence is not closed'])
  })

  it('インラインコードは対象外', () => {
    expect(validateBodyStyle('- 記法 `- [ ]` を使わない\n- 型は `<T>` と書く\n')).toEqual([])
  })

  it('二重バッククォートのスパンは対象外', () => {
    expect(validateBodyStyle('- ``<`未編集`>`` はコード\n')).toEqual([])
  })

  it('長さの違うランでは閉じない（`` で開いたスパンは ` では閉じない）', () => {
    expect(validateBodyStyle('- ``a` <未編集> ``b\n')).toEqual([])
  })

  it('閉じ忘れバッククォート以降のプレースホルダは見逃さない', () => {
    expect(validateBodyStyle('- `途中で閉じ忘れ <未編集>\n').some(message => message.includes('<未編集>'))).toBe(true)
  })

  it('HTML コメントは対象外', () => {
    expect(validateBodyStyle(`本文\n\n${COMMENT_OPEN} 生成元: pecot quick / <未編集> / - [ ] -->\n`)).toEqual([])
  })

  it('複数行の HTML コメントは対象外', () => {
    expect(validateBodyStyle(`本文\n\n${COMMENT_OPEN}\n書き方:\n- [ ] は使わない\n<プレースホルダ>\n-->\n\n続き\n`)).toEqual([])
  })
})

describe('validateBodyStyle: 未編集プレースホルダの検出と正当な `<...>` の通過（#962）', () => {
  it('日本語のプレースホルダは不可', () => {
    expect(validateBodyStyle('- **<観測できる状態>** — 確認: 手動\n').some(message => message.includes('<観測できる状態>'))).toBe(true)
  })

  it('HTML タグ形状に見える ASCII 語のプレースホルダも通さない', () => {
    for (const token of ['<short-sha>', '<NNN-feature>']) {
      expect(validateBodyStyle(`- 参照: ${token}\n`).some(message => message.includes(token))).toBe(true)
    }
  })

  it('`<OS 等>` のような ASCII 語 + 空白 + 日本語も通さない', () => {
    for (const token of ['<OS 等>', '<AS-IS と TO-BE の差を 1 文で>', '<Step 4 の結果を1行で>']) {
      expect(validateBodyStyle(`- 環境: ${token}\n`).some(message => message.includes(token))).toBe(true)
    }
  })

  it('型・メタ表記は素で書くと落ちる（バッククォートで囲む運用）', () => {
    expect(validateBodyStyle('- list<T> を返す\n').some(message => message.includes('<T>'))).toBe(true)
  })

  it('許可された HTML タグは通す', () => {
    const body = `<details><summary>ログ</summary>\n\n本文<br>続き\n\n</details>\n<kbd>Ctrl</kbd> と <a href="${QUERY_URL}">リンク</a>\n<img src="https://example.com/i.png" alt="図" />\n`
    expect(validateBodyStyle(body)).toEqual([])
  })

  it('autolink は通す', () => {
    expect(validateBodyStyle('<https://ghes.example.com/acme-labs/aist-plugin/issues/962>\n<user@example.com>\n')).toEqual([])
  })

  it('`<` の直後が英字でないトークンは比較・バージョン表現として通す', () => {
    expect(validateBodyStyle('engines "<0.0.0" + engine-strict の <0.0.0> と 応答 <1s> を確認\n')).toEqual([])
  })

  it('CHANGELOG 転記（release PR の Changes 節）が誤検知されない', () => {
    const body = '## Changes — リリース内容\n\n'
      + '- pecotv 全 package に **engines "<0.0.0" + engine-strict** で npm / yarn 混入を block し、\n'
      + '  repo root には逆方向に **pnpm / yarn を block**（npm の既定の流れは温存）するガードを追加。\n'
    expect(validateBodyStyle(body)).toEqual([])
  })

  it('見出しのプレースホルダは見出しと明示する', () => {
    const body = '## Verified — <何を検証したかを1行で>\n\n<details><summary>log</summary></details>'
    const result = validateBodyStyle(body)
    expect(result.some(message => message.includes('heading') && message.startsWith('unedited placeholder'))).toBe(true)
    expect(result.every(message => !message.includes('details'))).toBe(true)
  })

  it('`<#<issue番号> <タイトル>>` のような入れ子も中のトークンを拾う', () => {
    const result = validateBodyStyle('## Merge — <#<issue番号> <タイトル> のサマリ>\n')
    expect(result.some(message => message.includes('<issue番号>'))).toBe(true)
    expect(result.some(message => message.includes('<タイトル>'))).toBe(true)
  })

  it('`<` の閉じ忘れが次行以降を飲み込まない', () => {
    expect(validateBodyStyle('行1 < 未閉じ\n\n行2 > 続き\n')).toEqual([])
  })

  it('同じトークンは 1 件だけ報告する', () => {
    expect(validateBodyStyle('- **<観測できる状態>** — a\n- **<観測できる状態>** — b\n')).toHaveLength(1)
  })

  it('問題のない本文は通る', () => {
    const body = '## Verified — テスト通過\n\n'
      + 'pytest を全件流した。\n\n'
      + '- **単体テスト** — `run-tests.sh --scope=py` が 0 exit\n\n'
      + '## Risks — なし\n\n'
      + '- **影響範囲** — なし\n'
    expect(validateBodyStyle(body)).toEqual([])
  })
})

describe('validateBodyStyle: 水平線（#1185）', () => {
  it.each(['---', '***', '___', '- - -', ' * * * ', '-----'])('水平線は不可: %j', (line) => {
    expect(validateBodyStyle(`本文\n\n${line}\n\n続き\n`)).toEqual([HORIZONTAL_RULE_ERROR])
  })

  it.each([
    ['> ---', 'quote'],
    ['> > ***', 'nested-quote'],
    ['- ***', 'list'],
    ['1. ___', 'ordered-list'],
    ['> - ---', 'quote-list'],
    ['-\t-\t-', 'tab-dash'],
    ['*\t*\t*', 'tab-star'],
    ['---\t', 'trailing-tab'],
  ])('引用・リストの中の水平線とタブ区切りの水平線も不可: %j（%s）', (line) => {
    expect(validateBodyStyle(`本文\n\n${line}\n\n続き\n`)).toEqual([HORIZONTAL_RULE_ERROR])
  })

  it.each(['- 項目', '> 引用文', '- -- の扱い', '> | a | b |'])('普通の引用・リスト行は通る: %j', (line) => {
    expect(validateBodyStyle(`${line}\n`)).toEqual([])
  })

  it.each(['<hr>', '<hr/>', '<hr />', '<HR>'])('%s はプレースホルダではなく水平線として弾く', (tag) => {
    expect(validateBodyStyle(`本文\n\n${tag}\n`)).toEqual([HORIZONTAL_RULE_ERROR])
  })

  it('表の区切り行は通る', () => {
    expect(validateBodyStyle('| Expected | Actual |\n|---|---|\n| a | b |\n')).toEqual([])
  })

  it('フェンスの中の水平線は通る', () => {
    expect(validateBodyStyle('```yaml\n---\ntitle: x\n---\n```\n')).toEqual([])
  })

  it('フェンスの中の引用された水平線は通る', () => {
    expect(validateBodyStyle('```markdown\n> ---\n- ***\n> - [ ] x\n```\n')).toEqual([])
  })

  it('引用された表の区切り行は通る', () => {
    expect(validateBodyStyle('> | a | b |\n> |---|---|\n> | 1 | 2 |\n')).toEqual([])
  })

  it('インラインコードと HTML コメントの中の水平線は通る', () => {
    expect(validateBodyStyle(`- 記法 \`---\` は使わない\n\n${COMMENT_OPEN}\n---\n-->\n`)).toEqual([])
  })

  it('4 スペース以上のインデントは CommonMark では水平線にならない', () => {
    expect(validateBodyStyle('    ---\n')).toEqual([])
  })

  it('何度出ても 1 件だけ報告する', () => {
    expect(validateBodyStyle('---\n\n***\n\n<hr>\n')).toEqual([HORIZONTAL_RULE_ERROR])
  })
})

describe('validateBodyStyle: 絵文字（#1185）', () => {
  it.each(['⚠', '✓', '★', '→', '✗'])('テキスト表示の記号は通る: %s', (text) => {
    expect(validateBodyStyle(`- ${text} 注意点\n`)).toEqual([])
  })

  it.each([
    ['✅', 'check-mark-button'],
    ['❌', 'cross-mark'],
    ['⚠️', 'warning-with-vs16'],
    ['🚀', 'rocket'],
    ['⭐', 'star'],
  ])('絵文字は不可: %s（%s）', (text) => {
    expect(validateBodyStyle(`- ${text} 完了\n`)).toEqual([EMOJI_ERROR])
  })

  it.each(['㊗', '㊙'])('Emoji_Presentation=Yes の U+3297 / U+3299 は不可: %s', (text) => {
    expect(validateBodyStyle(`${text} 祝\n`)).toEqual([EMOJI_ERROR])
  })

  it.each([':white_check_mark:', ':thumbsup:', ':rocket:', ':100_a:'])('GitHub が絵文字として描画するショートコードは不可: %s', (text) => {
    expect(validateBodyStyle(`- ${text} 完了\n`)).toEqual([EMOJI_ERROR])
  })

  it.each([
    ['10:30:00 に実行', 'time'],
    ['比率 1:2:3', 'ratio'],
    ['https://example.com/a:b', 'url'],
    ['`:rocket:` は使わない', 'inline-code'],
  ])('ショートコードでないコロンは通る: %s（%s）', (text) => {
    expect(validateBodyStyle(`- ${text}\n`)).toEqual([])
  })

  it('見出しの中の絵文字は不可', () => {
    expect(validateBodyStyle('## Verified — 🎉 全件通過\n')).toEqual([EMOJI_ERROR])
  })

  it('コードの中の絵文字は通る', () => {
    expect(validateBodyStyle('- `✅` は使わない\n\n```\n🚀\n```\n')).toEqual([])
  })

  it('何度出ても 1 件だけ報告する', () => {
    expect(validateBodyStyle('- ✅ a\n- ❌ b\n')).toEqual([EMOJI_ERROR])
  })
})

describe('validateBodyStyle: 記法違反が複数あるとき全種を 1 件ずつ返す', () => {
  it('全ての規則が決まった順で報告される', () => {
    const body = '## Progress — 途中\n\n1. [ ] a\n\n---\n\n- ✅ b\n- <未編集>\n'
    expect(validateBodyStyle(body)).toEqual([
      CHECKBOX_ERROR,
      HORIZONTAL_RULE_ERROR,
      EMOJI_ERROR,
      'unedited placeholder <未編集> remains',
    ])
  })
})

describe('validateFoldBalance（折りたたみ <details> の開閉の対応 #1330）', () => {
  const unclosed = ['<details> is not closed']
  const noOpening = ['<details> has no matching opening tag']

  it('テンプレートごとの案内文', () => {
    expect(new Set(CLOSED_HEADINGS_BY_TEMPLATE.keys())).toEqual(new Set(['plan']))
    expect(CLOSED_HEADINGS_BY_TEMPLATE.get('plan')).toContain('Notes')
  })

  it('対応した開閉は通る', () => {
    expect(validateFoldBalance('短い\n\n<details>\n<summary>要約</summary>\n\n本文\n\n</details>\n')).toEqual([])
  })

  it('折りたたみの外の文字数は見ない', () => {
    expect(validateFoldBalance('あ'.repeat(20_000))).toEqual([])
  })

  it('閉じられていない details', () => {
    expect(validateFoldBalance(`<details>\n${'x'.repeat(500)}`)).toEqual(unclosed)
  })

  it('閉じタグだけがある', () => {
    expect(validateFoldBalance('本文\n</details>\n')).toEqual(noOpening)
  })

  it('文字の行にある閉じタグだけ', () => {
    expect(validateFoldBalance('a</details>')).toEqual(noOpening)
  })

  it('閉じタグが開きタグより前', () => {
    expect(validateFoldBalance('</details>\n<details>\n')).toEqual(noOpening)
  })

  it('空の本文', () => {
    expect(validateFoldBalance('')).toEqual([])
  })

  it('入れ子の details', () => {
    expect(validateFoldBalance('<details>\n<details>\n内\n</details>\n</details>\n')).toEqual([])
  })

  it('入れ子の外側が閉じられていない', () => {
    expect(validateFoldBalance('<details>\n<details>\n内\n</details>\n')).toEqual(unclosed)
  })

  it('リスト項目の中の details', () => {
    expect(validateFoldBalance('- <details>\n  本文\n  </details>\n')).toEqual([])
  })

  it('属性付きと大文字の details', () => {
    expect(validateFoldBalance('<details open>\nx\n</details>')).toEqual([])
    expect(validateFoldBalance('<DETAILS>\nx\n</DETAILS>')).toEqual([])
  })

  it.each([
    ['fenced_code', '```html\n<details>\n```\n'],
    ['inline_code', '`<details>`'],
    ['html_comment', `${COMMENT_OPEN} <details> -->\n`],
  ])('マスクされた領域の中の details は折りたたみではない: %s', (_name, body) => {
    expect(validateFoldBalance(body)).toEqual([])
  })

  it('他のタグは折りたたまない', () => {
    expect(validateFoldBalance('<summary>x</summary>')).toEqual([])
  })

  it('未閉じのフェンスは validateBodyStyle に任せる', () => {
    expect(validateFoldBalance('```\n<details>\n')).toEqual([])
  })
})

describe('validateClosedHeadings（テンプレに無い ## / ### 見出し #1330）', () => {
  const sections = [
    heading(2, 'Plan — <概要>'),
    heading(3, 'Context — <背景>'),
    heading(3, 'Notes — <メモ>'),
    heading(2, 'PECOT-Workflow — <構成>'),
  ]

  it('テンプレの見出しは通る', () => {
    expect(validateClosedHeadings('## Plan — 計画\n\n### Context — 背景\n\n### Notes — なし\n\n## PECOT-Workflow — 構成\n', sections)).toEqual([])
  })

  it('テンプレに無い見出しはレベル付きで返す', () => {
    expect(validateClosedHeadings('## Plan — 計画\n\n### Context — 背景\n\n### Risks — 懸念\n\n## Goal\n', sections)).toEqual(['### Risks', '## Goal'])
  })

  it('同じ見出しは 1 回だけ返す', () => {
    expect(validateClosedHeadings('### Risks — a\n\n### Risks — b\n', sections)).toEqual(['### Risks'])
  })

  it('レベルが違えば、テンプレに無い見出し', () => {
    expect(validateClosedHeadings('### Plan — 計画\n\n## Context — 背景\n', sections)).toEqual(['### Plan', '## Context'])
  })

  it('サマリの無い見出しは全体を名前にする', () => {
    expect(validateClosedHeadings('### Steps\n', sections)).toEqual(['### Steps'])
  })

  it('h1 と h4 以下は縛らない', () => {
    expect(validateClosedHeadings('# タイトル\n\n#### CUJ 1\n\n##### 細部\n', sections)).toEqual([])
  })

  it('details の中の見出しも見る', () => {
    expect(validateClosedHeadings('<details>\n<summary>x</summary>\n\n### Steps — 手順\n\n</details>\n', sections)).toEqual(['### Steps'])
  })

  it.each([
    ['fenced_code', '```markdown\n### Steps — 例\n```\n'],
    ['html_comment', `${COMMENT_OPEN}\n### Steps — 例\n-->\n`],
    ['inline_code', '`### Steps`\n'],
  ])('マスクされた領域の中の見出しは見ない: %s', (_name, body) => {
    expect(validateClosedHeadings(body, sections)).toEqual([])
  })

  it('未閉じのフェンスは validateBodyStyle に任せる', () => {
    expect(validateClosedHeadings('```\n### Steps\n', sections)).toEqual([])
  })
})

function fold(summary: string): string {
  return `<details>\n${summary}\n\n本文\n\n</details>\n`
}

function failure(summary: string): string {
  return `${summary} must be ${PLAN_FOLD_SUMMARY}`
}

describe('validateFoldSummaries（折りたたみの開閉部分 <summary> の形 #1299）', () => {
  it('テンプレートごとの形', () => {
    expect(FOLD_SUMMARY_BY_TEMPLATE).toEqual(new Map([['plan', PLAN_FOLD_SUMMARY]]))
    expect(PLAN_FOLD_SUMMARY).toBe('<summary align="right">詳細はこちら</summary>')
  })

  it('期待の形は通る', () => {
    expect(validateFoldSummaries(`${fold(PLAN_FOLD_SUMMARY)}\n- ${fold(PLAN_FOLD_SUMMARY)}`, PLAN_FOLD_SUMMARY)).toEqual([])
  })

  it('summary のない本文は通る', () => {
    expect(validateFoldSummaries('本文だけ\n', PLAN_FOLD_SUMMARY)).toEqual([])
  })

  it.each([
    '<summary>詳細はこちら</summary>',
    '<summary align="right">理由</summary>',
    '<summary align="center">詳細はこちら</summary>',
    '<summary align="right"><b>詳細はこちら</b></summary>',
  ])('他の形は不可: %s', (summary) => {
    expect(validateFoldSummaries(fold(summary), PLAN_FOLD_SUMMARY)).toEqual([failure(summary)])
  })

  it('複数行に分けた summary は不可', () => {
    const body = '<details>\n<summary align="right">\n詳細はこちら\n</summary>\n\n本文\n\n</details>\n'
    expect(validateFoldSummaries(body, PLAN_FOLD_SUMMARY)).toEqual([failure('<summary align="right">')])
  })

  it('同じ違反は 1 件だけ報告する', () => {
    expect(validateFoldSummaries(fold('<summary>理由</summary>').repeat(2), PLAN_FOLD_SUMMARY)).toEqual([failure('<summary>理由</summary>')])
  })

  it.each([
    '```html\n<summary>理由</summary>\n```\n',
    '`<summary>理由</summary>` の形は使わない\n',
    `${COMMENT_OPEN} <summary>理由</summary> -->\n`,
  ])('コードとコメントの中は対象外: %j', (body) => {
    expect(validateFoldSummaries(body, PLAN_FOLD_SUMMARY)).toEqual([])
  })

  it('未閉じのフェンスは validateBodyStyle に任せる', () => {
    expect(validateFoldSummaries('```\n<summary>理由</summary>', PLAN_FOLD_SUMMARY)).toEqual([])
  })
})

describe('validateBodyStyle: 段落の中の改行（GitHub は改行のまま表示する）', () => {
  it.each([
    ['段落', '1 文目。\n2 文目。\n'],
    ['行末のインラインコード', '文 `code`\n続き\n'],
    ['引用', '> 引用の 1 文目。\n> 引用の 2 文目。\n'],
  ])('%s の中の改行を止める', (_name, body) => {
    expect(validateBodyStyle(body)).toContain(SOFT_BREAK_ERROR)
  })

  it.each([
    ['つなげた段落', '1 文目。2 文目。\n\n次の段落。\n'],
    ['箇条書き', '- a\n- b\n'],
    ['箇条書きの続き', '- 項目\n  続き\n'],
    ['表', '| a |\n| b |\n'],
    ['見出し', '## 見出し\n本文\n'],
    ['コードフェンス', '本文\n```\nx\ny\n```\n'],
    ['折りたたみ', '<details>\n<summary>x</summary>\n\n本文\n\n</details>\n'],
    ['引用の種類', ['> [!WARNING]', '> 注意の文。', ''].join('\n')],
    ['段落の後の引用', '本文\n> 引用\n'],
    ['画像', ['![a](./a.png)', '本文', ''].join('\n')],
    ['明示の改行', '明示の改行  \n続き\n'],
    ['コメント', '<!--\n冒頭の\n説明\n-->\n'],
  ])('%s は止めない', (_name, body) => {
    expect(validateBodyStyle(body)).not.toContain(SOFT_BREAK_ERROR)
  })
})

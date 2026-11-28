import { describe, expect, it } from 'vitest'
import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'

import {
  CHECKBOX_ERROR,
  CLOSED_HEADINGS_BY_TEMPLATE,
  EMOJI_ERROR,
  extractSectionsFromTemplate,
  FOLD_SUMMARY_BY_TEMPLATE,
  hasSummaryImage,
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
  it('テンプレートの見出しを渡すと、レベルと名前を取り出す', async () => {
    await explains('テンプレートから見出しを取り出す `extractSectionsFromTemplate` のテストです。フロントマターと本文を持つテンプレートを渡した場合に、見出しのレベルと名前を、現れた順に返すことを確認します。')
    const template = stepSync('雛形を用意する', () => '---\nissue_ref: ""\n---\n\n### 完了した作業\n- 内容\n\n#### 残タスク\n- なし\n')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate(template)).toEqual([heading(3, '完了した作業'), heading(4, '残タスク')])
    })
  })

  it('em-dash 一行サマリは切り落とさずそのまま返す（検証側が要否を判断する）', async () => {
    await explains('見出しに `—` で区切った一行の要約が付いている場合の、`extractSectionsFromTemplate` のテストです。要約の部分を切り落とさず、見出しの名前としてそのまま返すことを確認します。')
    const template = stepSync('雛形を用意する', () => '---\n---\n\n## Verified — <何を検証したか>\n## Risks\n')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate(template)).toEqual([heading(2, 'Verified — <何を検証したか>'), heading(2, 'Risks')])
    })
  })

  it('## から ###### までの見出しを渡すと、すべてのレベルを取り出す', async () => {
    await explains('見出しのレベルの範囲のテストです。`##` から `######` までのすべてのレベルの見出しを、レベルと名前に分けて返すことを確認します。')
    const template = stepSync('雛形を用意する', () => '---\n---\n\n## レベル2\n### レベル3\n#### レベル4\n##### レベル5\n###### レベル6\n')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate(template)).toEqual([
        heading(2, 'レベル2'),
        heading(3, 'レベル3'),
        heading(4, 'レベル4'),
        heading(5, 'レベル5'),
        heading(6, 'レベル6'),
      ])
    })
  })

  it('フロントマターが存在しなくても、見出しのレベルと名前を取り出す', async () => {
    await explains('フロントマターがないテンプレートの、`extractSectionsFromTemplate` のテストです。本文だけを渡した場合も、見出しのレベルと名前を取り出すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate('### セクション1\n内容\n#### セクション2\n内容\n')).toEqual([heading(3, 'セクション1'), heading(4, 'セクション2')])
    })
  })

  it('フロントマターの中の見出しは抽出しない', async () => {
    await explains('フロントマターの中に見出しの形の行がある場合のテストです。フロントマターの中の行は取り出さず、外にある見出しだけを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate('---\n## 中の見出し\n---\n## 外の見出し\n')).toEqual([heading(2, '外の見出し')])
    })
  })

  it('閉じていないフロントマターは全体を本文として読む', async () => {
    await explains('フロントマターが閉じていない場合のテストです。区切りの `---` で始まっていても、閉じていなければ全体を本文として読み、見出しを取り出すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate('---\n## 見出し\n')).toEqual([heading(2, '見出し')])
    })
  })

  it('本文中の --- 以降も本文として読む', async () => {
    await explains('本文の途中に `---` がある場合のテストです。フロントマターの後にある `---` は区切りとして扱わず、その前後の見出しをどちらも取り出すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate('---\na: b\n---\n## 一\n---\n## 二\n')).toEqual([heading(2, '一'), heading(2, '二')])
    })
  })

  it('CRLF の行末は見出し名に含めない', async () => {
    await explains('改行が CRLF の場合のテストです。行末の改行コードを見出しの名前に含めず、名前だけを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate('## 見出し\r\n')).toEqual([heading(2, '見出し')])
    })
  })

  it('冒頭の書き方ガイド（HTML コメント）の中の見出し行は抽出しない', async () => {
    await explains('冒頭に書き方の説明（HTML コメント）がある場合のテストです。コメントの中にある見出しの形の行は取り出さず、コメントの外の見出しだけを返すことを確認します。')
    const template = stepSync('雛形を用意する', () => `---\nissue_ref: ""\n---\n\n${COMMENT_OPEN}\n書き方:\n### 例の見出し — コメントの中\n-->\n\n### Done — <完了>\n`)
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate(template)).toEqual([heading(3, 'Done — <完了>')])
    })
  })

  it('# が 1 つの行や 7 つの行は、見出しとして取り出さない', async () => {
    await explains('見出しとして読まない行のテストです。`#` が 1 つの行、7 つの行、`#` の後ろに空白がない行を渡した場合に、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(extractSectionsFromTemplate('# 一\n####### 七\n##なし\n')).toEqual([])
    })
  })
})

describe('validateSections（必須セクション検証: 見出しレベル・em-dash サマリ）', () => {
  it('必須の見出しがすべて正しいレベルで存在すれば、空の配列を返す', async () => {
    await explains('必須の節を検証する `validateSections` のテストです。必須の見出しがすべて正しいレベルで本文にある場合は、空の配列を返すことを確認します。')
    const body = stepSync('本文を用意する', () => '\n### 完了した作業\n- タスク1\n\n### 現在の状態\n- 状態1\n')
    stepSync('結果を比べる', () => {
      expect(validateSections(body, [heading(3, '完了した作業'), heading(3, '現在の状態')])).toEqual([])
    })
  })

  it('必須の見出しが不足していると、レベルを付けて返す', async () => {
    await explains('本文に必須の見出しが不足している場合の、`validateSections` のテストです。不足している見出しを、`### 現在の状態` のようにレベルを付けた文字列で返すことを確認します。')
    const body = stepSync('本文を用意する', () => '\n### 完了した作業\n- タスク1\n')
    stepSync('結果を比べる', () => {
      expect(validateSections(body, [heading(3, '完了した作業'), heading(3, '現在の状態')])).toEqual(['### 現在の状態'])
    })
  })

  it('見出しのレベルが違う場合は、不足として検出する', async () => {
    await explains('見出しのレベルが異なる場合の、`validateSections` のテストです。同じ名前でも、レベルが期待と異なる見出しは、不足している見出しとして返すことを確認します。')
    const body = stepSync('本文を用意する', () => '\n## サマリー\nテスト\n\n## 完了した作業\n- タスク1\n')
    stepSync('結果を比べる', () => {
      // テンプレートでは ### (level 3) を期待、## があっても不足
      expect(validateSections(body, [heading(2, 'サマリー'), heading(3, '完了した作業')])).toEqual(['### 完了した作業'])
    })
  })

  it('最初の h2 も、ほかの見出しと同じく、テンプレートの名前で始まる必要がある', async () => {
    await explains('最初の `##` 見出しの名前のテストです。名前が一致する場合は空の配列を返し、一致しない場合は、その見出しを不足として返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateSections('\n## Summary\nテスト\n', [heading(2, 'Summary')])).toEqual([])
      expect(validateSections('\n## 何でもいい見出し\nテスト\n', [heading(2, 'Summary')])).toEqual(['## Summary'])
    })
  })

  it('最初の h2 が存在しなければ、その名前の見出しの不足として検出する', async () => {
    await explains('最初の `##` 見出しが存在しない場合の、`validateSections` のテストです。期待する名前の `## サマリー` を、不足している見出しとして返すことを確認します。')
    const body = stepSync('本文を用意する', () => '\n### 完了した作業\n- タスク1\n')
    stepSync('結果を比べる', () => {
      expect(validateSections(body, [heading(2, 'サマリー'), heading(3, '完了した作業')])).toContain('## サマリー')
    })
  })

  it('#### の見出しが存在すれば、不足なしで空の配列を返す', async () => {
    await explains('`####` の見出しの、`validateSections` のテストです。期待する見出しが本文にある場合は、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateSections('\n#### 残タスク\n- なし\n', [heading(4, '残タスク')])).toEqual([])
    })
  })

  it('h4 を期待している箇所に h3 があっても、不足として検出する', async () => {
    await explains('見出しのレベルが浅い場合の、`validateSections` のテストです。`####` を期待する見出しが `###` で書かれている場合に、不足として返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateSections('\n### 残タスク\n- なし\n', [heading(4, '残タスク')])).toEqual(['#### 残タスク'])
    })
  })

  it('レベルの違う見出しが並ぶ場合は、本文に存在しない見出しだけを不足として返す', async () => {
    await explains('レベルの異なる見出しが並ぶ場合のテストです。本文に存在する見出しは返さず、存在しない `#### 確認事項` だけを不足として返すことを確認します。')
    const body = stepSync('本文を用意する', () => '\n### 完了した作業\n- タスク1\n\n#### 残タスク\n- なし\n')
    stepSync('結果を比べる', () => {
      expect(validateSections(body, [heading(3, '完了した作業'), heading(4, '残タスク'), heading(4, '確認事項')])).toEqual(['#### 確認事項'])
    })
  })

  it('required_sections が空の場合は、空の配列を返す', async () => {
    await explains('必須の見出しを指定しない場合の、`validateSections` のテストです。必須の見出しが空のとき、どの本文でも空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateSections('テスト本文', [])).toEqual([])
    })
  })

  it('見出しの名前に特殊文字を含んでいても、不足なしで空の配列を返す', async () => {
    await explains('見出しの名前に `・` のような記号を含む場合の、`validateSections` のテストです。記号を含む名前でも、本文に存在すれば、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateSections('\n### 注意事項・コンテキスト\n- 内容\n', [heading(3, '注意事項・コンテキスト')])).toEqual([])
    })
  })

  it('正規表現の記号を含む節の名前は、文字どおりに比較する', async () => {
    await explains('節の名前に正規表現の記号を含む場合のテストです。`a.b (c)` の `.` を任意の 1 文字として扱わず、文字どおりに比較することを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateSections('### a.b (c)\n', [heading(3, 'a.b (c)')])).toEqual([])
      expect(validateSections('### axb (c)\n', [heading(3, 'a.b (c)')])).toEqual(['### a.b (c)'])
    })
  })

  it('節の名前の途中までしか一致しない見出しは、不足として扱う（em-dash の区切りが必須）', async () => {
    await explains('節の名前の途中までしか一致しない場合のテストです。`Verified` に別の文字が続く見出しは、`—` の区切りがないため、不足として返すことを確認します。')
    const result = stepSync('validateSections を呼ぶ', () => validateSections('## VerifiedExtra — まぎらわしい\n\n- aaa', [heading(2, 'Verified — <summary>')]))
    stepSync('結果を比べる', () => {
      expect(result).toEqual(['## Verified — <summary>'])
    })
  })

  it('テンプレートが em-dash の要約を宣言していれば、半角のハイフンは不足として扱う', async () => {
    await explains('区切りの文字のテストです。テンプレートが `—` で区切る見出しを期待する場合に、半角のハイフンで区切った見出しを不足として返すことを確認します。')
    const result = stepSync('validateSections を呼ぶ', () => validateSections('## Verified - テスト通過\n\n- aaa', [heading(2, 'Verified — <summary>')]))
    stepSync('結果を比べる', () => {
      expect(result).toEqual(['## Verified — <summary>'])
    })
  })

  it('見出しが存在すれば、要約の規則違反は不足に数えない（validateHeadingSummaries の担当）', async () => {
    await explains('要約の規則に違反する見出しの扱いのテストです。見出しが存在すれば、要約が長いなどの違反があっても、`validateSections` は不足として返さないことを確認します。')
    const over = stepSync('上限を超える要約を用意する', () => `${'a'.repeat(SUMMARY_MAX_CHARS + 1)}。b`)
    stepSync('結果を比べる', () => {
      expect(validateSections(`## Verified — ${over}`, [heading(2, 'Verified — <summary>')])).toEqual([])
    })
  })

  it('未編集のプレースホルダが残っていても、unedited placeholder を含むメッセージは返さない', async () => {
    await explains('未編集のプレースホルダが残っている場合の、`validateSections` のテストです。見出しの検証だけを行い、プレースホルダの検出のメッセージ（`unedited placeholder`）は返さないことを確認します。')
    const body = stepSync('本文を用意する', () => '## Verified — <何を検証したかを1行で>\n\n<details><summary>log</summary></details>')
    const result = stepSync('validateSections を呼ぶ', () => validateSections(body, [heading(2, 'Verified — <summary>')]))
    stepSync('結果を比べる', () => {
      expect(result.every(message => !message.includes('unedited placeholder'))).toBe(true)
    })
  })
})

describe('validateHeadingSummaries（em-dash サマリは 50 文字以内・日本語を含む 1 文 #1185）', () => {
  const required = [heading(2, 'Verified — <summary>')]

  it('要約が上限を超えると、文字数を付けて返す', async () => {
    await explains('見出しの要約を検証する `validateHeadingSummaries` のテストです。要約の文字数が上限を超える場合に、実際の文字数と上限を含むエラーを返すことを確認します。')
    const over = stepSync('上限を 1 字超える要約を用意する', () => 'あ'.repeat(SUMMARY_MAX_CHARS + 1))
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries(`## Verified — ${over}`, required)).toEqual([
        `## Verified — the summary is ${String(SUMMARY_MAX_CHARS + 1)} characters (limit: ${String(SUMMARY_MAX_CHARS)})`,
      ])
    })
  })

  it('文字数はコードポイントで数える', async () => {
    await explains('文字数の数え方のテストです。絵文字を含む要約の文字数を、コードポイントの数で数え、上限を超える場合だけエラーを返すことを確認します。')
    const emoji = stepSync('絵文字だけの要約を用意する', () => '\u{1F600}'.repeat(SUMMARY_MAX_CHARS))
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries(`## Verified — ${emoji}あ`, required)).toEqual([`## Verified — the summary is ${String(SUMMARY_MAX_CHARS + 1)} characters (limit: ${String(SUMMARY_MAX_CHARS)})`])
      expect(validateHeadingSummaries(`## Verified — ${'\u{1F600}'.repeat(SUMMARY_MAX_CHARS - 1)}あ`, required)).toEqual([])
    })
  })

  it('見出しが存在しなければ、何も返さない（不足は validateSections が返す）', async () => {
    await explains('要約の検証の対象外になる場合のテストです。期待する見出しが存在しない本文では、エラーを返さないことを確認します（見出しの不足は `validateSections` が扱います）。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries('## Verified - 通過', required)).toEqual([])
    })
  })

  it('em-dash を宣言しない見出しは、要約を検証しない', async () => {
    await explains('`—` を宣言しない見出しのテストです。要約を持たない見出しでは、要約の規則を検証せず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries('### Repro\n', [heading(3, 'Repro')])).toEqual([])
    })
  })

  it('ASCII だけの要約は、日本語を含まないとしてエラーを返す', async () => {
    await explains('要約の言語のテストです。日本語を含まない ASCII だけの要約について、日本語でないことを示すエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries('## Verified — all tests pass', required)).toEqual([`## Verified — ${SUMMARY_NOT_JAPANESE_ERROR}`])
    })
  })

  it('ASCII と日本語の両方を含む要約は、エラーにしない', async () => {
    await explains('要約の言語のテストです。バージョン番号などの ASCII と日本語が混在する要約は、エラーにせず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries('## Verified — v0.5.0 の公開', required)).toEqual([])
    })
  })

  it.each([
    ['々', 'noma'],
    ['テスト', 'katakana'],
    ['てすと', 'hiragana'],
    ['検証', 'kanji'],
    [String.fromCodePoint(0xFF_83, 0xFF_7D, 0xFF_84), 'halfwidth-kana'],
  ])('日本語の文字種として数える: %s（%s）', async (summary) => {
    await explains('日本語の文字種の判定のテストです。ひらがな・カタカナ・漢字・半角カナ・繰り返し記号のどれか 1 種類だけでも、日本語を含む要約として、エラーにしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries(`## Verified — ${summary}`, required)).toEqual([])
    })
  })

  it('要約が 2 文なら、複数の文を示すエラーを返す', async () => {
    await explains('要約の文の数のテストです。句点で区切った 2 文の要約について、1 文でないことを示すエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries('## Verified — 通過した。残りなし', required)).toEqual([`## Verified — ${SUMMARY_MULTI_SENTENCE_ERROR}`])
    })
  })

  it.each(['！', '？', '!', '?'])('途中に文末記号 %s があっても、2 文として扱いエラーにする', async (mark) => {
    await explains('文末記号の種類のテストです。全角と半角の感嘆符・疑問符が要約の途中にある場合も、2 文として扱い、エラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries(`## Verified — 完了${mark} 次へ`, required)).toEqual([`## Verified — ${SUMMARY_MULTI_SENTENCE_ERROR}`])
    })
  })

  it('半角 . は文末に数えない（v1.2 のような表記があるため）', async () => {
    await explains('半角のピリオドの扱いのテストです。`v1.2` のようなバージョンの表記があるため、半角のピリオドは文末に数えず、エラーにしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries('## Verified — v1.2 を公開', required)).toEqual([])
    })
  })

  it('末尾の句点は、エラーにしない', async () => {
    await explains('末尾の句点のテストです。要約の最後に句点が 1 つだけある場合は、1 文として扱い、エラーにしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries('## Verified — 全件通過した。', required)).toEqual([])
    })
  })

  it.each(['「完了。」', '（全件通過した。）', `『完了${String.fromCodePoint(0xFF_01)}』`])('閉じ括弧の前の文末は、末尾の括弧を除いて判定する: %s', async (summary) => {
    await explains('括弧で囲んだ要約のテストです。閉じ括弧の直前に句点や感嘆符がある場合は、末尾の括弧を除いて判定し、1 文として、エラーにしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries(`## Verified — ${summary}`, required)).toEqual([])
    })
  })

  it('文字数と文の数の違反が重なるときは、同じ見出しについてすべて返す', async () => {
    await explains('違反が複数ある場合のテストです。文字数の超過と複数の文が重なる要約について、2 件のエラーを、同じ見出しに対して順に返すことを確認します。')
    const summary = stepSync('上限ちょうどの要約を用意する', () => `${'あ'.repeat(SUMMARY_MAX_CHARS - 1)}。いい`)
    stepSync('結果を比べる', () => {
      expect(validateHeadingSummaries(`## Verified — ${summary}`, required)).toEqual([
        `## Verified — the summary is ${String(splitCodePoints(summary).length)} characters (limit: ${String(SUMMARY_MAX_CHARS)})`,
        `## Verified — ${SUMMARY_MULTI_SENTENCE_ERROR}`,
      ])
    })
  })

  it('em-dash を宣言しない最初の h2 は、名前が前方一致するかだけを確認する', async () => {
    await explains('`—` を宣言しない最初の `##` 見出しのテストです。`## Release v1` のように名前の後ろに文字が続いても、前方一致だけを見て、エラーにしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateSections('## Release v1', [heading(2, 'Release')])).toEqual([])
      expect(validateHeadingSummaries('## Release v1', [heading(2, 'Release')])).toEqual([])
    })
  })
})

describe('validateBodyStyle: チェックボックス記法（#962）', () => {
  it('未チェックのチェックボックスは、書式のエラーにする', async () => {
    await explains('本文の書式を検証する `validateBodyStyle` のテストです。未チェックのチェックボックス記法（`- [ ]`）を含む本文について、`checkbox syntax` のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('## Progress — テスト\n\n- [ ] やること\n').some(message => message.includes('checkbox syntax'))).toBe(true)
    })
  })

  it('チェック済みのチェックボックスは、書式のエラーにする', async () => {
    await explains('チェックボックス記法を検出する `validateBodyStyle` のテストです。チェック済みの記法（`- [x]`）を含む本文について、`checkbox syntax` のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- [x] 完了\n').some(message => message.includes('checkbox syntax'))).toBe(true)
    })
  })

  it('* と + の箇条書きのチェックボックスも、書式のエラーにする', async () => {
    await explains('箇条書きの記号の種類のテストです。`*` や `+` で始まるチェックボックス記法も、`checkbox syntax` のエラーとして検出することを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('* [ ] a\n').some(message => message.includes('checkbox syntax'))).toBe(true)
      expect(validateBodyStyle('+ [X] a\n').some(message => message.includes('checkbox syntax'))).toBe(true)
    })
  })

  it.each(['1. [ ] a', '2) [x] b', '10. [X] c'])('番号付きリストのチェックボックスは、書式のエラーにする: %s', async (line) => {
    await explains('番号付きリストのチェックボックスのテストです。`1. [ ]` や `2) [x]` の形でも、チェックボックスとして扱い、チェックボックスのエラーだけを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`${line}\n`)).toEqual([CHECKBOX_ERROR])
    })
  })

  it('番号付きリストのリンクは、チェックボックスとして扱わない', async () => {
    await explains('リンクを誤検出しないことのテストです。番号付きリストの項目が `[x](url)` のリンクの場合は、チェックボックスとして扱わず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('1. [x](https://example.com/x) を参照\n')).toEqual([])
    })
  })

  it('`- [x](url)` のようなリンク項目は誤検知しない', async () => {
    await explains('リンクを誤検出しないことのテストです。箇条書きの項目が `- [x](url)` のようなリンクの場合は、チェックボックスとして扱わず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- [x](https://example.com/x) を参照\n- [ref](https://example.com/r) も参照\n')).toEqual([])
    })
  })

  it.each(['> - [ ] x', '> > * [x] y', '- - [ ] z', '>- [ ] w'])('引用や入れ子のリストの中のタスクリストも、書式のエラーにする: %s', async (line) => {
    await explains('引用や入れ子のリストのテストです。`> - [ ] x` のように、引用やリストの中にあるチェックボックスも、同じエラーとして返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`${line}\n`)).toEqual([CHECKBOX_ERROR])
    })
  })

  it('引用の中のリンクの項目は、チェックボックスとして扱わない', async () => {
    await explains('引用の中のリンクのテストです。引用の中にある `- [x](url)` はチェックボックスではないため、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('> - [x](https://example.com/x) を参照\n')).toEqual([])
    })
  })

  it('複数行あっても、チェックボックスの報告は 1 件にまとめる', async () => {
    await explains('チェックボックスが複数行にある場合のテストです。何行あっても、`checkbox syntax` の報告は 1 件にまとめることを確認します。')
    const messages = stepSync('validateBodyStyle を呼ぶ', () => validateBodyStyle('- [ ] a\n- [ ] b\n- [x] c\n'))
    stepSync('結果を比べる', () => {
      expect(messages.filter(message => message.includes('checkbox syntax'))).toHaveLength(1)
    })
  })
})

describe('validateBodyStyle: コードフェンス・インラインコード・HTML コメントのマスク（#962）', () => {
  it('コードフェンスの中身は、検証の対象にしない', async () => {
    await explains('コードフェンスの扱いのテストです。フェンスの中にあるチェックボックスや未編集のプレースホルダは、検証の対象にせず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('## Verified — テスト\n\n```markdown\n- [ ] やること\n<未編集>\n```\n')).toEqual([])
    })
  })

  it('チルダで囲んだコードフェンスも、検証の対象にしない', async () => {
    await explains('`~~~` で囲んだコードフェンスのテストです。バッククォートのフェンスと同じように、中身を検証の対象にしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('~~~\n- [ ] やること\n~~~\n')).toEqual([])
    })
  })

  it('リストの項目の下にある字下げされたフェンスも、中身を検証の対象にしない', async () => {
    await explains('リストの項目の下にあるコードフェンスのテストです。字下げされたフェンスでも、中身を検証の対象にしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- 手順\n\n  ```bash\n  - [ ] not a task\n  echo \'<未編集>\'\n  ```\n\n- 次\n')).toEqual([])
    })
  })

  it('開きより長い閉じのフェンスでも、閉じたものとして扱う', async () => {
    await explains('フェンスの長さのテストです。開きのフェンスより長い閉じのフェンスでも、フェンスを閉じたものとして扱い、中身を検証の対象にしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('```\n- [ ] a\n````\n\n本文\n')).toEqual([])
    })
  })

  it('閉じていないコードフェンスは、エラーにする（フェンス以降の検証の回避を防ぐ）', async () => {
    await explains('閉じていないコードフェンスのテストです。検証を通さず、`code fence is not closed` のエラーを返し、フェンス以降の検証を回避できないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('```bash\necho hi\n\n- [ ] やること\n')).toEqual(['code fence is not closed'])
    })
  })

  it('インラインコードは、検証の対象にしない', async () => {
    await explains('インラインコードのテストです。バッククォートで囲んだ部分にある記法やプレースホルダは、検証の対象にしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- 記法 `- [ ]` を使わない\n- 型は `<T>` と書く\n')).toEqual([])
    })
  })

  it('二重のバッククォートで囲んだコードは、検証の対象にしない', async () => {
    await explains('二重のバッククォートで囲んだインラインコードのテストです。中にバッククォートがあっても、全体をコードとして扱い、検証の対象にしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- ``<`未編集`>`` はコード\n')).toEqual([])
    })
  })

  it('長さの違うランでは閉じない（`` で開いたスパンは ` では閉じない）', async () => {
    await explains('インラインコードを閉じる条件のテストです。開きと閉じのバッククォートの数が異なる場合は閉じたとみなさず、続く部分も含めて、コードとして扱うことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- ``a` <未編集> ``b\n')).toEqual([])
    })
  })

  it('閉じ忘れたバッククォートより後のプレースホルダは、見逃さない', async () => {
    await explains('バッククォートを閉じ忘れた場合のテストです。閉じ忘れより後ろにある未編集のプレースホルダを、コードとして扱わず、検出することを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- `途中で閉じ忘れ <未編集>\n').some(message => message.includes('<未編集>'))).toBe(true)
    })
  })

  it('HTML コメントは、検証の対象にしない', async () => {
    await explains('HTML コメントのテストです。コメントの中にある記法やプレースホルダは、検証の対象にしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`本文\n\n${COMMENT_OPEN} 生成元: pecot quick / <未編集> / - [ ] -->\n`)).toEqual([])
    })
  })

  it('複数行の HTML コメントも、検証の対象にしない', async () => {
    await explains('複数行にわたる HTML コメントのテストです。コメントの中にある記法やプレースホルダは、行をまたいでも、検証の対象にしないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`本文\n\n${COMMENT_OPEN}\n書き方:\n- [ ] は使わない\n<プレースホルダ>\n-->\n\n続き\n`)).toEqual([])
    })
  })
})

describe('validateBodyStyle: 未編集プレースホルダの検出と正当な `<...>` の通過（#962）', () => {
  it('日本語のプレースホルダは、書式のエラーにする', async () => {
    await explains('未編集のプレースホルダの検出のテストです。`<観測できる状態>` のように、日本語を山括弧で囲んだ文字列が残っている場合に、そのトークンを含むエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- **<観測できる状態>** — 確認: 手動\n').some(message => message.includes('<観測できる状態>'))).toBe(true)
    })
  })

  it('HTML タグ形状に見える ASCII 語のプレースホルダも通さない', async () => {
    await explains('HTML のタグに見える ASCII の語のテストです。`<short-sha>` のように、タグの形をした未編集のプレースホルダも、見逃さずに検出することを確認します。')
    stepSync('結果を比べる', () => {
      for (const token of ['<short-sha>', '<NNN-feature>']) {
        expect(validateBodyStyle(`- 参照: ${token}\n`).some(message => message.includes(token))).toBe(true)
      }
    })
  })

  it('`<OS 等>` のような ASCII 語 + 空白 + 日本語も通さない', async () => {
    await explains('ASCII の語と空白と日本語が並ぶプレースホルダのテストです。`<OS 等>` のような形も、見逃さずに検出することを確認します。')
    stepSync('結果を比べる', () => {
      for (const token of ['<OS 等>', '<AS-IS と TO-BE の差を 1 文で>', '<Step 4 の結果を1行で>']) {
        expect(validateBodyStyle(`- 環境: ${token}\n`).some(message => message.includes(token))).toBe(true)
      }
    })
  })

  it('型・メタ表記は素で書くと落ちる（バッククォートで囲む運用）', async () => {
    await explains('型の表記を素で書いた場合のテストです。`list<T>` のようにバッククォートで囲まない型の表記は、プレースホルダとして検出することを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- list<T> を返す\n').some(message => message.includes('<T>'))).toBe(true)
    })
  })

  it('許可された HTML タグは通す', async () => {
    await explains('許可された HTML タグのテストです。`details`・`summary`・`br`・`kbd`・`a`・`img` のタグは、プレースホルダとして扱わず、空の配列を返すことを確認します。')
    const body = stepSync('本文を用意する', () => `<details><summary>ログ</summary>\n\n本文<br>続き\n\n</details>\n<kbd>Ctrl</kbd> と <a href="${QUERY_URL}">リンク</a>\n<img src="https://example.com/i.png" alt="図" />\n`)
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(body)).toEqual([])
    })
  })

  it('autolink は通す', async () => {
    await explains('自動リンクのテストです。`<https://…>` や `<user@example.com>` の形は、プレースホルダではないため、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('<https://ghes.example.com/acme-labs/aist-plugin/issues/962>\n<user@example.com>\n')).toEqual([])
    })
  })

  it('`<` の直後が英字でないトークンは比較・バージョン表現として通す', async () => {
    await explains('`<0.0.0` のように、`<` の直後が英字でない記述のテストです。比較やバージョンの表現として扱い、プレースホルダとして検出しないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('engines "<0.0.0" + engine-strict の <0.0.0> と 応答 <1s> を確認\n')).toEqual([])
    })
  })

  it('CHANGELOG を転記した本文（リリースの PR の Changes の節）は、誤検出しない', async () => {
    await explains('CHANGELOG を転記した本文のテストです。リリースの PR の Changes の節にあるバージョンの範囲の表記を、プレースホルダとして誤検出しないことを確認します。')
    const body = stepSync('本文を用意する', () => '## Changes — リリース内容\n\n'
      + '- pecotv 全 package に **engines "<0.0.0" + engine-strict** で npm / yarn 混入を block し、\n'
      + '  repo root には逆方向に **pnpm / yarn を block**（npm の既定の流れは温存）するガードを追加。\n')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(body)).toEqual([])
    })
  })

  it('見出しのプレースホルダは、見出しのものと明示してエラーにする', async () => {
    await explains('見出しに残ったプレースホルダのテストです。エラーのメッセージで、見出しのプレースホルダであることを示し、`details` などの正当なタグは含めないことを確認します。')
    const body = stepSync('本文を用意する', () => '## Verified — <何を検証したかを1行で>\n\n<details><summary>log</summary></details>')
    const result = stepSync('validateBodyStyle を呼ぶ', () => validateBodyStyle(body))
    stepSync('結果を比べる', () => {
      expect(result.some(message => message.includes('heading') && message.startsWith('unedited placeholder'))).toBe(true)
      expect(result.every(message => !message.includes('details'))).toBe(true)
    })
  })

  it('`<#<issue番号> <タイトル>>` のような入れ子も中のトークンを拾う', async () => {
    await explains('山括弧が入れ子になったプレースホルダのテストです。外側だけでなく、内側の `<issue番号>` と `<タイトル>` も、別々に検出することを確認します。')
    const result = stepSync('validateBodyStyle を呼ぶ', () => validateBodyStyle('## Merge — <#<issue番号> <タイトル> のサマリ>\n'))
    stepSync('結果を比べる', () => {
      expect(result.some(message => message.includes('<issue番号>'))).toBe(true)
      expect(result.some(message => message.includes('<タイトル>'))).toBe(true)
    })
  })

  it('`<` を閉じ忘れても、次の行以降を検証の対象から外さない', async () => {
    await explains('`<` を閉じ忘れた場合のテストです。閉じていない `<` が次の行以降を巻き込まず、ほかの行を誤検出しないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('行1 < 未閉じ\n\n行2 > 続き\n')).toEqual([])
    })
  })

  it('同じトークンは、1 件だけ報告する', async () => {
    await explains('同じプレースホルダが複数ある場合のテストです。同じトークンが何度出ても、エラーは 1 件だけ返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- **<観測できる状態>** — a\n- **<観測できる状態>** — b\n')).toHaveLength(1)
    })
  })

  it('問題のない本文は、エラーにしない', async () => {
    await explains('問題のない本文のテストです。節・要約・箇条書き・コードを含む、正しい書式の本文について、空の配列を返すことを確認します。')
    const body = stepSync('本文を用意する', () => '## Verified — テスト通過\n\n'
      + 'pytest を全件流した。\n\n'
      + '- **単体テスト** — `run-tests.sh --scope=py` が 0 exit\n\n'
      + '## Risks — なし\n\n'
      + '- **影響範囲** — なし\n')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(body)).toEqual([])
    })
  })
})

describe('validateBodyStyle: 水平線（#1185）', () => {
  it.each(['---', '***', '___', '- - -', ' * * * ', '-----'])('水平線は不可: %j', async (line) => {
    await explains('水平線の検出のテストです。`---`・`***`・`___`・空白を挟んだ形などの水平線を含む本文について、水平線のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`本文\n\n${line}\n\n続き\n`)).toEqual([HORIZONTAL_RULE_ERROR])
    })
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
  ])('引用・リストの中の水平線とタブ区切りの水平線も不可: %j（%s）', async (line) => {
    await explains('引用やリストの中にある水平線のテストです。`> ---` や `- ***` のような形と、タブで区切った水平線も、エラーとして返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`本文\n\n${line}\n\n続き\n`)).toEqual([HORIZONTAL_RULE_ERROR])
    })
  })

  it.each(['- 項目', '> 引用文', '- -- の扱い', '> | a | b |'])('普通の引用・リスト行は通る: %j', async (line) => {
    await explains('水平線ではない引用とリストのテストです。普通の項目や引用の行、`> | a | b |` のような表の行は、水平線として扱わず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`${line}\n`)).toEqual([])
    })
  })

  it.each(['<hr>', '<hr/>', '<hr />', '<HR>'])('%s は、プレースホルダではなく水平線として、エラーにする', async (tag) => {
    await explains('`<hr>` タグのテストです。`<hr/>` や大文字の `<HR>` も含め、プレースホルダではなく水平線として、水平線のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`本文\n\n${tag}\n`)).toEqual([HORIZONTAL_RULE_ERROR])
    })
  })

  it('表の区切り行は通る', async () => {
    await explains('表の区切り行のテストです。`|---|---|` の形の行は、水平線として扱わず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('| Expected | Actual |\n|---|---|\n| a | b |\n')).toEqual([])
    })
  })

  it('フェンスの中の水平線は通る', async () => {
    await explains('コードフェンスの中の水平線のテストです。フェンスの中にある `---` は、水平線として扱わず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('```yaml\n---\ntitle: x\n---\n```\n')).toEqual([])
    })
  })

  it('フェンスの中の引用された水平線は通る', async () => {
    await explains('コードフェンスの中の、引用やリストの形をした水平線のテストです。フェンスの中にある `> ---` や `- ***` は、検証の対象にせず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('```markdown\n> ---\n- ***\n> - [ ] x\n```\n')).toEqual([])
    })
  })

  it('引用された表の区切り行は通る', async () => {
    await explains('引用された表の区切り行のテストです。`> |---|---|` の形の行は、水平線として扱わず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('> | a | b |\n> |---|---|\n> | 1 | 2 |\n')).toEqual([])
    })
  })

  it('インラインコードと HTML コメントの中の水平線は通る', async () => {
    await explains('インラインコードと HTML コメントの中の水平線のテストです。バッククォートで囲んだ `---` と、コメントの中の `---` は、水平線として扱わないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`- 記法 \`---\` は使わない\n\n${COMMENT_OPEN}\n---\n-->\n`)).toEqual([])
    })
  })

  it.each([
    '**`targets.json`**',
    '***`x`***',
    '__`x`__',
    '> **`x`**',
    '- ***`x`***',
    '> - __`x`__',
    '*** <!-- c -->',
  ])('強調で包んだインラインコードや末尾の HTML コメントは水平線にならない: %j', async (line) => {
    await explains('強調で包んだインラインコードの行のテストです。アスタリスクやアンダースコアが並んで見える行や、末尾に HTML コメントが付いた行は、水平線として扱わず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`${line}\n`)).toEqual([])
    })
  })

  it('強調で包んだインラインコードのすぐ次の行の ---（setext の下線）は、水平線として扱いエラーにする', async () => {
    await explains('見出しの下線（setext）の形のテストです。強調で包んだインラインコードの次の行にある `---` は、水平線として、エラーに含めることを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('**`x`**\n---\n')).toContain(HORIZONTAL_RULE_ERROR)
    })
  })

  it('4 スペース以上のインデントは CommonMark では水平線にならない', async () => {
    await explains('字下げされた水平線のテストです。CommonMark では、4 つ以上の空白で字下げした `---` は水平線にならないため、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('    ---\n')).toEqual([])
    })
  })

  it('何度出ても 1 件だけ報告する', async () => {
    await explains('水平線を何度も書いた場合のテストです。`---`・`***`・`<hr>` が混在していても、エラーは 1 件だけ返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('---\n\n***\n\n<hr>\n')).toEqual([HORIZONTAL_RULE_ERROR])
    })
  })
})

describe('validateBodyStyle: 絵文字（#1185）', () => {
  it.each(['⚠', '✓', '★', '→', '✗'])('テキスト表示の記号は、絵文字として扱わない: %s', async (text) => {
    await explains('テキスト表示の記号のテストです。`✓` や `→` のように、絵文字として描画されない記号は、エラーにせず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`- ${text} 注意点\n`)).toEqual([])
    })
  })

  it.each([
    ['✅', 'check-mark-button'],
    ['❌', 'cross-mark'],
    ['⚠️', 'warning-with-vs16'],
    ['🚀', 'rocket'],
    ['⭐', 'star'],
  ])('絵文字は不可: %s（%s）', async (text) => {
    await explains('絵文字の検出のテストです。`✅` や `🚀` など、絵文字として描画される文字を含む本文について、絵文字のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`- ${text} 完了\n`)).toEqual([EMOJI_ERROR])
    })
  })

  it.each(['㊗', '㊙'])('Emoji_Presentation が Yes の U+3297 と U+3299 は、絵文字としてエラーにする: %s', async (text) => {
    await explains('絵文字としての表示が既定の文字のテストです。`㊗` と `㊙` を含む本文について、絵文字のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`${text} 祝\n`)).toEqual([EMOJI_ERROR])
    })
  })

  it.each([':white_check_mark:', ':thumbsup:', ':rocket:', ':100_a:'])('GitHub が絵文字として描画するショートコードは不可: %s', async (text) => {
    await explains('絵文字のショートコードのテストです。`:rocket:` のように、GitHub が絵文字として描画する書き方を含む本文について、絵文字のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`- ${text} 完了\n`)).toEqual([EMOJI_ERROR])
    })
  })

  it.each([
    ['10:30:00 に実行', 'time'],
    ['比率 1:2:3', 'ratio'],
    ['https://example.com/a:b', 'url'],
    ['`:rocket:` は使わない', 'inline-code'],
  ])('ショートコードでないコロンは通る: %s（%s）', async (text) => {
    await explains('コロンを含むが、ショートコードではない記述のテストです。時刻・比率・URL・インラインコードの中の `:rocket:` は、絵文字として扱わず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(`- ${text}\n`)).toEqual([])
    })
  })

  it('見出しの中の絵文字は不可', async () => {
    await explains('見出しの中の絵文字のテストです。見出しに絵文字がある場合も、絵文字のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('## Verified — 🎉 全件通過\n')).toEqual([EMOJI_ERROR])
    })
  })

  it('コードの中の絵文字は通る', async () => {
    await explains('コードの中の絵文字のテストです。インラインコードとコードフェンスの中の絵文字は、検証の対象にせず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- `✅` は使わない\n\n```\n🚀\n```\n')).toEqual([])
    })
  })

  it('何度出ても 1 件だけ報告する', async () => {
    await explains('絵文字が複数ある場合のテストです。何個あっても、絵文字のエラーは 1 件だけ返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle('- ✅ a\n- ❌ b\n')).toEqual([EMOJI_ERROR])
    })
  })
})

describe('validateBodyStyle: 記法違反が複数あるとき全種を 1 件ずつ返す', () => {
  it('複数の規則に違反しても、すべてを決まった順で 1 件ずつ報告する', async () => {
    await explains('複数の規則に違反する本文のテストです。チェックボックス・水平線・絵文字・未編集のプレースホルダの 4 種類を、決まった順に 1 件ずつ返すことを確認します。')
    const body = stepSync('本文を用意する', () => '## Progress — 途中\n\n1. [ ] a\n\n---\n\n- ✅ b\n- <未編集>\n')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(body)).toEqual([
        CHECKBOX_ERROR,
        HORIZONTAL_RULE_ERROR,
        EMOJI_ERROR,
        'unedited placeholder <未編集> remains',
      ])
    })
  })
})

describe('validateFoldBalance（折りたたみ <details> の開閉の対応 #1330）', () => {
  const unclosed = ['<details> is not closed']
  const noOpening = ['<details> has no matching opening tag']

  it('テンプレートごとの閉じる見出しの表は、plan だけを持ち、Notes を含む', async () => {
    await explains('テンプレートごとの閉じる見出しを持つ定数 `CLOSED_HEADINGS_BY_TEMPLATE` のテストです。対象が `plan` のテンプレートだけで、その見出しに `Notes` が含まれることを確認します。')
    stepSync('結果を比べる', () => {
      expect(new Set(CLOSED_HEADINGS_BY_TEMPLATE.keys())).toEqual(new Set(['plan']))
      expect(CLOSED_HEADINGS_BY_TEMPLATE.get('plan')).toContain('Notes')
    })
  })

  it('対応した開閉は通る', async () => {
    await explains('折りたたみ（`details`）の開閉の対応を検証する `validateFoldBalance` のテストです。開きと閉じが対応している本文について、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('短い\n\n<details>\n<summary>要約</summary>\n\n本文\n\n</details>\n')).toEqual([])
    })
  })

  it('折りたたみの外の文字数は、数えない', async () => {
    await explains('折りたたみの外の本文のテストです。折りたたみがない長い本文でも、文字数を理由にしたエラーは返さず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('あ'.repeat(20_000))).toEqual([])
    })
  })

  it('閉じられていない details があるとき、閉じられていない旨のエラーを返す', async () => {
    await explains('閉じられていない `details` のテストです。閉じタグがない場合に、`<details> is not closed` のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance(`<details>\n${'x'.repeat(500)}`)).toEqual(unclosed)
    })
  })

  it('閉じタグだけがあると、対応する開きタグが存在しない旨のエラーを返す', async () => {
    await explains('開きタグがない場合の、`validateFoldBalance` のテストです。閉じタグだけがある本文について、対応する開きタグがない旨のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('本文\n</details>\n')).toEqual(noOpening)
    })
  })

  it('文字と同じ行に閉じタグだけがあるとき、対応する開きタグが無い旨のエラーを返す', async () => {
    await explains('文字と同じ行にある閉じタグのテストです。`a</details>` のように、行の途中にある閉じタグも、対応する開きタグがない旨のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('a</details>')).toEqual(noOpening)
    })
  })

  it('閉じタグが開きタグより前にあるとき、対応する開きタグが無い旨のエラーを返す', async () => {
    await explains('閉じタグが開きタグより前にある場合のテストです。順序が逆の `</details>` と `<details>` について、対応する開きタグがない旨のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('</details>\n<details>\n')).toEqual(noOpening)
    })
  })

  it('本文が空のとき、空配列を返す', async () => {
    await explains('本文が空の場合の、`validateFoldBalance` のテストです。空の本文を渡したとき、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('')).toEqual([])
    })
  })

  it('details が入れ子で、すべて閉じられているとき、空配列を返す', async () => {
    await explains('入れ子の `details` のテストです。入れ子がすべて閉じられている場合に、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('<details>\n<details>\n内\n</details>\n</details>\n')).toEqual([])
    })
  })

  it('入れ子の外側の details が閉じられていないと、閉じられていない旨のエラーを返す', async () => {
    await explains('入れ子の外側が閉じられていない場合のテストです。内側だけが閉じられた本文について、閉じられていない旨のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('<details>\n<details>\n内\n</details>\n')).toEqual(unclosed)
    })
  })

  it('リスト項目の中の details が閉じられているとき、空配列を返す', async () => {
    await explains('リストの項目の中にある `details` のテストです。項目の中で開閉が対応している場合に、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('- <details>\n  本文\n  </details>\n')).toEqual([])
    })
  })

  it('属性付きや大文字の details でも、閉じられていれば空配列を返す', async () => {
    await explains('属性が付いた `details` と、大文字の `DETAILS` のテストです。どちらも閉じられていれば、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('<details open>\nx\n</details>')).toEqual([])
      expect(validateFoldBalance('<DETAILS>\nx\n</DETAILS>')).toEqual([])
    })
  })

  it.each([
    ['fenced_code', '```html\n<details>\n```\n'],
    ['inline_code', '`<details>`'],
    ['html_comment', `${COMMENT_OPEN} <details> -->\n`],
  ])('マスクされた領域の中の details は折りたたみではない: %s', async (_name, body) => {
    await explains('コード領域の中の `details` のテストです。コードフェンス・インラインコード・HTML コメントの中にある `<details>` は、折りたたみとして数えず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance(body)).toEqual([])
    })
  })

  it('他のタグ（summary など）は、折りたたみの開閉として数えない', async () => {
    await explains('他のタグの扱いのテストです。`<summary>` だけがある本文は、`details` の開閉の対象ではないため、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('<summary>x</summary>')).toEqual([])
    })
  })

  it('閉じていないコードフェンスは、validateBodyStyle に任せる', async () => {
    await explains('閉じていないコードフェンスの扱いのテストです。フェンスの後ろの `<details>` は検証せず、空の配列を返し、フェンスのエラーは `validateBodyStyle` に任せることを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldBalance('```\n<details>\n')).toEqual([])
    })
  })
})

describe('validateClosedHeadings（テンプレに無い ## / ### 見出し #1330）', () => {
  const sections = [
    heading(2, 'Plan — <概要>'),
    heading(3, 'Context — <背景>'),
    heading(3, 'Notes — <メモ>'),
    heading(2, 'PECOT-Workflow — <構成>'),
  ]

  it('テンプレートの見出しは、エラーにしない', async () => {
    await explains('未知の見出しを検出する `validateClosedHeadings` のテストです。本文の `##` と `###` の見出しがすべてテンプレートの見出しと一致する場合は、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings('## Plan — 計画\n\n### Context — 背景\n\n### Notes — なし\n\n## PECOT-Workflow — 構成\n', sections)).toEqual([])
    })
  })

  it('テンプレートにない見出しは、レベルを付けて返す', async () => {
    await explains('テンプレートにない見出しのテストです。テンプレートにない `###` と `##` の見出しを、レベルを付けた文字列で、現れた順に返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings('## Plan — 計画\n\n### Context — 背景\n\n### Risks — 懸念\n\n## Goal\n', sections)).toEqual(['### Risks', '## Goal'])
    })
  })

  it('同じ見出しは 1 回だけ返す', async () => {
    await explains('同じ見出しが複数ある場合のテストです。テンプレートにない見出しが、要約だけを変えて 2 回現れても、1 件だけ返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings('### Risks — a\n\n### Risks — b\n', sections)).toEqual(['### Risks'])
    })
  })

  it('レベルが違えば、テンプレートにない見出しとして扱う', async () => {
    await explains('レベルが異なる見出しのテストです。名前が同じでもレベルが違う見出しは、テンプレートにない見出しとして返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings('### Plan — 計画\n\n## Context — 背景\n', sections)).toEqual(['### Plan', '## Context'])
    })
  })

  it('要約のない見出しは、全体を名前として扱う', async () => {
    await explains('要約を持たない見出しのテストです。`—` の区切りがない見出しは、見出し全体を名前として、テンプレートの見出しと比較することを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings('### Steps\n', sections)).toEqual(['### Steps'])
    })
  })

  it('h1 と h4 以下の見出しは、制限しない', async () => {
    await explains('制限の対象となるレベルのテストです。`#` と `####` 以下の見出しは、テンプレートにない名前でも、返さないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings('# タイトル\n\n#### CUJ 1\n\n##### 細部\n', sections)).toEqual([])
    })
  })

  it('details の中の見出しも見る', async () => {
    await explains('折りたたみの中の見出しのテストです。`details` の中にある、テンプレートにない見出しも、返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings('<details>\n<summary>x</summary>\n\n### Steps — 手順\n\n</details>\n', sections)).toEqual(['### Steps'])
    })
  })

  it.each([
    ['fenced_code', '```markdown\n### Steps — 例\n```\n'],
    ['html_comment', `${COMMENT_OPEN}\n### Steps — 例\n-->\n`],
    ['inline_code', '`### Steps`\n'],
  ])('マスクされた領域の中の見出しは見ない: %s', async (_name, body) => {
    await explains('コード領域の中の見出しのテストです。コードフェンス・HTML コメント・インラインコードの中にある見出しの形の文字列は、見出しとして扱わないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings(body, sections)).toEqual([])
    })
  })

  it('閉じていないコードフェンスは、validateBodyStyle に任せる', async () => {
    await explains('閉じていないコードフェンスの扱いのテストです。フェンス以降の見出しは検証せず、空の配列を返し、フェンスのエラーは `validateBodyStyle` に任せることを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateClosedHeadings('```\n### Steps\n', sections)).toEqual([])
    })
  })
})

function fold(summary: string): string {
  return `<details>\n${summary}\n\n本文\n\n</details>\n`
}

function failure(summary: string): string {
  return `${summary} must be ${PLAN_FOLD_SUMMARY}`
}

describe('validateFoldSummaries（折りたたみの開閉部分 <summary> の形 #1299）', () => {
  it('折りたたみの summary の表は、plan だけに、右寄せの「詳細はこちら」を割り当てる', async () => {
    await explains('折りたたみの要約の定数 `FOLD_SUMMARY_BY_TEMPLATE` のテストです。`plan` のテンプレートだけに、右寄せの「詳細はこちら」の `summary` が割り当てられていることを確認します。')
    stepSync('結果を比べる', () => {
      expect(FOLD_SUMMARY_BY_TEMPLATE).toEqual(new Map([['plan', PLAN_FOLD_SUMMARY]]))
      expect(PLAN_FOLD_SUMMARY).toBe('<summary align="right">詳細はこちら</summary>')
    })
  })

  it('期待する形の summary は、エラーにしない', async () => {
    await explains('折りたたみの要約を検証する `validateFoldSummaries` のテストです。期待する形の `summary` を持つ折りたたみについて、リストの項目の中も含めて、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldSummaries(`${fold(PLAN_FOLD_SUMMARY)}\n- ${fold(PLAN_FOLD_SUMMARY)}`, PLAN_FOLD_SUMMARY)).toEqual([])
    })
  })

  it('summary のない本文は、エラーにしない', async () => {
    await explains('`summary` を持たない本文のテストです。折りたたみがない本文について、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldSummaries('本文だけ\n', PLAN_FOLD_SUMMARY)).toEqual([])
    })
  })

  it.each([
    '<summary>詳細はこちら</summary>',
    '<summary align="right">理由</summary>',
    '<summary align="center">詳細はこちら</summary>',
    '<summary align="right"><b>詳細はこちら</b></summary>',
  ])('他の形は不可: %s', async (summary) => {
    await explains('期待と異なる形の `summary` のテストです。`align` の値や文言が異なる場合や、タグを追加した場合に、その `summary` を含むエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldSummaries(fold(summary), PLAN_FOLD_SUMMARY)).toEqual([failure(summary)])
    })
  })

  it('複数行に分けた summary は不可', async () => {
    await explains('`summary` を複数行で書いたときのテストです。開きタグ・文言・閉じタグが別の行にある場合は、開きタグの行を含むエラーを返すことを確認します。')
    const body = stepSync('本文を用意する', () => '<details>\n<summary align="right">\n詳細はこちら\n</summary>\n\n本文\n\n</details>\n')
    stepSync('結果を比べる', () => {
      expect(validateFoldSummaries(body, PLAN_FOLD_SUMMARY)).toEqual([failure('<summary align="right">')])
    })
  })

  it('同じ違反は 1 件だけ報告する', async () => {
    await explains('同じ違反が複数ある場合のテストです。同じ形の誤った `summary` が 2 回現れても、エラーは 1 件だけ返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldSummaries(fold('<summary>理由</summary>').repeat(2), PLAN_FOLD_SUMMARY)).toEqual([failure('<summary>理由</summary>')])
    })
  })

  it.each([
    '```html\n<summary>理由</summary>\n```\n',
    '`<summary>理由</summary>` の形は使わない\n',
    `${COMMENT_OPEN} <summary>理由</summary> -->\n`,
  ])('コードとコメントの中は対象外: %j', async (body) => {
    await explains('コードとコメントの中の `summary` のテストです。フェンス・インラインコード・HTML コメントの中にある `summary` は、検証の対象にせず、空の配列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldSummaries(body, PLAN_FOLD_SUMMARY)).toEqual([])
    })
  })

  it('閉じていないコードフェンスは、validateBodyStyle に任せる', async () => {
    await explains('閉じていないコードフェンスの扱いのテストです。フェンスの後ろの `summary` は検証せず、空の配列を返し、フェンスのエラーは `validateBodyStyle` に任せることを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateFoldSummaries('```\n<summary>理由</summary>', PLAN_FOLD_SUMMARY)).toEqual([])
    })
  })
})

describe('validateBodyStyle: 段落の中の改行（GitHub は改行のまま表示する）', () => {
  it.each([
    ['段落', '1 文目。\n2 文目。\n'],
    ['行末のインラインコード', '文 `code`\n続き\n'],
    ['引用', '> 引用の 1 文目。\n> 引用の 2 文目。\n'],
  ])('%s の中の改行は、エラーにする', async (_name, body) => {
    await explains('段落の中の改行を検出する `validateBodyStyle` のテストです。段落・行末がインラインコードの行・引用の中で、文の途中に改行がある場合に、改行のエラーを返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(body)).toContain(SOFT_BREAK_ERROR)
    })
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
  ])('%s は、改行のエラーにしない', async (_name, body) => {
    await explains('改行のエラーにならない場合のテストです。つなげた段落・箇条書き・表・見出し・コードフェンス・折りたたみ・明示の改行などでは、改行のエラーを返さないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(validateBodyStyle(body)).not.toContain(SOFT_BREAK_ERROR)
    })
  })
})

describe('hasSummaryImage', () => {
  const image = '![shot](./a.png)'

  it.each([
    ['Markdown の画像', `## Summary — 要点\n\n${image}\n\n## Changes\n\nなし\n`],
    ['参照形式の画像', '## Summary\n\n![shot][ref]\n'],
    ['代替文に角括弧を含む画像', '## Summary\n\n![a [b] c](./a.png)\n'],
    ['img タグ', '## Summary\n\n<IMG src="a.png">\n'],
    ['先頭に空白 3 つまでの見出し', `   ## Summary\n\n${image}\n`],
    ['Summary より後ろの節の画像ではなく Summary の中', `## Summary\n\n${image}\n\n## Changes\n\n${image}\n`],
  ])('%s があれば、真を返す', async (_name, body) => {
    await explains('Summary の節の画像を判定する `hasSummaryImage` のテストです。Markdown の画像・参照形式の画像・`img` タグなどが節の中にある場合は、真を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(hasSummaryImage(body)).toBe(true)
    })
  })

  it.each([
    ['画像の無い Summary', '## Summary — 要点\n\n本文。\n\n## Changes\n\nなし\n'],
    ['Summary の見出しが無い', `## Changes\n\n${image}\n`],
    ['URL が空の画像', '## Summary\n\n![a]()\n'],
    ['参照形式の閉じ角括弧が無い', '## Summary\n\n![x]\n'],
    ['リンク', '## Summary\n\n[x](./x.png)\n'],
    ['別の節の画像', `## Summary\n\n本文\n\n## Changes\n\n${image}\n`],
    ['見出しの下に ## だけの行がある', `## Summary\n\n##\n\n${image}\n`],
    ['空白 4 つの見出しは別の節の終わりにならないが Summary でもない', `    ## Summary\n\n${image}\n`],
    ['フェンスの中', `## Summary\n\n\`\`\`\n${image}\n\`\`\`\n`],
    ['インラインコードの中', `## Summary\n\n\`${image}\`\n`],
    ['HTML コメントの中', `## Summary\n\n<!-- ${image} -->\n`],
    ['img に続く英数字', '## Summary\n\n<imgx src="a.png">\n'],
  ])('%s の場合は、偽を返す', async (_name, body) => {
    await explains('`hasSummaryImage` が偽を返す場合のテストです。画像がない場合や、Summary の外・コードの中・コメントの中にある画像、リンクだけの場合に、偽を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(hasSummaryImage(body)).toBe(false)
    })
  })

  it('Summary の次の 1 段目の見出しで節が終わる', async () => {
    await explains('Summary の節の終わりのテストです。次のレベル 1 の見出しで節が終わり、その後の画像は Summary の画像に数えないことを確認します。')
    stepSync('結果を比べる', () => {
      expect(hasSummaryImage(`## Summary\n\n# 題\n\n${image}\n`)).toBe(false)
    })
  })
})

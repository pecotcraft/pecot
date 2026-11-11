// テンプレート由来の必須セクション抽出・検証。
//
// `--prepare` が配る雛形の見出し構成を基準に、投稿本文が雛形どおりに編集されているかを判定する。
// issue / comment / pr の 3 コマンドが同じ厳しさで検証するよう、抽出器と検証器をここに集約する（#958 F-03）。
// テンプレートのファイルを読む関数は infra/template-store.ts が持つ。
//
// 正規表現は Python の CLI のものを写している。違いが出やすい点は次のとおり。
//   - 行頭と行末の区切りは `\n` だけにする。JS の m フラグは `\r` や U+2028 でも区切る
//   - `.` が `\r` や U+2028 を含むかは、s フラグで揃える
//   - 文字数と位置はコードポイントで数える（絵文字で数がずれない）

import { stripLeadingHtmlComment } from './frontmatter.js'
import { pythonStrip, splitCodePoints } from './python-format.js'

export interface SectionHeading {
  readonly level: number
  /**
  見出しの文字列。em-dash サマリ込み（例: `Progress — <現在地を1行で>`）
  */
  readonly name: string
}

// 見出しの em-dash 一行サマリの上限文字数
export const SUMMARY_MAX_CHARS = 50

// 折りたたみの開閉部分（<summary>）に許す唯一の形。文言を揃え、開閉部分を右寄せにする
// （GitHub は style / class を除去するため、残る align 属性で寄せる）。テンプレ名ごとに検証を掛ける
export const PLAN_FOLD_SUMMARY = '<summary align="right">詳細はこちら</summary>'
export const FOLD_SUMMARY_BY_TEMPLATE: ReadonlyMap<string, string> = new Map([['plan', PLAN_FOLD_SUMMARY]])

/**
テンプレに無い `##` / `###` 見出しを拒否するテンプレ名と、拒否したときに添える案内文。
テンプレごとに閉じた見出しの集合を持たせる。
Python の `issue.py` の `_report_template_violations` は、この Map にテンプレ名があるときだけ 2 つの検証を掛ける。
掛ける検証は validateFoldBalance と validateClosedHeadings。コマンドを移すときは同じ条件にする
*/
export const CLOSED_HEADINGS_BY_TEMPLATE: ReadonlyMap<string, string> = new Map([['plan', 'put content that fits no other heading under ### Notes']])

// 検証エラー文。テンプレの規約ブロックとの対応をテンプレートの単体テストが固定する
export const CHECKBOX_ERROR = 'checkbox syntax (- [ ] / 1. [ ]) is not allowed'
export const HORIZONTAL_RULE_ERROR = 'horizontal rules are not allowed'
export const EMOJI_ERROR = 'emoji are not allowed'
export const SOFT_BREAK_ERROR = 'a paragraph is broken across lines: GitHub shows line breaks as written, so write each paragraph on one line and separate paragraphs with a blank line'
export const SUMMARY_NOT_JAPANESE_ERROR = 'the summary must be written in Japanese'
export const SUMMARY_MULTI_SENTENCE_ERROR = 'the summary must be one sentence'

// GitHub が Markdown 描画時にサニタイズせず通す HTML タグのうち、投稿本文で実際に使うもの。
// この一覧に無いタグ形状の <...> は未編集プレースホルダ扱い（`<T>` のような型・メタ表記はバッククォートで囲んで書く）。
const ALLOWED_HTML_TAGS: ReadonlySet<string> = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'details', 'div', 'em', 'i', 'img', 'kbd', 'li', 'ol', 'p', 'pre', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'td', 'th', 'tr', 'ul',
])

const HTML_COMMENT_PATTERN = /<!--.*?-->/gsu

const CHECKBOX_PATTERN = /^\s*(?:[*+-]|\p{Nd}+[).])\s+\[[ X]\](?:\s|$)/iu
// 水平線（thematic break）。setext 見出しの下線 `---` も同じ形で弾く（テンプレは ATX 見出しのみ）。
// CommonMark は区切りにタブも許す
// eslint-disable-next-line security/detect-unsafe-regex -- 行ごとに当てる。繰り返す群は同じ記号 1 文字と空白だけで、再試行は行の長さに比例して増えない
const THEMATIC_BREAK_PATTERN = /^ {0,3}([*_-])(?:[\t ]*\1){2,}[\t ]*$/u
// 引用（`>`）とリストマーカーの接頭辞。剥がした残りにも水平線・タスクリスト判定を当てる
const BLOCKQUOTE_PREFIX_PATTERN = /^[\t ]*>[\t ]?/u
const LIST_MARKER_PREFIX_PATTERN = /^[\t ]*(?:[*+-]|\p{Nd}+[).])[\t ]+/u
// 絵文字ショートコード（`:white_check_mark:` 等）。英字を含むものだけ（`10:30:00` は通す）
const EMOJI_SHORTCODE_PATTERN = /:[-\d+_]*[a-z][-\d+_a-z]*:/u
// サマリの日本語判定: ひらがな・カタカナ・CJK 統合漢字・々・半角カナ
const JAPANESE_CHARACTER_RANGES: readonly (readonly [number, number])[] = [
  [0x30_40, 0x30_9F], [0x30_A0, 0x30_FF], [0x4E_00, 0x9F_FF], [0x30_05, 0x30_05], [0xFF_66, 0xFF_9F],
]
const HEADING_PATTERN = /^(#{2,6})\s/u
// `<...>` トークン。改行を跨がせない（閉じ忘れで本文全体を飲み込むのを防ぐ）
const TOKEN_PATTERN = /<[^\n<>]+>/gu
// eslint-disable-next-line security/detect-unsafe-regex -- `<...>` 1 トークンに当てる。トークンは改行・山括弧を含まない
const HTML_TAG_PATTERN = /^<\/?([A-Za-z][\dA-Za-z-]*)(?:\s[^<>]*)?\/?>$/u
const AUTOLINK_URI_PATTERN = /^<[A-Za-z][\d+.A-Za-z-]*:\/\/[^\s<>]*>$/u
const AUTOLINK_EMAIL_PATTERN = /^<[^\s<>@]+@[^\s<>]+>$/u

// Emoji_Presentation=Yes の BMP 文字。
// 出典: Unicode 15.1 emoji-data.txt（Date: 2023-02-01）の Emoji_Presentation 行のうち U+1F000 未満。
// `⚠` `✓` `★` `→` `✗` は Emoji_Presentation=No なので含めない（U+FE0F を伴えば絵文字扱い）
const EMOJI_PRESENTATION_BMP_RANGES: readonly (readonly [number, number])[] = [
  [0x23_1A, 0x23_1B], [0x23_E9, 0x23_EC], [0x23_F0, 0x23_F0], [0x23_F3, 0x23_F3], [0x25_FD, 0x25_FE],
  [0x26_14, 0x26_15], [0x26_48, 0x26_53], [0x26_7F, 0x26_7F], [0x26_93, 0x26_93], [0x26_A1, 0x26_A1],
  [0x26_AA, 0x26_AB], [0x26_BD, 0x26_BE], [0x26_C4, 0x26_C5], [0x26_CE, 0x26_CE], [0x26_D4, 0x26_D4],
  [0x26_EA, 0x26_EA], [0x26_F2, 0x26_F3], [0x26_F5, 0x26_F5], [0x26_FA, 0x26_FA], [0x26_FD, 0x26_FD],
  [0x27_05, 0x27_05], [0x27_0A, 0x27_0B], [0x27_28, 0x27_28], [0x27_4C, 0x27_4C], [0x27_4E, 0x27_4E],
  [0x27_53, 0x27_55], [0x27_57, 0x27_57], [0x27_95, 0x27_97], [0x27_B0, 0x27_B0], [0x27_BF, 0x27_BF],
  [0x2B_1B, 0x2B_1C], [0x2B_50, 0x2B_50], [0x2B_55, 0x2B_55], [0x32_97, 0x32_97], [0x32_99, 0x32_99],
]

// 絵文字面（Mahjong / Domino / Playing Cards から Symbols and Pictographs Extended-A まで）。
// この範囲にある非絵文字ブロック（Enclosed Alphanumeric Supplement 等）も意図して弾く。
// 本文で使う場面が無く、範囲指定を単純に保つため。
const EMOJI_PLANE_FIRST = 0x1_F0_00
const EMOJI_PLANE_LAST = 0x1_FA_FF
// 異体字セレクタ 16（直前の文字を絵文字表示にする）
const EMOJI_VARIATION_SELECTOR = 0xFE_0F
// 文の区切り。半角 `.` は `v1.2` のような表記があるため含めない
const SENTENCE_END_CHARACTERS: ReadonlySet<string> = new Set(splitCodePoints('。！？!?'))
// 1 文判定の前にサマリ末尾から除く閉じ括弧類（`「完了。」` を 1 文として扱う）
const CLOSING_BRACKETS: ReadonlySet<string> = new Set(splitCodePoints('」』）】〕〉》］｝"\'”’)]}'))

// 抽出

// `##`〜`######` の後に空白が続き、その後に文字が 1 つ以上ある行を見出しとして読む
// （空白だけが続く行は、空白が 2 文字以上のときだけ名前が空の見出しになる）
function parseTemplateHeading(line: string): SectionHeading | undefined {
  const level = /^#*/u.exec(line)?.[0].length ?? 0
  if (level < 2 || level > 6) return undefined
  const afterHashes = line.slice(level)
  const text = afterHashes.trimStart()
  const whitespaceLength = afterHashes.length - text.length
  return whitespaceLength === 0 || (text === '' && whitespaceLength < 2) ? undefined : { level, name: pythonStrip(text) }
}

/**
テンプレートの内容から見出しセクションを抽出する（レベル情報付き）。
フロントマター（先頭の `---` と次の `---` の間）と、その後ろの先頭の HTML コメント（書き方ガイド）は読み飛ばし、`##`〜`######` で始まる行を拾う
*/
export function extractSectionsFromTemplate(template: string): readonly SectionHeading[] {
  let body = template
  if (template.startsWith('---')) {
    const second = template.indexOf('---', 3)
    if (second !== -1) body = template.slice(second + 3)
  }
  body = stripLeadingHtmlComment(body)
  const sections: SectionHeading[] = []
  for (const line of body.split('\n')) {
    const heading = parseTemplateHeading(line)
    if (heading !== undefined) sections.push(heading)
  }
  return sections
}

// 見出しの検索

function escapeRegularExpression(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`)
}

// 本文の中で、行頭から始まる見出しを探す。`^` は直前が改行か本文の先頭の位置
function findHeading(body: string, pattern: string): RegExpExecArray | null {
  // eslint-disable-next-line security/detect-non-literal-regexp -- 見出しの文字列は escape 済み
  return new RegExp(String.raw`(?<![^\n])${pattern}`, 'u').exec(body)
}

function findEmDashHeading(body: string, prefix: string, base: string): RegExpExecArray | null {
  return findHeading(body, String.raw`${escapeRegularExpression(prefix)}\s+${escapeRegularExpression(base)}\s+—\s+(\S[^\n]*)`)
}

const EM_DASH_SEPARATOR = ' — '

function baseOf(name: string): string {
  return name.split(EM_DASH_SEPARATOR, 1)[0] ?? name
}

/**
必須セクションの存在を確認する（見出しレベルも検証）。不足している見出しの表記を返す（例: `### Done — <summary>`）。
em-dash 付きの見出しは「ベース名 + em-dash + サマリ」の形があるかだけを見る。
サマリの規則（文字数・日本語・1 文）は validateHeadingSummaries が、未編集の `<...>` の残存は validateBodyStyle が見る（#962）。
それ以外の見出しはセクション名の前方一致をチェックする
*/
export function validateSections(body: string, requiredSections: readonly SectionHeading[]): readonly string[] {
  const missing: string[] = []

  for (const { level, name } of requiredSections) {
    const prefix = '#'.repeat(level)

    // em-dash 付きのテンプレ見出しは「ベース名 + em-dash + サマリ」を要求
    if (name.includes(EM_DASH_SEPARATOR)) {
      const base = baseOf(name)
      if (findEmDashHeading(body, prefix, base) === null) missing.push(`${prefix} ${base} — <summary>`)
      continue
    }

    // それ以外は前方一致チェック（セクション名で始まればよい）
    if (findHeading(body, String.raw`${escapeRegularExpression(prefix)}\s+${escapeRegularExpression(name)}`) === null) missing.push(`${prefix} ${name}`)
  }
  return missing
}

function isJapaneseCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return JAPANESE_CHARACTER_RANGES.some(([first, last]) => code >= first && code <= last)
}

// em-dash サマリの規則違反（文字数・日本語・1 文）を返す
function summaryErrors(summary: string): readonly string[] {
  const errors: string[] = []
  const characters = splitCodePoints(summary)
  if (characters.length > SUMMARY_MAX_CHARS) errors.push(`the summary is ${String(characters.length)} characters (limit: ${String(SUMMARY_MAX_CHARS)})`)
  if (characters.every(character => !isJapaneseCharacter(character))) errors.push(SUMMARY_NOT_JAPANESE_ERROR)
  let end = characters.length
  while (end > 0 && CLOSING_BRACKETS.has(characters[end - 1] ?? '')) end -= 1
  if (characters.slice(0, Math.max(end - 1, 0)).some(character => SENTENCE_END_CHARACTERS.has(character))) errors.push(SUMMARY_MULTI_SENTENCE_ERROR)
  return errors
}

/**
em-dash 見出しのサマリが規則を満たすか確認し、違反の表記を返す。
規則は文字数・日本語・1 文である
（例: `## Verified — the summary must be written in Japanese`）。
見出し自体が無いものは validateSections が不足として返すため、ここでは扱わない
*/
export function validateHeadingSummaries(body: string, requiredSections: readonly SectionHeading[]): readonly string[] {
  const errors: string[] = []
  for (const { level, name } of requiredSections) {
    if (!name.includes(EM_DASH_SEPARATOR)) continue
    const prefix = '#'.repeat(level)
    const base = baseOf(name)
    const found = findEmDashHeading(body, prefix, base)
    if (found === null) continue
    const summary = pythonStrip(found[1] ?? '')
    errors.push(...summaryErrors(summary).map(message => `${prefix} ${base} — ${message}`))
  }
  return errors
}

// マスク

function isClosingFence(line: string, character: string, length: number): boolean {
  const trimmed = line.replace(/^[\t ]+/u, '').replace(/[\t ]+$/u, '')
  const characters = splitCodePoints(trimmed)
  return characters.length >= length && characters.every(item => item === character)
}

interface OpeningFence {
  readonly character: string
  readonly length: number
  readonly info: string
}

// 行頭の空白（スペース・タブ）の後に、同じ文字（` か ~）が 3 つ以上続く行を、開始フェンスとして読む
function parseOpeningFence(line: string): OpeningFence | undefined {
  const rest = line.replace(/^[\t ]+/u, '')
  const character = rest.charAt(0)
  if (character !== '`' && character !== '~') return undefined
  let length = 0
  while (rest.charAt(length) === character) length += 1
  return length < 3 ? undefined : { character, length, info: rest.slice(length) }
}

interface MaskedFences {
  readonly lines: readonly string[]
  readonly hasUnclosedFence: boolean
}

// フェンスコードブロックの中身を空行に置き換える。
// 開始フェンスはリスト配下のインデントを許し、閉じフェンスは開始と同じ文字で同じ長さ以上のものを探す（インデントは問わない）
function maskFencedCode(body: string): MaskedFences {
  const lines: string[] = []
  let fenceCharacter = ''
  let fenceLength = 0

  for (const line of body.split('\n')) {
    if (fenceCharacter === '') {
      const fence = parseOpeningFence(line)
      // バッククォートのフェンスは info string にバッククォートを含められない（その形はインラインコードのラン）
      if (fence !== undefined && !(fence.character === '`' && fence.info.includes('`'))) {
        fenceCharacter = fence.character
        fenceLength = fence.length
        lines.push('')
        continue
      }
      lines.push(line)
      continue
    }

    lines.push('')
    if (!isClosingFence(line, fenceCharacter, fenceLength)) {
      continue
    }

    fenceCharacter = ''
    fenceLength = 0
  }
  return { lines, hasUnclosedFence: fenceCharacter !== '' }
}

interface BacktickRun {
  readonly start: number
  readonly end: number
}

// from 以降で最初のバッククォートの連続を探す
function findBacktickRun(line: string, from: number): BacktickRun | undefined {
  const start = line.indexOf('`', from)
  if (start === -1) return undefined
  let end = start
  while (line.charAt(end) === '`') end += 1
  return { start, end }
}

// opener と同じ長さのバッククォートの連続を、opener の後ろから探す
function findCloser(line: string, opener: BacktickRun): BacktickRun | undefined {
  const runLength = opener.end - opener.start
  let candidate = findBacktickRun(line, opener.end)
  while (candidate !== undefined && candidate.end - candidate.start !== runLength) candidate = findBacktickRun(line, candidate.end)
  return candidate
}

// インラインコードスパンを同じ長さの fill（既定は空白）へ置換する。
// CommonMark のバッククォート・ラン規則（同じ長さのランで閉じる）に従い、`` `- [ ]` `` や二重バッククォートのスパンを検証対象から外す。
// 閉じランが同一行に無い場合は暴走を避けてマスクしない
function maskInlineCode(line: string, fill = ' '): string {
  let result = ''
  let position = 0

  for (;;) {
    const opener = findBacktickRun(line, position)
    if (opener === undefined) return result + line.slice(position)

    const closer = findCloser(line, opener)
    if (closer === undefined) {
      result += line.slice(position, opener.end)
      position = opener.end
      continue
    }

    result += line.slice(position, opener.start) + fill.repeat(closer.end - opener.start)
    position = closer.end
  }
}

// フェンス・インラインコード・HTML コメントの中身を消した行リストを返す。
// フェンス内の行は空文字になり、インラインコードと HTML コメントは同じ長さの fill になる（改行は残す）。
// 水平線の判定だけ fill に '`' を使う（`**`x`**` の外側の `**` を空白にすると水平線に見えるため）
function maskedLines(body: string, fill = ' '): MaskedFences {
  const { lines, hasUnclosedFence } = maskFencedCode(body)
  const masked = lines.map(line => maskInlineCode(line, fill)).join('\n')
    .replaceAll(HTML_COMMENT_PATTERN, comment => comment.replaceAll(/[^\n]/g, () => fill))
  return { lines: masked.split('\n'), hasUnclosedFence }
}

// 記法の判定

interface TokenMatch {
  readonly text: string
  readonly index: number
}

// 行の中の `<...>` トークンを、出てくる順に返す
function tokensIn(line: string): readonly TokenMatch[] {
  const tokens: TokenMatch[] = Array.from(line.matchAll(TOKEN_PATTERN), match => ({ text: match[0], index: match.index }))
  return tokens
}

function isHorizontalRuleTag(token: string): boolean {
  const tag = HTML_TAG_PATTERN.exec(token)
  return tag !== null && (tag[1] ?? '').toLowerCase() === 'hr'
}

// 行頭の引用 `>` とリストマーカーを 1 段ずつ剥がした行を、元の行から順に返す。
// `> ---`・`- ***`・`> - [ ] x` のように引用・リストの中に置いた水平線とタスクリストも GitHub は描画するため、剥がした各段で判定する。
// `- - -` のように剥がすと崩れる形があるため、剥がす前の行も残す
function containerVariants(line: string): readonly string[] {
  const variants = [line]
  let current = line
  for (;;) {
    const match = BLOCKQUOTE_PREFIX_PATTERN.exec(current) ?? LIST_MARKER_PREFIX_PATTERN.exec(current)
    if (match === null) return variants
    current = current.slice(match[0].length)
    variants.push(current)
  }
}

function hasCheckbox(line: string): boolean {
  return containerVariants(line).some(variant => CHECKBOX_PATTERN.test(variant))
}

// 水平線の行か、`<hr>` タグを含むか
function hasHorizontalRule(line: string): boolean {
  return containerVariants(line).some(variant => THEMATIC_BREAK_PATTERN.test(variant)) || tokensIn(line).some(token => isHorizontalRuleTag(token.text))
}

function isEmojiPresentationBmp(code: number): boolean {
  return EMOJI_PRESENTATION_BMP_RANGES.some(([first, last]) => code >= first && code <= last)
}

// 絵文字面の文字・Emoji_Presentation の BMP 文字・U+FE0F 付きの文字・ショートコードを含むか
function hasEmoji(line: string): boolean {
  if (EMOJI_SHORTCODE_PATTERN.test(line)) return true
  return splitCodePoints(line).some((character, index) => {
    const code = character.codePointAt(0) ?? 0
    return (code >= EMOJI_PLANE_FIRST && code <= EMOJI_PLANE_LAST) || isEmojiPresentationBmp(code) || (code === EMOJI_VARIATION_SELECTOR && index > 0)
  })
}

// `<...>` トークンが正当な記法（HTML タグ / autolink / 比較表記）か
function isAllowedToken(token: string): boolean {
  // `<hr>` は水平線規則（hasHorizontalRule）が担当するため、ここでは許可扱い
  if (isHorizontalRuleTag(token)) return true
  // `<0.0.0>` `<1s>` のような比較・バージョン表現は候補から外す
  const head = String.fromCodePoint(token.codePointAt(1) ?? 0)
  if (!(head === '/' || head === '!' || /^\p{L}$/u.test(head))) return true

  const tag = HTML_TAG_PATTERN.exec(token)
  const isAllowedTag = tag !== null && ALLOWED_HTML_TAGS.has((tag[1] ?? '').toLowerCase())
  return isAllowedTag || AUTOLINK_URI_PATTERN.test(token) || AUTOLINK_EMAIL_PATTERN.test(token)
}

/**
投稿本文に使えない記法が残っていないかを判定する（#962）。
チェックボックス記法・水平線・絵文字・未編集プレースホルダ `<...>` を検出し、エラーメッセージを返す（問題がなければ空）。
コードフェンス・インラインコード・HTML コメントの中身は対象外（型・比較・メタ表記はバッククォートで囲めば通る）
*/
// 段落の続きと見なさない行の頭（見出し・リスト・表・引用・HTML タグ・画像・字下げ）
const NON_PARAGRAPH_LINE_PATTERN = /^(?:#{1,6}\s|\s*(?:[-*+]|\d+[.)])\s|\s*\||\s*>|\s*<|\s*!\[|\s{2,}\S)/

// 引用の行頭（`>` の段を剥がして、引用の中の段落も同じく判定する）と、GitHub の引用の種類の行（`[!WARNING]`）
const QUOTE_PREFIX_PATTERN = /^\s*>\s?/
const ALERT_MARKER_PATTERN = /^\[![A-Z]+\]\s*$/

function isParagraphLine(line: string): boolean {
  return line.trim() !== '' && !NON_PARAGRAPH_LINE_PATTERN.test(line)
}

/**
行頭の `>` の段数と、剥がした後の本文
*/
function quoteLevelAndText(line: string): readonly [number, string] {
  let level = 0
  let rest = line
  for (let match = QUOTE_PREFIX_PATTERN.exec(rest); match !== null; match = QUOTE_PREFIX_PATTERN.exec(rest)) {
    level += 1
    rest = rest.slice(match[0].length)
  }
  return [level, rest]
}

/**
同じ段の引用（段数 0 は地の文）の中で、地の文の行が続いているか
*/
function isContinuedParagraph(previous: string, line: string): boolean {
  const [previousLevel, previousText] = quoteLevelAndText(previous)
  const [level, text] = quoteLevelAndText(line)
  return previousLevel === level && !ALERT_MARKER_PATTERN.test(previousText.trim()) && isParagraphLine(previousText) && isParagraphLine(text)
}

/**
地の文の行を 2 行続けた段落があるか。
行の種類はマスク済みの行で判定し、行末の明示の改行（空白 2 つか `\\`）は元の行で判定する（インラインコードは空白に置き換わるため、マスク済みの行末では取り違える）
*/
function hasSoftBreak(maskedLines: readonly string[], originalLines: readonly string[]): boolean {
  return maskedLines.some((line, index) => {
    const previous = maskedLines[index - 1]
    const originalPrevious = originalLines[index - 1] ?? ''
    return previous !== undefined && isContinuedParagraph(previous, line) && !originalPrevious.endsWith('  ') && !originalPrevious.endsWith('\\')
  })
}

export function validateBodyStyle(body: string): readonly string[] {
  const { lines, hasUnclosedFence } = maskedLines(body)
  // 何も言わずに通すとフェンス以降が丸ごと未検証になる（検証バイパス）
  if (hasUnclosedFence) return ['code fence is not closed']

  const errors: string[] = []
  const ruleLines = maskedLines(body, '`').lines
  const lineRules: readonly (readonly [string, (line: string) => boolean, readonly string[]])[] = [
    [CHECKBOX_ERROR, hasCheckbox, lines],
    [HORIZONTAL_RULE_ERROR, hasHorizontalRule, ruleLines],
    [EMOJI_ERROR, hasEmoji, lines],
  ]
  for (const [message, matches, target] of lineRules) {
    if (target.some(line => matches(line))) errors.push(message)
  }
  if (hasSoftBreak(lines, body.split('\n'))) errors.push(SOFT_BREAK_ERROR)

  const seen = new Set<string>()
  for (const line of lines) {
    const heading = HEADING_PATTERN.exec(line)
    for (const { text: token } of tokensIn(line)) {
      if (isAllowedToken(token)) continue
      const message = heading === null ? `unedited placeholder ${token} remains` : `unedited placeholder ${token} remains in the ${heading[1] ?? ''} heading`
      if (seen.has(message)) continue
      seen.add(message)
      errors.push(message)
    }
  }
  return errors
}

// 折りたたみ

/**
折りたたみ（`<details>`）の開閉が対応しているかを判定する。
コードフェンス・インラインコード・HTML コメントの中の `<details>` は折りたたみとして扱わない。
閉じられていない開きタグ、開きの無い閉じタグをエラーにする。折りたたみの外の文字数は見ない。
未閉じのコードフェンスは空リストを返す（validateBodyStyle が別に出す）
*/
export function validateFoldBalance(body: string): readonly string[] {
  const { lines, hasUnclosedFence } = maskedLines(body)
  if (hasUnclosedFence) return []

  let depth = 0
  for (const maskedLine of lines) {
    for (const match of tokensIn(maskedLine)) {
      const tag = HTML_TAG_PATTERN.exec(match.text)
      if (tag === null || (tag[1] ?? '').toLowerCase() !== 'details') continue
      depth += match.text.startsWith('</') ? -1 : 1
      if (depth < 0) return ['<details> has no matching opening tag']
    }
  }
  return depth === 0 ? [] : ['<details> is not closed']
}

/**
テンプレに無い `##` / `###` 見出しが本文に無いかを判定する。
`(level, 名前)` の組で比べる。名前は em-dash の前の部分で、サマリは見ない。
コードフェンス・インラインコード・HTML コメントの中の見出しは対象外で、`<details>` の中の見出しは対象にする。
h1 と h4 以下は縛らない。テンプレに無い見出しの表記を返す（例: `## Context`）。同じ見出しは 1 回だけ返す
*/
export function validateClosedHeadings(body: string, requiredSections: readonly SectionHeading[]): readonly string[] {
  const allowed = new Set(requiredSections.map(({ level, name }) => `${String(level)}\0${pythonStrip(baseOf(name))}`))
  const { lines, hasUnclosedFence } = maskedLines(body)
  if (hasUnclosedFence) return []

  const extra: string[] = []
  for (const line of lines) {
    const heading = parseTemplateHeading(line)
    if (heading === undefined || heading.level > 3) continue
    const name = pythonStrip(baseOf(heading.name))
    if (allowed.has(`${String(heading.level)}\0${name}`)) continue
    const label = `${'#'.repeat(heading.level)} ${name}`
    if (!extra.includes(label)) extra.push(label)
  }
  return extra
}

/**
折りたたみの開閉部分（`<summary>`）が全て expected の形かを判定する。
コードフェンス・インラインコード・HTML コメントの中の `<summary>` は対象外。
開きタグの位置から expected と一字一句一致するかを見るため、属性・文言・閉じタグのどれが違っても違反になる
*/
export function validateFoldSummaries(body: string, expected: string): readonly string[] {
  const { lines, hasUnclosedFence } = maskedLines(body)
  if (hasUnclosedFence) return []

  const errors: string[] = []
  for (const maskedLine of lines) {
    for (const match of tokensIn(maskedLine)) {
      const token = match.text
      const tag = HTML_TAG_PATTERN.exec(token)
      if (tag === null || (tag[1] ?? '').toLowerCase() !== 'summary' || token.startsWith('</') || maskedLine.startsWith(expected, match.index)) continue
      const message = `${pythonStrip(maskedLine)} must be ${expected}`
      if (!errors.includes(message)) errors.push(message)
    }
  }
  return errors
}

const SUMMARY_HEADING_PATTERN = /^ {0,3}##\s+Summary(?:\s|$)/u
const LEVEL_1_OR_2_HEADING_PATTERN = /^ {0,3}#{1,2}(?:\s|$)/u
const IMAGE_ALT = String.raw`(?:[^[\]]|\[[^[\]]*\])*`
// eslint-disable-next-line security/detect-non-literal-regexp -- 固定の文字列から組み立てる。代替文は角括弧の入れ子 1 段までで、再試行は入力の長さに比例して増えない
const IMAGE_PATTERN = new RegExp(String.raw`!\[${IMAGE_ALT}\]\([^)]+\)|!\[${IMAGE_ALT}\]\[[^\]]*\]|<img(?![\p{L}\p{N}_])`, 'iu')

/**
Summary 節に画像の参照（Markdown 記法か `<img`）があるか。
フェンス・インラインコード・HTML コメントの中は数えない。記法の網羅は目的ではなく、取りこぼしは screenshot の理由で避けられる
*/
export function hasSummaryImage(body: string): boolean {
  const { lines } = maskedLines(body)
  const start = lines.findIndex(line => SUMMARY_HEADING_PATTERN.test(line))
  if (start === -1) return false
  const section: string[] = []
  const following = lines.slice(start + 1)
  for (const line of following) {
    if (LEVEL_1_OR_2_HEADING_PATTERN.test(line)) break
    section.push(line)
  }
  return IMAGE_PATTERN.test(section.join('\n'))
}

export function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

export function isFullWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df)
  );
}

// 全角文字: 1, 半角文字: 0.7、合計を切り上げて、全角に換算した文字数を求める
export function fullWidthEquivalent(text: string): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }

  let total = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;
    total += isFullWidth(codePoint) ? 1 : 0.7;
  }

  return Math.ceil(total);
}

// 太字強調は <strong> のみを認める（テンプレートの強調規範を <strong> に一本化しており <b> は不可）。
// 属性付き・大文字タグは許容し、中身が空の <strong></strong> は強調とみなさない。
const STRONG_TAG_PATTERN = /<strong(?:\s[^>]*)?>([\s\S]*?)<\/strong\s*>/gi;

export const BOLD_REQUIRED_MESSAGE =
  'no bold emphasis on the key point (fix: wrap only the key point in <strong>…</strong>; wrapping the whole text is not emphasis; <b> and Markdown ** are not allowed)';

// 全文が strong に覆われていると強調の対比が消えるため、強調とみなさない。
// 複数の strong で分割して全文を覆うケースも同じ扱いにする。
export function hasBoldEmphasis(text: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }

  let emphasized = '';
  for (const match of text.matchAll(STRONG_TAG_PATTERN)) {
    emphasized += stripHtmlTags(match[1]);
  }

  const emphasizedVisible = emphasized.replace(/\s+/g, '');
  if (emphasizedVisible === '') {
    return false;
  }

  const visible = stripHtmlTags(text).replace(/\s+/g, '');
  return emphasizedVisible.length < visible.length;
}

// <em> は強調記法として不可（強調は <strong> のみ）。属性付き・大文字タグも検出する。
const EM_TAG_PATTERN = /<em(?:\s[^>]*)?>/i;

export const EM_DISALLOWED_MESSAGE =
  '<em> is not allowed; use <strong> for emphasis only (fix: remove <em> and keep the words)';

export function hasDisallowedEmTag(text: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }

  return EM_TAG_PATTERN.test(text);
}

export interface TextConstraint {
  min_chars?: number;
  max_chars?: number;
  min_items?: number;
  max_items?: number;
  note?: string;
  bold_required?: boolean;
}

export interface TextValidationError {
  type: 'minChars' | 'maxChars';
  message: string;
  actual: number;
  limit: number;
}

export function validateText(
  text: string,
  constraint: TextConstraint | null | undefined,
): TextValidationError[] {
  const errors: TextValidationError[] = [];

  if (typeof text !== 'string') {
    return errors;
  }

  const stripped = stripHtmlTags(text);
  const fwe = fullWidthEquivalent(stripped);

  const minChars = constraint?.min_chars;
  if (minChars != null && fwe < minChars) {
    errors.push({
      type: 'minChars',
      message: `${fwe} chars (min: ${minChars})`,
      actual: fwe,
      limit: minChars,
    });
  }

  const maxChars = constraint?.max_chars;
  if (maxChars != null && fwe > maxChars) {
    errors.push({
      type: 'maxChars',
      message: `${fwe} chars (max: ${maxChars})`,
      actual: fwe,
      limit: maxChars,
    });
  }

  return errors;
}

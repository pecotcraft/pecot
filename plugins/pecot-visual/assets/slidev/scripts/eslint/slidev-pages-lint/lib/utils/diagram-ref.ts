import { isPlainObject } from '@v-slidev/eslint-shared';

// xmlSrc（/slides/diagrams/x.drawio）は talk-dir の public/ 配下に解決される
export const PUBLIC_DIR = 'public';

export function xmlSrcOf(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return typeof value.xmlSrc === 'string' && value.xmlSrc !== '' ? value.xmlSrc : null;
}

// 指摘行。値が raw 行に現れなければ frontmatter の 1 行目に寄せる
export function findLine(text: string, needle: string): number {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      return i + 1;
    }
  }
  return 1;
}

// frontmatter の中から xmlSrc を持つオブジェクトを再帰で集め、xmlSrc を出現順に返す。
// レイアウトごとの置き場（mediaContent / diagramContent / steps[].diagram）を知らずに済む。
export function collectXmlSrcs(value: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 32) {
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry, depth + 1);
      }
      return;
    }
    if (!isPlainObject(node)) {
      return;
    }
    const xmlSrc = xmlSrcOf(node);
    if (xmlSrc) {
      found.push(xmlSrc);
    }
    for (const entry of Object.values(node)) {
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return found;
}

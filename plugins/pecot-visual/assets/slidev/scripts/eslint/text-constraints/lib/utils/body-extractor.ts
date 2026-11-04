import { extractFrontmatterText } from '@v-slidev/eslint-shared';

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';

export interface CommentRange {
  /** コメント開始の記号の先頭のオフセット */
  start: number;
  /** コメント終了の記号の直後のオフセット（閉じていないコメントは末尾） */
  end: number;
}

export interface BodyNote {
  /** コメント開始と終了の記号の内側 */
  text: string;
  /** 内側の先頭が置かれたファイル行（1 始まり） */
  startLine: number;
  /** 内側の先頭のファイル桁（1 始まり） */
  startColumn: number;
}

export interface RemovedSpan {
  /** 消した文字が元あった行（ファイル行、1 始まり） */
  line: number;
  /** 消した範囲の先頭の元の桁（1 始まり） */
  column: number;
  /** その行で消した文字数 */
  length: number;
}

export interface ExtractedBody {
  /** frontmatter とコメントを除いた本文。コメントは改行だけ残すので行数は元のまま */
  body: string;
  /** 本文の 1 行目のファイル行（1 始まり） */
  bodyStartLine: number;
  notes: BodyNote[];
  /** 本文から消したコメントの範囲。本文の指摘の桁を戻すのに使う */
  removed: RemovedSpan[];
}

// frontmatter の終端の次の行頭のオフセットと、その行番号を返す。frontmatter が無ければ先頭。
// 終端の判定は共有の抽出器に任せ、返った YAML の行数から位置を求める
function locateBodyStart(text: string): { offset: number; line: number } {
  const yaml = extractFrontmatterText(text);
  if (yaml === null) {
    return { offset: 0, line: 1 };
  }
  const openerEnd = text.indexOf('\n') + 1;
  // yaml が空のとき、YAML の行が 0 行（終端がすぐ続く）か空行 1 行かは、開始行の次の文字で分かれる
  const yamlLines = yaml === '' ? (text.startsWith('\n', openerEnd) ? 1 : 0) : yaml.split('\n').length;
  const closerStart = openerEnd + (yamlLines === 0 ? 0 : yaml.length + 1);
  const closerEnd = text.indexOf('\n', closerStart);
  return {
    offset: closerEnd === -1 ? text.length : closerEnd + 1,
    line: yamlLines + 3,
  };
}

// コメント部分は改行だけ残す。空行に置き換えると、段落内のコメントで段落が割れる。
// 消した範囲は行ごとに返す。同じ行でコメントより後ろの指摘は、桁を戻せる
function blankOut(text: string, ranges: readonly CommentRange[]): { text: string; removed: RemovedSpan[] } {
  let result = '';
  let cursor = 0;
  const removed: RemovedSpan[] = [];
  for (const { start, end } of [...ranges].sort((a, b) => a.start - b.start)) {
    result += text.slice(cursor, start);
    let segmentStart = start;
    for (let i = start; i <= end; i++) {
      if (i < end && text[i] !== '\n' && text[i] !== '\r') {
        continue;
      }
      if (i > segmentStart) {
        removed.push({ ...lineAndColumn(text, segmentStart), length: i - segmentStart });
      }
      if (i < end) {
        result += text[i];
      }
      segmentStart = i + 1;
    }
    cursor = end;
  }
  return { text: result + text.slice(cursor), removed };
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length, column: offset - lineStart + 1 };
}

export function extractBody(text: string, comments: readonly CommentRange[]): ExtractedBody {
  const bodyStart = locateBodyStart(text);
  const inBody = comments.filter((c) => c.start >= bodyStart.offset);

  const notes = inBody.map(({ start, end }) => {
    const innerStart = start + COMMENT_OPEN.length;
    const innerEnd = text.slice(innerStart, end).endsWith(COMMENT_CLOSE) ? end - COMMENT_CLOSE.length : end;
    const { line, column } = lineAndColumn(text, innerStart);
    return { text: text.slice(innerStart, innerEnd), startLine: line, startColumn: column };
  });

  const blanked = blankOut(text, inBody);
  return {
    body: blanked.text.slice(bodyStart.offset),
    bodyStartLine: bodyStart.line,
    notes,
    removed: blanked.removed,
  };
}

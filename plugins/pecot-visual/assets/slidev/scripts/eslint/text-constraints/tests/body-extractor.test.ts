import { test } from 'vitest';
import assert from 'node:assert/strict';
import { extractBody } from '../lib/utils/body-extractor.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

// 本文中の HTML コメントを全て範囲として渡す（規則は mdast の html ノードから同じ範囲を作る）
function commentsOf(text: string): { start: number; end: number }[] {
  return [...text.matchAll(/<!--[\s\S]*?-->/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
}

function extract(text: string) {
  return extractBody(text, commentsOf(text));
}

test('frontmatter だけだと、本文は空でノートは 0 件にする', async () => {
  await explains('`extractBody` が frontmatter だけの文書を扱うテストです。本文を持たない場合に、本文が空でノートが 0 件になることを確認します。');
  const result = extract(['---', 'layout: cover', '---', ''].join('\n'));
  assert.equal(result.body.trim(), '');
  assert.deepEqual(result.notes, []);
});

test('frontmatter の後に本文があると、終端の次の行を本文の開始行にする', async () => {
  await explains('`extractBody` が本文の開始行を求めるテストです。frontmatter の後に本文が続く場合に、frontmatter の終端の次の行を開始行とし、本文を取り出すことを確認します。');
  const result = extract(['---', 'layout: cover', 'title: a', '---', '本文です。', '二行目です。'].join('\n'));
  assert.equal(result.bodyStartLine, 5);
  assert.equal(result.body, '本文です。\n二行目です。');
});

test('frontmatter が無いと、全文を本文にして開始行を 1 にする', async () => {
  await explains('`extractBody` が frontmatter を持たない文書を扱うテストです。frontmatter が存在しない場合に、全文を本文として扱い、開始行を 1 にすることを確認します。');
  const result = extract('本文です。\n二行目です。');
  assert.equal(result.bodyStartLine, 1);
  assert.equal(result.body, '本文です。\n二行目です。');
});

test('--- の直後に --- が続く空の frontmatter も、終端として扱う', async () => {
  await explains('`extractBody` が空の frontmatter を扱うテストです。`---` の直後に `---` が続く場合にも、終端として認識し、その次の行から本文を取り出すことを確認します。');
  const result = extract(['---', '---', '本文です。'].join('\n'));
  assert.equal(result.bodyStartLine, 3);
  assert.equal(result.body, '本文です。');
});

test('終端の無い --- は、frontmatter とみなさない', async () => {
  await explains('`extractBody` が閉じていない frontmatter を扱うテストです。終端の `---` が存在しない場合に、frontmatter とみなさず、開始行を 1 にすることを確認します。');
  const result = extract(['---', 'layout: cover', '本文です。'].join('\n'));
  assert.equal(result.bodyStartLine, 1);
});

test('コメントが 1 件あると、本文から消してノートにし、開始行と桁を持たせる', async () => {
  await explains('`extractBody` が HTML コメントをノートとして取り出すテストです。コメントが 1 件ある場合に、本文からコメントを除去し、ノートの文字列・開始行・桁を返すことを確認します。');
  const text = ['---', 'layout: cover', '---', '本文です。', '<!-- ノートです。 -->'].join('\n');
  const result = extract(text);
  assert.equal(result.body, '本文です。\n');
  assert.equal(result.notes.length, 1);
  assert.deepEqual(result.notes[0], { text: ' ノートです。 ', startLine: 5, startColumn: 5 });
});

test('複数行のコメントがあると、行数を保ったまま本文から消し、ノートに内側の開始位置を持たせる', async () => {
  await explains('`extractBody` が複数行の HTML コメントを扱うテストです。複数行のコメントがある場合に、本文の行数を保ったままコメントを除去し、ノートに内側の開始位置を持たせることを確認します。');
  const text = ['---', '---', '前です。', '<!--', 'ノート一行目。', 'ノート二行目。', '-->', '後です。'].join('\n');
  const result = extract(text);
  assert.equal(result.body, '前です。\n\n\n\n\n後です。');
  assert.deepEqual(result.notes, [{ text: '\nノート一行目。\nノート二行目。\n', startLine: 4, startColumn: 5 }]);
});

test('段落の中のコメントを消しても、後続の本文の行をずらさない', async () => {
  await explains('`extractBody` が段落の途中にある HTML コメントを扱うテストです。文の途中のコメントを除去した場合に、後続の本文の行がずれず、ノートの位置も正しいことを確認します。');
  const text = ['---', '---', '前の文です。<!-- メモ -->', '後の文です。'].join('\n');
  const result = extract(text);
  assert.equal(result.body, '前の文です。\n後の文です。');
  assert.equal(result.bodyStartLine, 3);
  assert.deepEqual(result.notes, [{ text: ' メモ ', startLine: 3, startColumn: 11 }]);
});

test('frontmatter の中にコメントがあっても、ノートにしない', async () => {
  await explains('`extractBody` が frontmatter の内側にあるコメントを扱うテストです。frontmatter の中の `#` で始まる記述にコメントが含まれていても、ノートとして取り出さないことを確認します。');
  const text = ['---', '# <!-- yaml のコメント -->', '---', '本文です。'].join('\n');
  const result = extract(text);
  assert.deepEqual(result.notes, []);
  assert.equal(result.body, '本文です。');
});

test('コメントの範囲を渡さないと、コードブロックの中の記述を本文に残し、ノートにしない', async () => {
  await explains('`extractBody` がコメントの範囲を受け取らない場合のテストです。コードブロックの中に HTML コメントの記述があっても、本文にそのまま残し、ノートとして取り出さないことを確認します。');
  const text = ['---', '---', '```html', '<!-- コード -->', '```'].join('\n');
  const result = extractBody(text, []);
  assert.deepEqual(result.notes, []);
  assert.ok(result.body.includes('<!-- コード -->'));
});

test('コメントが閉じていないと、末尾までをノートにする', async () => {
  await explains('`extractBody` が閉じていない HTML コメントを扱うテストです。コメントの終端が存在しない場合に、末尾までをノートとして取り出すことを確認します。');
  const text = ['---', '---', '<!-- 閉じ忘れ'].join('\n');
  const result = extractBody(text, [{ start: text.indexOf('<!--'), end: text.length }]);
  assert.deepEqual(result.notes, [{ text: ' 閉じ忘れ', startLine: 3, startColumn: 5 }]);
});

test('改行が CRLF だと、CRLF のまま保つ', async () => {
  await explains('`extractBody` が CRLF の改行を扱うテストです。改行が CRLF の文書からコメントを除去した場合に、本文の改行を CRLF のまま保つことを確認します。');
  const text = ['---', '---', '前です。', '<!-- ノート -->', '後です。'].join('\r\n');
  const result = extract(text);
  assert.equal(result.body, '前です。\r\n\r\n後です。');
});

test('コメントを消すと、消した範囲をファイルの行・元の桁・長さで返す', async () => {
  await explains('`extractBody` が除去したコメントの範囲を返すテストです。複数のコメントを除去した場合に、`removed` に、ファイル上の行・元の桁・長さを返すことを確認します。');
  const text = ['---', '---', '前です。<!-- メモ -->後です。', '<!--', '二行目', '-->末尾'].join('\n');
  const result = extract(text);
  assert.deepEqual(result.removed, [
    { line: 3, column: 5, length: 11 },
    { line: 4, column: 1, length: 4 },
    { line: 5, column: 1, length: 3 },
    { line: 6, column: 1, length: 3 },
  ]);
});

test('開始行に空白があるか空行を含む frontmatter だと、共有の抽出器と同じ終端行で判定する', async () => {
  await explains('`extractBody` が、空行や末尾に空白を含む frontmatter を扱うテストです。そのような frontmatter の場合にも、共有の抽出器と同じ終端行を判定し、本文の開始行と本文が一致することを確認します。');
  const blankLine = extract(['---', '', '---', '本文です。'].join('\n'));
  assert.equal(blankLine.bodyStartLine, 4);
  assert.equal(blankLine.body, '本文です。');
  const spaced = extract(['--- ', 'a: 1', '---  ', '本文です。'].join('\n'));
  assert.equal(spaced.bodyStartLine, 4);
  assert.equal(spaced.body, '本文です。');
});

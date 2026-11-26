import { test } from 'vitest';
import { Linter } from 'eslint';
import markdown from '@eslint/markdown';
import assert from 'node:assert/strict';
import plugin from '../index.ts';
import { useWorkerForTest } from '../lib/textlint/client.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

// 違反文を literal で持たない。fixture に完成した違反文を置かないため、語を分けて組み立てる。
const HYPE_WORD = ['ゲーム', 'チェンジャー'].join('');
const HYPE = HYPE_WORD + 'となる基盤です。';
const HYPE_ID = 'no-ai-hype-expressions';
const CLEAN = '処理の流れを説明します。';
// 行頭が箇条書きで太字の見出しが付く行。markdown モードでだけ no-ai-list-formatting が見る
const LIST_ID = 'no-ai-list-formatting';
const LIST_LINES = [
  ['- ', '**', '入力', '**', ': ', 'ファイルを読む'].join(''),
  ['- ', '**', '出力', '**', ': ', '結果を書く'].join(''),
];

interface Reported {
  messageId: string | null;
  message: string;
  line: number;
  column: number;
}

function lint(lines: string[]): Reported[] {
  const linter = new Linter();
  const messages = linter.verify(
    lines.join('\n'),
    [
      {
        files: ['**/*.md'],
        plugins: { markdown, 'text-constraints': plugin as never },
        language: 'markdown/commonmark',
        rules: { 'text-constraints/textlint-body': 'error' },
      },
    ] as never,
    { filename: 'pages/case.md' },
  );
  return messages.map((m) => ({
    messageId: m.messageId ?? null,
    message: m.message,
    line: m.line,
    column: m.column,
  }));
}

const FM = ['---', 'layout: cover', '---'];

test('本文に違反があると、ファイル行の位置に「body L<ファイル行>」で報告する', async () => {
  await explains('ページ本文の textlint 検証を報告する、ESLint ルール `textlint-body` のテストです。本文に違反がある場合に、ファイル上の行番号を付けた `body L7: …` の形式で報告することを確認します。');
  const reported = lint([...FM, '', CLEAN, '', HYPE]);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0]!.messageId, 'textlintBody');
  assert.equal(reported[0]!.line, 7);
  assert.match(reported[0]!.message, new RegExp(`^body L7: .+ \\(${HYPE_ID}\\)$`));
});

test('発表者ノートに違反があると、「speaker notes L<ファイル行>」で報告する', async () => {
  await explains('ページ本文の textlint 検証を報告する、ESLint ルール `textlint-body` のテストです。発表者ノート（HTML コメント）に違反がある場合に、`speaker notes L7: …` の形式で報告することを確認します。');
  const reported = lint([...FM, CLEAN, '<!--', 'メモです。', HYPE, '-->']);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0]!.messageId, 'textlintNotes');
  assert.equal(reported[0]!.line, 7);
  assert.match(reported[0]!.message, new RegExp(`^speaker notes L7: .+ \\(${HYPE_ID}\\)$`));
});

test('1 行のコメントに違反があると、桁にコメント開始記号の分を加えて報告する', async () => {
  await explains('発表者ノートの桁位置のテストです。1 行のコメントに違反がある場合に、コメント開始記号の分を加えた桁で報告することを確認します。');
  const reported = lint([...FM, `<!-- ${HYPE} -->`]);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0]!.messageId, 'textlintNotes');
  assert.equal(reported[0]!.line, 4);
  // コメント開始の記号と空白の 5 文字の後ろから、文が始まる
  assert.equal(reported[0]!.column, 6);
});

test('本文とノートの両方に違反があると、それぞれを報告する', async () => {
  await explains('本文とノートの両方に違反がある場合に、それぞれを別の報告にすることを確認します。');
  const reported = lint([...FM, HYPE, '', `<!-- ${HYPE} -->`]);
  assert.deepEqual(reported.map((r) => `${r.messageId}:${r.line}`), ['textlintBody:4', 'textlintNotes:6']);
});

test('本文とノートに違反が無いと、報告しない', async () => {
  await explains('本文とノートに違反がない場合に、何も報告しないことを確認します。');
  assert.deepEqual(lint([...FM, CLEAN, '', `<!-- ${CLEAN} -->`]), []);
});

test('frontmatter に違反があっても、報告しない', async () => {
  await explains('frontmatter に違反があっても、検証の対象外として何も報告しないことを確認します。');
  assert.deepEqual(lint(['---', 'layout: cover', `title: '${HYPE}'`, '---', CLEAN]), []);
});

test('本文に箇条書きの書式の違反があると、markdown モードで確認して本文の行で報告する', async () => {
  await explains('箇条書きの書式の違反（`no-ai-list-formatting`）のテストです。本文に該当する行がある場合に、markdown モードで検証し、本文の行番号で報告することを確認します。');
  const reported = lint([...FM, CLEAN, '', ...LIST_LINES]);
  const list = reported.filter((r) => r.message.includes(` (${LIST_ID})`));
  assert.ok(list.length > 0, JSON.stringify(reported));
  assert.ok(list.every((r) => r.messageId === 'textlintBody' && r.line >= 6 && r.line <= 7), JSON.stringify(list));
});

test('コメントの後ろに本文が続く行だと、本文として確認し、ノートにしない', async () => {
  await explains('コメントの後ろに本文が続く行のテストです。続く部分を本文として検証し、ノートとしては扱わないことを確認します。');
  const reported = lint([...FM, `<!-- メモ --> ${HYPE}`]);
  assert.deepEqual(reported.map((r) => `${r.messageId}:${r.line}`), ['textlintBody:4']);
});

test('1 行に 2 件のコメントが並ぶと、別々のノートとして確認する', async () => {
  await explains('1 行に 2 件のコメントが並ぶ場合に、別々のノートとして検証することを確認します。');
  const reported = lint([...FM, `<!-- ${CLEAN} --><!-- ${HYPE} -->`]);
  assert.deepEqual(reported.map((r) => `${r.messageId}:${r.line}`), ['textlintNotes:4']);
});

test('同じ行のコメントより後ろの本文に違反があると、元の桁で報告する', async () => {
  await explains('同じ行にコメントと本文が並ぶ場合のテストです。コメントより後ろの本文に違反があるときに、元の行での桁位置で報告することを確認します。');
  const prefix = '前置きです。<!-- メモ -->';
  const reported = lint([...FM, prefix + HYPE]);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0]!.messageId, 'textlintBody');
  // 前置きの 6 文字とコメントの 11 文字の後ろから、違反文が始まる
  assert.equal(reported[0]!.column, prefix.length + 1);
});

test('空の frontmatter の後に本文があると、その本文も確認する', async () => {
  await explains('空の frontmatter の後に本文がある場合に、その本文も検証することを確認します。');
  const reported = lint(['---', '---', HYPE]);
  assert.deepEqual(reported.map((r) => `${r.messageId}:${r.line}`), ['textlintBody:3']);
});

test('コードフェンス・インラインコード・字下げコードの中の違反は、本文とノートのどちらにも報告しない', async () => {
  await explains('コードフェンス・インラインコード・字下げコードの中の違反は、本文とノートのどちらにも報告しないことを確認します。');
  const reported = lint([
    ...FM,
    CLEAN,
    '',
    '```html',
    `<!-- ${HYPE} -->`,
    '```',
    '',
    '```text',
    HYPE,
    '```',
    '',
    `説明です。\`<!-- ${HYPE} -->\``,
    '',
    `    <!-- ${HYPE} -->`,
  ]);
  assert.deepEqual(reported, []);
});

test('本文とノートが空だと、worker を呼ばない', async () => {
  await explains('textlint の worker の起動のテストです。本文とノートが空の場合に、worker を呼び出さないことを確認します。');
  // 呼ばれれば worker の起動失敗が textlintFailed として現れる
  useWorkerForTest(new URL('file:///nonexistent/worker.ts'));
  try {
    assert.deepEqual(lint([...FM]), []);
    assert.deepEqual(lint([...FM, '<!--  -->']), []);
  } finally {
    useWorkerForTest();
  }
});

test('worker を起動できないと、実行不能を 1 件だけ報告する', async () => {
  await explains('textlint の worker の起動のテストです。worker を起動できない場合に、実行不能を表す `textlintFailed` を 1 件だけ報告することを確認します。');
  useWorkerForTest(new URL('file:///nonexistent/worker.ts'));
  try {
    const reported = lint([...FM, CLEAN, '', `<!-- ${CLEAN} -->`]);
    assert.deepEqual(reported.map((r) => r.messageId), ['textlintFailed']);
    assert.match(reported[0]!.message, /^textlint failed to run: .+/);
  } finally {
    useWorkerForTest();
  }
});

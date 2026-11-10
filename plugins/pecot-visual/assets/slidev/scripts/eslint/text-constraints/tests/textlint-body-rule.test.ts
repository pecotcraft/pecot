import { test } from 'node:test';
import { Linter } from 'eslint';
import markdown from '@eslint/markdown';
import assert from 'node:assert/strict';
import plugin from '../index.ts';
import { useWorkerForTest } from '../lib/textlint/client.ts';

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

test('本文の違反は「本文 L<ファイル行>」で、ファイル行の位置に報告する', () => {
  const reported = lint([...FM, '', CLEAN, '', HYPE]);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0]!.messageId, 'textlintBody');
  assert.equal(reported[0]!.line, 7);
  assert.match(reported[0]!.message, new RegExp(`^body L7: .+ \\(${HYPE_ID}\\)$`));
});

test('発表者ノートの違反は「発表者ノート L<ファイル行>」で報告する', () => {
  const reported = lint([...FM, CLEAN, '<!--', 'メモです。', HYPE, '-->']);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0]!.messageId, 'textlintNotes');
  assert.equal(reported[0]!.line, 7);
  assert.match(reported[0]!.message, new RegExp(`^speaker notes L7: .+ \\(${HYPE_ID}\\)$`));
});

test('1 行のコメントの違反は、桁にコメント開始記号の分を加える', () => {
  const reported = lint([...FM, `<!-- ${HYPE} -->`]);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0]!.messageId, 'textlintNotes');
  assert.equal(reported[0]!.line, 4);
  // コメント開始の記号と空白の 5 文字の後ろから、文が始まる
  assert.equal(reported[0]!.column, 6);
});

test('本文とノートの両方が違反なら、それぞれを報告する', () => {
  const reported = lint([...FM, HYPE, '', `<!-- ${HYPE} -->`]);
  assert.deepEqual(reported.map((r) => `${r.messageId}:${r.line}`), ['textlintBody:4', 'textlintNotes:6']);
});

test('違反の無い本文とノートは報告しない', () => {
  assert.deepEqual(lint([...FM, CLEAN, '', `<!-- ${CLEAN} -->`]), []);
});

test('frontmatter の違反は確認しない（結果として。除外そのものは body-extractor のテストが固定する）', () => {
  assert.deepEqual(lint(['---', 'layout: cover', `title: '${HYPE}'`, '---', CLEAN]), []);
});

test('本文は markdown モードで確認し、箇条書きの書式規則を本文行で報告する', () => {
  const reported = lint([...FM, CLEAN, '', ...LIST_LINES]);
  const list = reported.filter((r) => r.message.includes(` (${LIST_ID})`));
  assert.ok(list.length > 0, JSON.stringify(reported));
  assert.ok(list.every((r) => r.messageId === 'textlintBody' && r.line >= 6 && r.line <= 7), JSON.stringify(list));
});

test('コメントの後ろに本文が続く行は、本文として確認し、ノートにしない', () => {
  const reported = lint([...FM, `<!-- メモ --> ${HYPE}`]);
  assert.deepEqual(reported.map((r) => `${r.messageId}:${r.line}`), ['textlintBody:4']);
});

test('1 行に並ぶ 2 件のコメントは別々のノートとして確認する', () => {
  const reported = lint([...FM, `<!-- ${CLEAN} --><!-- ${HYPE} -->`]);
  assert.deepEqual(reported.map((r) => `${r.messageId}:${r.line}`), ['textlintNotes:4']);
});

test('同じ行でコメントより後ろにある本文の違反は、元の桁で報告する', () => {
  const prefix = '前置きです。<!-- メモ -->';
  const reported = lint([...FM, prefix + HYPE]);
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0]!.messageId, 'textlintBody');
  // 前置きの 6 文字とコメントの 11 文字の後ろから、違反文が始まる
  assert.equal(reported[0]!.column, prefix.length + 1);
});

test('空の frontmatter の後の本文も確認する', () => {
  const reported = lint(['---', '---', HYPE]);
  assert.deepEqual(reported.map((r) => `${r.messageId}:${r.line}`), ['textlintBody:3']);
});

test('コードフェンス・インラインコード・字下げコードの中の記述は、本文とノートのどちらにも報告しない', () => {
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

test('本文とノートが空なら、worker を呼ばない', () => {
  // 呼ばれれば worker の起動失敗が textlintFailed として現れる
  useWorkerForTest(new URL('file:///nonexistent/worker.ts'));
  try {
    assert.deepEqual(lint([...FM]), []);
    assert.deepEqual(lint([...FM, '<!--  -->']), []);
  } finally {
    useWorkerForTest();
  }
});

test('worker を起動できないときは実行不能を 1 件だけ報告する', () => {
  useWorkerForTest(new URL('file:///nonexistent/worker.ts'));
  try {
    const reported = lint([...FM, CLEAN, '', `<!-- ${CLEAN} -->`]);
    assert.deepEqual(reported.map((r) => r.messageId), ['textlintFailed']);
    assert.match(reported[0]!.message, /^textlint failed to run: .+/);
  } finally {
    useWorkerForTest();
  }
});

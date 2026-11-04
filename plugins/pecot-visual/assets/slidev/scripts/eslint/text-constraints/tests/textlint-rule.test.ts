import { test, before, after } from 'node:test';
import { Linter } from 'eslint';
import markdown from '@eslint/markdown';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearCache } from '@v-slidev/eslint-shared';
import textlintRule from '../lib/rules/textlint.ts';
import { redundantExpression } from './redundant-expression.ts';
import plugin from '../index.ts';
import { useWorkerForTest } from '../lib/textlint/client.ts';

let fixtureRoot: string;
let pagesDir: string;

const FIXTURES: Record<string, string> = {
  'tl-basic.yaml': [
    'layout: tl-basic',
    'text_constraints:',
    "  'title':",
    '    max_chars: 40',
    "  'items[].description':",
    '    max_chars: 80',
    '    bold_required: true',
    "  'bullets':",
    '    max_items: 5',
    '',
  ].join('\n'),
  // 同じ項目を `items[]` と `items[].label` の両方で宣言する形（annotated-diagram の caution 相当）
  'tl-overlap.yaml': [
    'layout: tl-overlap',
    'text_constraints:',
    "  'notes':",
    '    max_items: 3',
    "  'notes[]':",
    '    max_chars: 40',
    '',
  ].join('\n'),
};

before(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v-slidev-textlint-'));
  pagesDir = path.join(fixtureRoot, 'pages');
  const referencesDir = path.join(pagesDir, '_references');
  fs.mkdirSync(referencesDir, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(referencesDir, name), body, 'utf-8');
  }
});

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

interface CapturedReport {
  messageId: string;
  data: { fieldPath: string; message: string; ruleId: string };
}

function runRule(frontmatter: string[]): CapturedReport[] {
  clearCache();
  const text = ['---', ...frontmatter, '---', ''].join('\n');
  const reports: CapturedReport[] = [];
  const visitors = textlintRule.create({
    sourceCode: { getText: () => text },
    filename: path.join(pagesDir, 'case.md'),
    settings: { 'slidev-theme': { referencesDirectories: [path.join(pagesDir, '_references')] } },
    report: (descriptor: CapturedReport) => reports.push(descriptor),
  } as never) as unknown as { Program: (node: unknown) => void };
  visitors.Program({});
  return reports;
}

function found(reports: CapturedReport[]): string[] {
  return reports.map((r) => `${r.data.fieldPath}:${r.data.ruleId}`);
}

// 違反文を literal で持たない。fixture に完成した違反文を置かないため、語を分けて組み立てる。
const HYPE_WORD = ['ゲーム', 'チェンジャー'].join('');
const HYPE = HYPE_WORD + 'となる基盤です。';
const REDUNDANT = ['設定を変更', await redundantExpression(), '。'].join('');

test('AI 臭い誇張表現を項目名付きで報告する', () => {
  const reports = runRule(['layout: tl-basic', `title: '${HYPE}'`]);
  assert.deepEqual(found(reports), ['title:no-ai-hype-expressions']);
  assert.equal(reports[0]?.messageId, 'textlint');
});

test('冗長な助動詞表現を報告する', () => {
  const reports = runRule(['layout: tl-basic', `title: '${REDUNDANT}'`]);
  assert.ok(found(reports).includes('title:ja-no-redundant-expression'), found(reports).join(','));
});

// ai-tech-writing-guideline は severity info だが、具体的な指摘は捨てずに報告する。
// 項目ごとに付く【テクニカルライティング品質分析】の件数要約だけが指摘の重複なので除く
test('ai-tech-writing-guideline の指摘は残し、件数の要約だけを除く', () => {
  const reports = runRule(['layout: tl-basic', `title: '${REDUNDANT}'`]);
  const guideline = reports.filter((r) => r.data.ruleId === 'ai-tech-writing-guideline');
  assert.equal(guideline.length, 1, found(reports).join(','));
  assert.match(guideline[0]!.data.message, /^【簡潔性】/);
  assert.ok(reports.every((r) => !r.data.message.startsWith('【テクニカルライティング品質分析】')));
});

// 項目文字列を Markdown として渡すため、行頭の記法がリスト等と解釈されると
// no-mix-dearu-desumasu が preferInList（である）で誤検出していた
for (const prefix of ['1. ', '- ', '+ ', '* ', '> ', '| ']) {
  test(`行頭の「${prefix}」を Markdown の記法として解釈しない`, () => {
    const reports = runRule(['layout: tl-basic', `title: '${prefix}概要を説明します'`]);
    assert.deepEqual(found(reports), []);
  });
}

test('行頭の「# 」を見出しとして解釈しない', () => {
  const reports = runRule(['layout: tl-basic', "title: '# 概要を説明します'"]);
  assert.deepEqual(found(reports), []);
});

test('配列要素は添字付きの項目名で報告し、HTML タグを除いて確認する', () => {
  const reports = runRule([
    'layout: tl-basic',
    'items:',
    "  - description: '<strong>正常</strong>な説明です。'",
    `  - description: '<strong>${HYPE_WORD}</strong>となる基盤です。'`,
  ]);
  assert.deepEqual(found(reports), ['items[1].description:no-ai-hype-expressions']);
});

test('[] の付かないパスに配列が来たときも要素ごとに確認する', () => {
  const reports = runRule([
    'layout: tl-basic',
    'bullets:',
    "  - '正常な項目です。'",
    `  - '${HYPE}'`,
  ]);
  assert.deepEqual(found(reports), ['bullets[1]:no-ai-hype-expressions']);
});

test('強調の <strong> を含む正常な文は報告しない', () => {
  const reports = runRule([
    'layout: tl-basic',
    'items:',
    "  - description: '<strong>認証なし</strong>で到達できます。'",
  ]);
  assert.deepEqual(found(reports), []);
});

// ja-no-mixed-period だけを除外している。見出し・ラベル等の断片文は句点が無くて正しい
test('句点の無い断片文は報告しない（ja-no-mixed-period を除外）', () => {
  const reports = runRule(['layout: tl-basic', "title: '処理の流れ'"]);
  assert.deepEqual(found(reports), []);
});

test('宣言が重なる項目は 1 度だけ報告する', () => {
  const reports = runRule(['layout: tl-overlap', 'notes:', `  - '${HYPE}'`]);
  assert.deepEqual(found(reports), ['notes[0]:no-ai-hype-expressions']);
});

test('text_constraints に載らない項目は確認しない', () => {
  const reports = runRule(['layout: tl-basic', `unlisted: '${HYPE}'`]);
  assert.deepEqual(found(reports), []);
});

test('layout の無い frontmatter や未知 layout は何もしない', () => {
  assert.deepEqual(found(runRule([`title: '${HYPE}'`])), []);
  assert.deepEqual(found(runRule(['layout: unknown-layout', `title: '${HYPE}'`])), []);
});

test('worker を起動できないときは該当項目に実行不能を 1 件報告する', () => {
  useWorkerForTest(new URL('file:///nonexistent/worker.ts'));
  try {
    const reports = runRule(['layout: tl-basic', `title: '${HYPE}'`, "bullets:", "  - '正常な項目です。'"]);
    assert.deepEqual(
      reports.map((r) => `${r.messageId}:${r.data.fieldPath}`),
      ['textlintFailed:title', 'textlintFailed:bullets[0]'],
    );
    assert.ok(reports.every((r) => (r.data as { reason?: string }).reason));
  } finally {
    useWorkerForTest();
  }
});

// recommended 設定から ESLint を通し、利用者が見るメッセージの形を固定する
test('recommended 設定の ESLint 出力は「項目名: 指摘（規則名）」の形になる', () => {
  clearCache();
  const text = ['---', 'layout: tl-basic', `title: '${HYPE}'`, '---', ''].join('\n');
  const linter = new Linter({ cwd: fixtureRoot });
  const messages = linter.verify(
    text,
    [
      {
        files: ['**/*.md'],
        settings: { 'slidev-theme': { referencesDirectories: [path.join(pagesDir, '_references')] } },
        plugins: { markdown, ...plugin.configs.recommended!.plugins },
        language: 'markdown/commonmark',
        rules: plugin.configs.recommended!.rules,
      },
    ] as never,
    { filename: path.join(pagesDir, 'case.md') },
  );
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.match(messages[0]!.message, /^title: .+（no-ai-hype-expressions）$/);
});

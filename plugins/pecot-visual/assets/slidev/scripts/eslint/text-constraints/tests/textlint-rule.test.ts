import { test, beforeAll, afterAll } from 'vitest';
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
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

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

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v-slidev-textlint-'));
  pagesDir = path.join(fixtureRoot, 'pages');
  const referencesDir = path.join(pagesDir, '_references');
  fs.mkdirSync(referencesDir, { recursive: true });
  for (const [name, body] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(referencesDir, name), body, 'utf-8');
  }
});

afterAll(() => {
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

test('誇張表現があると、項目名を付けて報告する', async () => {
  await explains('項目の文章を textlint で解析する規則のテストです。誇張表現が含まれる場合に、項目名を付けて `no-ai-hype-expressions` の指摘が報告されることを確認します。');
  const reports = runRule(['layout: tl-basic', `title: '${HYPE}'`]);
  assert.deepEqual(found(reports), ['title:no-ai-hype-expressions']);
  assert.equal(reports[0]?.messageId, 'textlint');
});

test('冗長な助動詞の表現があると、報告する', async () => {
  await explains('冗長な助動詞の表現が含まれる場合に、`ja-no-redundant-expression` の指摘が報告されることを確認します。');
  const reports = runRule(['layout: tl-basic', `title: '${REDUNDANT}'`]);
  assert.ok(found(reports).includes('title:ja-no-redundant-expression'), found(reports).join(','));
});

// ai-tech-writing-guideline は severity info だが、具体的な指摘は捨てずに報告する。
// 項目ごとに付く【テクニカルライティング品質分析】の件数要約だけが指摘の重複なので除く
test('ai-tech-writing-guideline の指摘があると、指摘は残し、件数の要約だけを除く', async () => {
  await explains('`ai-tech-writing-guideline` の指摘を扱うテストです。具体的な指摘（`【簡潔性】`）は報告に残り、件数の要約（`【テクニカルライティング品質分析】`）だけが除かれることを確認します。');
  const reports = runRule(['layout: tl-basic', `title: '${REDUNDANT}'`]);
  const guideline = reports.filter((r) => r.data.ruleId === 'ai-tech-writing-guideline');
  assert.equal(guideline.length, 1, found(reports).join(','));
  assert.match(guideline[0]!.data.message, /^【簡潔性】/);
  assert.ok(reports.every((r) => !r.data.message.startsWith('【テクニカルライティング品質分析】')));
});

// 項目文字列を Markdown として渡すため、行頭の記法がリスト等と解釈されると
// no-mix-dearu-desumasu が preferInList（である）で誤検出していた
for (const prefix of ['1. ', '- ', '+ ', '* ', '> ', '| ']) {
  test(`行頭が「${prefix}」だと、Markdown の記法として解釈しない`, async () => {
    await explains(`項目の文字列を Markdown として渡す際の、行頭の記法のテストです。行頭が \`${prefix}\` の場合に、リストや引用などとして解釈されず、指摘が報告されないことを確認します。`);
    const reports = runRule(['layout: tl-basic', `title: '${prefix}概要を説明します'`]);
    assert.deepEqual(found(reports), []);
  });
}

test('行頭が「# 」だと、見出しとして解釈しない', async () => {
  await explains('項目の文字列を Markdown として渡す際の、行頭の記法のテストです。行頭が `# ` の場合に、見出しとして解釈されず、指摘が報告されないことを確認します。');
  const reports = runRule(['layout: tl-basic', "title: '# 概要を説明します'"]);
  assert.deepEqual(found(reports), []);
});

test('配列の要素に違反があると、HTML タグを除いて確認し、添字付きの項目名で報告する', async () => {
  await explains('配列の要素に違反がある場合のテストです。HTML タグを除いて解析し、添字付きの項目名（`items[1].description`）で報告されることを確認します。');
  const reports = runRule([
    'layout: tl-basic',
    'items:',
    "  - description: '<strong>正常</strong>な説明です。'",
    `  - description: '<strong>${HYPE_WORD}</strong>となる基盤です。'`,
  ]);
  assert.deepEqual(found(reports), ['items[1].description:no-ai-hype-expressions']);
});

test('[] の付かないパスに配列が渡されると、要素ごとに確認する', async () => {
  await explains('`[]` の付かないパスに配列が渡された場合に、要素ごとに解析され、添字付きの項目名（`bullets[1]`）で報告されることを確認します。');
  const reports = runRule([
    'layout: tl-basic',
    'bullets:',
    "  - '正常な項目です。'",
    `  - '${HYPE}'`,
  ]);
  assert.deepEqual(found(reports), ['bullets[1]:no-ai-hype-expressions']);
});

test('強調の <strong> を含む正常な文だと、報告しない', async () => {
  await explains('強調の `<strong>` を含む正常な文の場合に、指摘が報告されないことを確認します。');
  const reports = runRule([
    'layout: tl-basic',
    'items:',
    "  - description: '<strong>認証なし</strong>で到達できます。'",
  ]);
  assert.deepEqual(found(reports), []);
});

// ja-no-mixed-period だけを除外している。見出し・ラベル等の断片文は句点が無くて正しい
test('句点の無い断片の文だと、報告しない', async () => {
  await explains('見出しやラベルのように句点のない断片の文の場合に、`ja-no-mixed-period` の指摘が除外され、報告されないことを確認します。');
  const reports = runRule(['layout: tl-basic', "title: '処理の流れ'"]);
  assert.deepEqual(found(reports), []);
});

test('宣言が重なる項目だと、1 度だけ報告する', async () => {
  await explains('`notes` と `notes[]` のように宣言が重なる項目の場合に、同じ違反が 1 度だけ報告されることを確認します。');
  const reports = runRule(['layout: tl-overlap', 'notes:', `  - '${HYPE}'`]);
  assert.deepEqual(found(reports), ['notes[0]:no-ai-hype-expressions']);
});

test('text_constraints に載らない項目だと、確認しない', async () => {
  await explains('`text_constraints` に載っていない項目の場合に、違反する文があっても対象にならず、報告されないことを確認します。');
  const reports = runRule(['layout: tl-basic', `unlisted: '${HYPE}'`]);
  assert.deepEqual(found(reports), []);
});

test('layout が無いか未知の layout だと、何も報告しない', async () => {
  await explains('`layout` が指定されていない場合や、未知の `layout` の場合に、何も報告されないことを確認します。');
  assert.deepEqual(found(runRule([`title: '${HYPE}'`])), []);
  assert.deepEqual(found(runRule(['layout: unknown-layout', `title: '${HYPE}'`])), []);
});

test('worker を起動できないと、該当する項目ごとに実行不能を 1 件報告する', async () => {
  await explains('textlint の worker を起動できない場合のテストです。該当する項目ごとに、実行不能（`textlintFailed`）が 1 件ずつ報告され、理由が含まれることを確認します。');
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
test('recommended 設定で ESLint を通すと、「項目名: 指摘（規則名）」の形のメッセージを返す', async () => {
  await explains('`recommended` 設定を使って ESLint を実行する場合のテストです。利用者に表示するメッセージは、「項目名: 指摘 (規則名)」の形で 1 件だけになることを確認します。');
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
  assert.match(messages[0]!.message, /^title: .+ \(no-ai-hype-expressions\)$/);
});

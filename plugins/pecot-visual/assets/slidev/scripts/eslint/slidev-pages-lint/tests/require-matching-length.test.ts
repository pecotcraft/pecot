import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import {
  clearCache,
  loadLayoutReference,
  getLayoutPropTree,
  collectMatchingLengthDeclarations,
} from '@v-slidev/eslint-shared';
import requireMatchingLengthRule from '../lib/rules/require-matching-length.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

const referencesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references');

// collectMatchingLengthDeclarations

test('トップレベルの prop に same_length_as があると、検出する', async () => {
  await explains('配列の長さをそろえる `same_length_as` の宣言を集める、`collectMatchingLengthDeclarations` のテストです。トップレベルの `props` に宣言がある場合に、そのパスと参照先が検出されることを確認します。');
  const tree = getLayoutPropTree({
    props: {
      rows: { type: 'Array' },
      items: { type: 'Array', same_length_as: 'rows' },
    },
  });
  const declarations = collectMatchingLengthDeclarations(tree);
  assert.deepStrictEqual(declarations, [{ path: 'items', target: 'rows' }]);
});

test('ネストした Object 配下に same_length_as があると、ドット区切りのパスで検出する', async () => {
  await explains('入れ子の `Object` 配下に `same_length_as` がある場合に、ドット区切りのパス（`readout.items`）で検出されることを確認します。');
  const tree = getLayoutPropTree({
    props: {
      statContent: { type: 'Object', props: { rows: { type: 'Array' } } },
      readout: {
        type: 'Object',
        props: { items: { type: 'Array', same_length_as: 'statContent.rows' } },
      },
    },
  });
  const declarations = collectMatchingLengthDeclarations(tree);
  assert.deepStrictEqual(declarations, [{ path: 'readout.items', target: 'statContent.rows' }]);
});

test('same_length_as が無いと、空配列を返す', async () => {
  await explains('`same_length_as` が存在しない場合に、空の配列が返ることを確認します。');
  const tree = getLayoutPropTree({
    props: { rows: { type: 'Array' }, items: { type: 'Array' } },
  });
  assert.deepStrictEqual(collectMatchingLengthDeclarations(tree), []);
});

test('配列要素のスキーマ（items）配下に same_length_as があっても、辿らない', async () => {
  await explains('配列要素のスキーマ（`items`）配下に `same_length_as` がある場合に、辿られず、空の配列が返ることを確認します。');
  const tree = getLayoutPropTree({
    props: {
      rows: {
        type: 'Array',
        items: { value: { type: 'String', same_length_as: 'rows' } },
      },
    },
  });
  assert.deepStrictEqual(collectMatchingLengthDeclarations(tree), []);
});

test('stat-readout の実 reference を読むと、readout.items → statContent.rows を検出する', async () => {
  await explains('fixture deck の `stat-readout` を読んだ場合に、`readout.items` から `statContent.rows` への宣言が検出されることを確認します。');
  clearCache();
  const reference = loadLayoutReference([referencesDir], 'stat-readout');
  const tree = getLayoutPropTree(reference, [referencesDir]);
  const declarations = collectMatchingLengthDeclarations(tree);
  assert.deepStrictEqual(declarations, [{ path: 'readout.items', target: 'statContent.rows' }]);
});

// rule レベル（mock context）

interface CapturedReport {
  messageId: string;
  data: { path?: string; pathCount?: string; target?: string; targetCount?: string };
}

function runRule(text: string, filename: string): CapturedReport[] {
  const reports: CapturedReport[] = [];
  const context = {
    sourceCode: { getText: () => text },
    filename,
    settings: { 'slidev-theme': { referencesDirectories: [referencesDir] } },
    report: (descriptor: CapturedReport) => reports.push(descriptor),
  };
  const visitors = requireMatchingLengthRule.create(context as never) as unknown as {
    Program: (node: unknown) => void;
  };
  visitors.Program({});
  return reports;
}

function statReadoutFrontmatter(rowsCount: number, itemsCount: number): string {
  const rows = Array.from(
    { length: rowsCount },
    (_, i) => `    - label: "行${i}"\n      value: "${i}"\n      detail: "detail${i}"`,
  ).join('\n');
  const items = Array.from(
    { length: itemsCount },
    (_, i) => `    - claim: "claim${i}"\n      detail: "detail${i}"`,
  ).join('\n');
  return [
    '---',
    'layout: stat-readout',
    'title: "テスト見出し"',
    'statContent:',
    '  heading: "見出し"',
    '  rows:',
    rows,
    'readout:',
    '  heading: "読み取り見出し"',
    '  items:',
    items,
    '---',
    '',
  ].join('\n');
}

test('rows と items の件数が一致していると、報告しない', async () => {
  await explains('配列の件数をそろえる、`require-matching-length` 規則のテストです。`rows` と `items` の件数が一致している場合に、報告されないことを確認します。');
  clearCache();
  const text = statReadoutFrontmatter(3, 3);
  const filename = path.join(referencesDir, '..', 'match.md');
  const reports = runRule(text, filename);
  assert.deepStrictEqual(reports, []);
});

test('rows と items の件数が不一致だと、lengthMismatch を報告する', async () => {
  await explains('`require-matching-length` 規則のテストです。件数が一致しない場合（3 件と 2 件）に、`lengthMismatch` が 1 件報告され、両方のパスと件数がデータに含まれることを確認します。');
  clearCache();
  const text = statReadoutFrontmatter(3, 2);
  const filename = path.join(referencesDir, '..', 'mismatch.md');
  const reports = runRule(text, filename);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'lengthMismatch');
  assert.strictEqual(reports[0].data.path, 'readout.items');
  assert.strictEqual(reports[0].data.pathCount, '2');
  assert.strictEqual(reports[0].data.target, 'statContent.rows');
  assert.strictEqual(reports[0].data.targetCount, '3');
});

test('片方の配列が欠落していると、報告しない（required の確認に委ねる）', async () => {
  await explains('片方の配列が存在しない場合に、報告されないことを確認します。必須かどうかの検証は、別の規則が担います。');
  clearCache();
  const text = [
    '---',
    'layout: stat-readout',
    'title: "テスト見出し"',
    'statContent:',
    '  heading: "見出し"',
    '  rows:',
    '    - label: "行0"',
    '      value: "0"',
    '      detail: "detail0"',
    '---',
    '',
  ].join('\n');
  const filename = path.join(referencesDir, '..', 'missing-readout.md');
  const reports = runRule(text, filename);
  assert.deepStrictEqual(reports, []);
});

test('same_length_as を宣言していないレイアウトだと、報告しない', async () => {
  await explains('`same_length_as` を宣言していないレイアウト（`cover`）の場合に、報告されないことを確認します。');
  clearCache();
  const text = ['---', 'layout: cover', 'title: "テスト"', '---', ''].join('\n');
  const filename = path.join(referencesDir, '..', 'no-declaration.md');
  const reports = runRule(text, filename);
  assert.deepStrictEqual(reports, []);
});

test('pages 配下の全 *.md を渡すと、報告しない（正のコントロール）', async () => {
  await explains('fixture deck の `pages` 配下のすべての Markdown を渡した場合に、報告されないことを確認します。規則が見本ページに誤って反応しないことを示す、正のコントロールです。');
  clearCache();
  const pagesDir = path.dirname(referencesDir);
  const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'pages に *.md が無い');
  const offenders: { file: string; findings: string[] }[] = [];
  for (const file of files) {
    const full = path.join(pagesDir, file);
    const text = fs.readFileSync(full, 'utf-8');
    const reports = runRule(text, full);
    if (reports.length > 0) {
      offenders.push({
        file,
        findings: reports.map((r) => `${r.messageId}:${r.data.path}`),
      });
    }
  }
  assert.deepStrictEqual(offenders, [], `unexpected findings:\n${JSON.stringify(offenders, null, 2)}`);
});

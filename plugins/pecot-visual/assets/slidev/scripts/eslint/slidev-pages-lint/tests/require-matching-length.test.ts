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

const referencesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references');

// collectMatchingLengthDeclarations

test('トップレベルの prop に same_length_as があると、検出する', () => {
  const tree = getLayoutPropTree({
    props: {
      rows: { type: 'Array' },
      items: { type: 'Array', same_length_as: 'rows' },
    },
  });
  const declarations = collectMatchingLengthDeclarations(tree);
  assert.deepStrictEqual(declarations, [{ path: 'items', target: 'rows' }]);
});

test('ネストした Object 配下に same_length_as があると、ドット区切りのパスで検出する', () => {
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

test('same_length_as が無いと、空配列を返す', () => {
  const tree = getLayoutPropTree({
    props: { rows: { type: 'Array' }, items: { type: 'Array' } },
  });
  assert.deepStrictEqual(collectMatchingLengthDeclarations(tree), []);
});

test('配列要素のスキーマ（items）配下に same_length_as があっても、辿らない', () => {
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

test('stat-readout の実 reference を読むと、readout.items → statContent.rows を検出する', () => {
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

test('rows と items の件数が一致していると、報告しない', () => {
  clearCache();
  const text = statReadoutFrontmatter(3, 3);
  const filename = path.join(referencesDir, '..', 'match.md');
  const reports = runRule(text, filename);
  assert.deepStrictEqual(reports, []);
});

test('rows と items の件数が不一致だと、lengthMismatch を報告する', () => {
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

test('片方の配列が欠落していると、報告しない（required の確認に委ねる）', () => {
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

test('same_length_as を宣言していないレイアウトだと、報告しない', () => {
  clearCache();
  const text = ['---', 'layout: cover', 'title: "テスト"', '---', ''].join('\n');
  const filename = path.join(referencesDir, '..', 'no-declaration.md');
  const reports = runRule(text, filename);
  assert.deepStrictEqual(reports, []);
});

test('pages 配下の全 *.md を渡すと、報告しない（正のコントロール）', () => {
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

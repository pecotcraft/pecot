import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import noNumericFilenamePrefixRule from '../lib/rules/no-numeric-filename-prefix.ts';

const templatesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');
const pagesDir = path.join(templatesDir, 'pages');

function runRule(filePath: string): Array<{ messageId?: string }> {
  const reports: Array<{ messageId?: string }> = [];
  const mockContext = {
    filename: filePath,
    sourceCode: { getText: () => '' },
    report: (descriptor: { messageId?: string }) => reports.push(descriptor),
  };
  const visitors = noNumericFilenamePrefixRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  return reports;
}

const VIOLATING_NAMES = [
  '01-cover.md',
  '01_cover.md',
  '01.cover.md',
  '01.md',
  '01cover.md',
  '2024review.md',
  '3-tier-architecture.md',
  '2026-07-plan.md',
];
const VALID_NAMES = ['cover.md', 'comparison-radar-3axis.md', 'summary-cards-4.md'];

test('meta.type を読むと、problem を返す', () => {
  assert.strictEqual(noNumericFilenamePrefixRule.meta?.type, 'problem');
});

test('メッセージを読むと、numericFilenamePrefix が定義されている', () => {
  const meta = noNumericFilenamePrefixRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.numericFilenamePrefix);
});

test('create を呼ぶと、root と Program のビジターを返す', () => {
  const visitors = noNumericFilenamePrefixRule.create({
    filename: '/test.md',
    sourceCode: { getText: () => '' },
  } as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('数字から始まるファイル名を渡すと、numericFilenamePrefix を報告する', () => {
  for (const name of VIOLATING_NAMES) {
    const reports = runRule(path.join(pagesDir, name));
    assert.strictEqual(reports.length, 1, `expected error for ${name}`);
    assert.strictEqual(reports[0].messageId, 'numericFilenamePrefix');
  }
});

test('数字を含む正当なファイル名を渡すと、報告しない', () => {
  for (const name of VALID_NAMES) {
    const reports = runRule(path.join(pagesDir, name));
    assert.strictEqual(reports.length, 0, `unexpected error for ${name}`);
  }
});

test('数字から始まるファイル名を渡すと、ファイル全体でなく 1 行目の点で指摘する', () => {
  const reports = runRule(path.join(pagesDir, '01-cover.md')) as Array<{
    loc?: { line: number; column: number };
  }>;
  assert.deepStrictEqual(reports[0].loc, { line: 1, column: 0 });
});

test('_references/ 配下のファイルだと、スキップする', () => {
  const reports = runRule(path.join(pagesDir, '_references', '01-cover.md'));
  assert.strictEqual(reports.length, 0, '_references/ should be skipped');
});

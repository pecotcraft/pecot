import { test } from 'node:test';
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

test('no-numeric-filename-prefix: meta.type が problem', () => {
  assert.strictEqual(noNumericFilenamePrefixRule.meta?.type, 'problem');
});

test('no-numeric-filename-prefix: numericFilenamePrefix メッセージが定義されている', () => {
  const meta = noNumericFilenamePrefixRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.numericFilenamePrefix);
});

test('no-numeric-filename-prefix: create が root/Program ビジターを返す', () => {
  const visitors = noNumericFilenamePrefixRule.create({
    filename: '/test.md',
    sourceCode: { getText: () => '' },
  } as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('no-numeric-filename-prefix: 数字から始まるファイル名でエラーを報告', () => {
  for (const name of VIOLATING_NAMES) {
    const reports = runRule(path.join(pagesDir, name));
    assert.strictEqual(reports.length, 1, `expected error for ${name}`);
    assert.strictEqual(reports[0].messageId, 'numericFilenamePrefix');
  }
});

test('no-numeric-filename-prefix: 数字を含む正当なファイル名でエラーが出ないこと', () => {
  for (const name of VALID_NAMES) {
    const reports = runRule(path.join(pagesDir, name));
    assert.strictEqual(reports.length, 0, `unexpected error for ${name}`);
  }
});

test('no-numeric-filename-prefix: 指摘位置はファイル全体でなく 1 行目の点指摘', () => {
  const reports = runRule(path.join(pagesDir, '01-cover.md')) as Array<{
    loc?: { line: number; column: number };
  }>;
  assert.deepStrictEqual(reports[0].loc, { line: 1, column: 0 });
});

test('no-numeric-filename-prefix: _references/ 配下のファイルはスキップ', () => {
  const reports = runRule(path.join(pagesDir, '_references', '01-cover.md'));
  assert.strictEqual(reports.length, 0, '_references/ should be skipped');
});

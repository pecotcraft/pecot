import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import noNumericFilenamePrefixRule from '../lib/rules/no-numeric-filename-prefix.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

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

test('meta.type を読むと、problem を返す', async () => {
  await explains('ルールの `meta.type` のテストです。`problem` であることを確認します。');
  assert.strictEqual(noNumericFilenamePrefixRule.meta?.type, 'problem');
});

test('メッセージを読むと、numericFilenamePrefix が定義されている', async () => {
  await explains('ルールの `meta.messages` のテストです。`numericFilenamePrefix` のメッセージが定義されていることを確認します。');
  const meta = noNumericFilenamePrefixRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.numericFilenamePrefix);
});

test('create を呼ぶと、root と Program のビジターを返す', async () => {
  await explains('ルールの `create` のテストです。`root` と `Program` のビジターを関数として返すことを確認します。');
  const visitors = noNumericFilenamePrefixRule.create({
    filename: '/test.md',
    sourceCode: { getText: () => '' },
  } as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('数字から始まるファイル名を渡すと、numericFilenamePrefix を報告する', async () => {
  await explains('ページのファイル名を検証する、`no-numeric-filename-prefix` のテストです。`01-cover.md` や `2024review.md` のように数字から始まる場合に、`numericFilenamePrefix` を 1 件ずつ報告することを確認します。');
  for (const name of VIOLATING_NAMES) {
    const reports = runRule(path.join(pagesDir, name));
    assert.strictEqual(reports.length, 1, `expected error for ${name}`);
    assert.strictEqual(reports[0].messageId, 'numericFilenamePrefix');
  }
});

test('数字を含む正当なファイル名を渡すと、報告しない', async () => {
  await explains('ページのファイル名を検証する、`no-numeric-filename-prefix` のテストです。`cover.md` や `summary-cards-4.md` のように数字を含むが先頭ではない場合に、報告しないことを確認します。');
  for (const name of VALID_NAMES) {
    const reports = runRule(path.join(pagesDir, name));
    assert.strictEqual(reports.length, 0, `unexpected error for ${name}`);
  }
});

test('数字から始まるファイル名を渡すと、ファイル全体でなく 1 行目の点で指摘する', async () => {
  await explains('指摘位置のテストです。数字から始まるファイル名の場合に、ファイル全体ではなく 1 行目の点で指摘することを確認します。');
  const reports = runRule(path.join(pagesDir, '01-cover.md')) as Array<{
    loc?: { line: number; column: number };
  }>;
  assert.deepStrictEqual(reports[0].loc, { line: 1, column: 0 });
});

test('_references/ 配下のファイルだと、スキップする', async () => {
  await explains('`_references/` 配下のファイルの場合に、検証を飛ばして何も報告しないことを確認します。');
  const reports = runRule(path.join(pagesDir, '_references', '01-cover.md'));
  assert.strictEqual(reports.length, 0, '_references/ should be skipped');
});

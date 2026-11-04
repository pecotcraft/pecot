import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import noMissingPageRule from '../lib/rules/no-missing-page.ts';

const templatesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');
const slidesFile = path.join(templatesDir, 'slides.md');
const slidesContent = fs.readFileSync(slidesFile, 'utf-8');

interface MockReport {
  messageId?: string;
  data?: { filePath?: string };
  loc?: { line?: number };
}

test('no-missing-page: meta.type が problem', () => {
  assert.strictEqual(noMissingPageRule.meta?.type, 'problem');
});

test('no-missing-page: missingPage メッセージが定義されている', () => {
  const meta = noMissingPageRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.missingPage);
});

test('no-missing-page: create が root/Program ビジターを返す', () => {
  const mockContext = {
    sourceCode: { getText: () => '' },
    filename: '/test/slides.md',
  };
  const visitors = noMissingPageRule.create(mockContext as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('no-missing-page: fixture deck の slides.md でエラーが出ないこと', () => {
  const reports: MockReport[] = [];
  const mockContext = {
    filename: slidesFile,
    sourceCode: { getText: () => slidesContent },
    report: (descriptor: MockReport) => reports.push(descriptor),
  };
  const visitors = noMissingPageRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  assert.strictEqual(reports.length, 0, `unexpected errors: ${JSON.stringify(reports)}`);
});

test('no-missing-page: 存在しないファイル参照でエラーを報告', () => {
  const reports: MockReport[] = [];
  const content = [
    '---',
    'theme: none',
    'src: ./pages/cover.md',
    '---',
    '',
    '---',
    'src: ./pages/nonexistent-page.md',
    '---',
  ].join('\n');
  const mockContext = {
    filename: slidesFile,
    sourceCode: { getText: () => content },
    report: (descriptor: MockReport) => reports.push(descriptor),
  };
  const visitors = noMissingPageRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'missingPage');
  assert.strictEqual(reports[0].data?.filePath, './pages/nonexistent-page.md');
  assert.strictEqual(reports[0].loc?.line, 7);
});

test('no-missing-page: 複数の存在しないファイル参照で複数エラー', () => {
  const reports: MockReport[] = [];
  const content = [
    '---',
    'theme: none',
    'src: ./pages/missing-a.md',
    '---',
    '',
    '---',
    'src: ./pages/missing-b.md',
    '---',
  ].join('\n');
  const mockContext = {
    filename: slidesFile,
    sourceCode: { getText: () => content },
    report: (descriptor: MockReport) => reports.push(descriptor),
  };
  const visitors = noMissingPageRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  assert.strictEqual(reports.length, 2);
  assert.strictEqual(reports[0].data?.filePath, './pages/missing-a.md');
  assert.strictEqual(reports[0].loc?.line, 3);
  assert.strictEqual(reports[1].data?.filePath, './pages/missing-b.md');
  assert.strictEqual(reports[1].loc?.line, 7);
});

test('no-missing-page: src: 行がないファイルはエラーなし', () => {
  const reports: MockReport[] = [];
  const content = [
    '---',
    'theme: none',
    'title: Test',
    '---',
  ].join('\n');
  const mockContext = {
    filename: slidesFile,
    sourceCode: { getText: () => content },
    report: (descriptor: MockReport) => reports.push(descriptor),
  };
  const visitors = noMissingPageRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  assert.strictEqual(reports.length, 0);
});

test('no-missing-page: getText 失敗時はスキップ', () => {
  const reports: MockReport[] = [];
  const mockContext = {
    filename: slidesFile,
    sourceCode: {
      getText: () => {
        throw new Error('fail');
      },
    },
    report: (descriptor: MockReport) => reports.push(descriptor),
  };
  const visitors = noMissingPageRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  assert.strictEqual(reports.length, 0);
});

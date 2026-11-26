import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import { findSlidesFile, getSlidesEntries, clearSlidesCache } from '../lib/utils/slides-loader.ts';
import requireSlidesEntryRule from '../lib/rules/require-slides-entry.ts';

const templatesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');
const pagesDir = path.join(templatesDir, 'pages');
const slidesFile = path.join(templatesDir, 'slides.md');

const EXPECTED_PAGES = [
  'cover.md',
  'agenda.md',
  'annotated-diagram.md',
  'media-right-diagram.md',
  'stat-readout.md',
  'end.md',
];

test('pages/ 配下のファイルを渡すと、slides.md を発見する', () => {
  const filePath = path.join(pagesDir, 'cover.md');
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, slidesFile);
});

test('pages/ 外のファイルを渡すと、null を返す', () => {
  const filePath = path.join(templatesDir, 'README.md');
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, null);
});

test('slides.md が存在しないディレクトリを渡すと、null を返す', () => {
  const filePath = '/nonexistent/pages/test.md';
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, null);
});

test('fixture deck の slides.md を読むと、全エントリを取得する', () => {
  clearSlidesCache();
  const entries = getSlidesEntries(slidesFile);
  assert.strictEqual(entries.size, EXPECTED_PAGES.length);
  for (const page of EXPECTED_PAGES) {
    const absolutePath = path.join(pagesDir, page);
    assert.ok(entries.has(absolutePath), `missing: ${page}`);
  }
});

test('slides.md を 2 回読むと、キャッシュを再利用する', () => {
  clearSlidesCache();
  const entries1 = getSlidesEntries(slidesFile);
  const entries2 = getSlidesEntries(slidesFile);
  assert.strictEqual(entries1, entries2, 'same reference (cached)');
});

test('存在しないファイルを読むと、空の Set を返す', () => {
  clearSlidesCache();
  const entries = getSlidesEntries('/nonexistent/slides.md');
  assert.strictEqual(entries.size, 0);
});

test('キャッシュをクリアすると、次の読み込みで別のインスタンスを返す', () => {
  clearSlidesCache();
  const entries1 = getSlidesEntries(slidesFile);
  clearSlidesCache();
  const entries2 = getSlidesEntries(slidesFile);
  assert.notStrictEqual(entries1, entries2, 'different reference after clear');
  assert.deepStrictEqual(entries1, entries2, 'same content');
});

test('meta.type を読むと、problem を返す', () => {
  assert.strictEqual(requireSlidesEntryRule.meta?.type, 'problem');
});

test('メッセージを読むと、missingEntry が定義されている', () => {
  const meta = requireSlidesEntryRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.missingEntry);
});

test('create を呼ぶと、root と Program のビジターを返す', () => {
  const mockContext = {
    sourceCode: { getText: () => '' },
    filename: '/test.md',
  };
  const visitors = requireSlidesEntryRule.create(mockContext as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('既存のページファイルを渡すと、報告しない', () => {
  clearSlidesCache();
  for (const page of EXPECTED_PAGES) {
    const reports: unknown[] = [];
    const filePath = path.join(pagesDir, page);
    const mockContext = {
      filename: filePath,
      sourceCode: { getText: () => '' },
      report: (descriptor: unknown) => reports.push(descriptor),
    };
    const visitors = requireSlidesEntryRule.create(mockContext as never) as unknown as {
      root: (n: unknown) => void;
    };
    visitors.root({});
    assert.strictEqual(reports.length, 0, `unexpected error for ${page}`);
  }
});

test('_references/ 配下のファイルだと、スキップする', () => {
  clearSlidesCache();
  const reports: unknown[] = [];
  const filePath = path.join(pagesDir, '_references', 'test.md');
  const mockContext = {
    filename: filePath,
    sourceCode: { getText: () => '' },
    report: (descriptor: unknown) => reports.push(descriptor),
  };
  const visitors = requireSlidesEntryRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  assert.strictEqual(reports.length, 0, '_references/ should be skipped');
});

test('slides.md に含まれないファイルを渡すと、missingEntry を報告する', () => {
  clearSlidesCache();
  const reports: Array<{ messageId?: string }> = [];
  const filePath = path.join(pagesDir, 'new-unreferenced-page.md');
  const mockContext = {
    filename: filePath,
    sourceCode: { getText: () => '' },
    report: (descriptor: { messageId?: string }) => reports.push(descriptor),
  };
  const visitors = requireSlidesEntryRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'missingEntry');
});

test('pages/ 外のファイルだと、slides.md が見つからないのでスキップする', () => {
  clearSlidesCache();
  const reports: unknown[] = [];
  const filePath = '/some/other/dir/file.md';
  const mockContext = {
    filename: filePath,
    sourceCode: { getText: () => '' },
    report: (descriptor: unknown) => reports.push(descriptor),
  };
  const visitors = requireSlidesEntryRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
  };
  visitors.root({});
  assert.strictEqual(reports.length, 0, 'non-pages file should be skipped');
});

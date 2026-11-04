import { test } from 'node:test';
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

test('findSlidesFile: pages/配下のファイルから slides.md を発見', () => {
  const filePath = path.join(pagesDir, 'cover.md');
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, slidesFile);
});

test('findSlidesFile: pages/外のファイル → null', () => {
  const filePath = path.join(templatesDir, 'README.md');
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, null);
});

test('findSlidesFile: slides.md が存在しないディレクトリ → null', () => {
  const filePath = '/nonexistent/pages/test.md';
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, null);
});

test('getSlidesEntries: fixture deck の slides.md から全エントリを取得', () => {
  clearSlidesCache();
  const entries = getSlidesEntries(slidesFile);
  assert.strictEqual(entries.size, EXPECTED_PAGES.length);
  for (const page of EXPECTED_PAGES) {
    const absolutePath = path.join(pagesDir, page);
    assert.ok(entries.has(absolutePath), `missing: ${page}`);
  }
});

test('getSlidesEntries: キャッシュを再利用すること', () => {
  clearSlidesCache();
  const entries1 = getSlidesEntries(slidesFile);
  const entries2 = getSlidesEntries(slidesFile);
  assert.strictEqual(entries1, entries2, 'same reference (cached)');
});

test('getSlidesEntries: 存在しないファイル → 空Set', () => {
  clearSlidesCache();
  const entries = getSlidesEntries('/nonexistent/slides.md');
  assert.strictEqual(entries.size, 0);
});

test('clearSlidesCache: キャッシュクリア後は別インスタンスを返す', () => {
  clearSlidesCache();
  const entries1 = getSlidesEntries(slidesFile);
  clearSlidesCache();
  const entries2 = getSlidesEntries(slidesFile);
  assert.notStrictEqual(entries1, entries2, 'different reference after clear');
  assert.deepStrictEqual(entries1, entries2, 'same content');
});

test('require-slides-entry: meta.type が problem', () => {
  assert.strictEqual(requireSlidesEntryRule.meta?.type, 'problem');
});

test('require-slides-entry: missingEntry メッセージが定義されている', () => {
  const meta = requireSlidesEntryRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.missingEntry);
});

test('require-slides-entry: create が root/Program ビジターを返す', () => {
  const mockContext = {
    sourceCode: { getText: () => '' },
    filename: '/test.md',
  };
  const visitors = requireSlidesEntryRule.create(mockContext as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('require-slides-entry: 既存ページファイルでエラーが出ないこと', () => {
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

test('require-slides-entry: _references/ 配下のファイルはスキップ', () => {
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

test('require-slides-entry: slides.md に含まれないファイルでエラーを報告', () => {
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

test('require-slides-entry: pages/ 外のファイルはスキップ（slides.md が見つからない）', () => {
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

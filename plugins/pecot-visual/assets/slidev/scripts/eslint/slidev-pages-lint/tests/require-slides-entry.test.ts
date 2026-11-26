import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import { findSlidesFile, getSlidesEntries, clearSlidesCache } from '../lib/utils/slides-loader.ts';
import requireSlidesEntryRule from '../lib/rules/require-slides-entry.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

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

test('pages/ 配下のファイルを渡すと、slides.md を発見する', async () => {
  await explains('`slides.md` を探す `findSlidesFile` のテストです。`pages/` 配下のファイルを渡した場合に、対応する `slides.md` が見つかることを確認します。');
  const filePath = path.join(pagesDir, 'cover.md');
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, slidesFile);
});

test('pages/ 外のファイルを渡すと、null を返す', async () => {
  await explains('`pages/` の外のファイルを渡した場合に、`null` が返ることを確認します。');
  const filePath = path.join(templatesDir, 'README.md');
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, null);
});

test('slides.md が存在しないディレクトリを渡すと、null を返す', async () => {
  await explains('`slides.md` が存在しないディレクトリを渡した場合に、`null` が返ることを確認します。');
  const filePath = '/nonexistent/pages/test.md';
  const result = findSlidesFile(filePath);
  assert.strictEqual(result, null);
});

test('fixture deck の slides.md を読むと、全エントリを取得する', async () => {
  await explains('`slides.md` のエントリを取得する `getSlidesEntries` のテストです。fixture deck の `slides.md` を読んだ場合に、すべてのページが取得されることを確認します。');
  clearSlidesCache();
  const entries = getSlidesEntries(slidesFile);
  assert.strictEqual(entries.size, EXPECTED_PAGES.length);
  for (const page of EXPECTED_PAGES) {
    const absolutePath = path.join(pagesDir, page);
    assert.ok(entries.has(absolutePath), `missing: ${page}`);
  }
});

test('slides.md を 2 回読むと、キャッシュを再利用する', async () => {
  await explains('`slides.md` を 2 回読んだ場合に、同じインスタンスが返り、キャッシュが再利用されることを確認します。');
  clearSlidesCache();
  const entries1 = getSlidesEntries(slidesFile);
  const entries2 = getSlidesEntries(slidesFile);
  assert.strictEqual(entries1, entries2, 'same reference (cached)');
});

test('存在しないファイルを読むと、空の Set を返す', async () => {
  await explains('存在しない `slides.md` を読んだ場合に、空の `Set` が返ることを確認します。');
  clearSlidesCache();
  const entries = getSlidesEntries('/nonexistent/slides.md');
  assert.strictEqual(entries.size, 0);
});

test('キャッシュをクリアすると、次の読み込みで別のインスタンスを返す', async () => {
  await explains('キャッシュをクリアした場合に、次の読み込みで別のインスタンスが返り、内容は同じであることを確認します。');
  clearSlidesCache();
  const entries1 = getSlidesEntries(slidesFile);
  clearSlidesCache();
  const entries2 = getSlidesEntries(slidesFile);
  assert.notStrictEqual(entries1, entries2, 'different reference after clear');
  assert.deepStrictEqual(entries1, entries2, 'same content');
});

test('meta.type を読むと、problem を返す', async () => {
  await explains('ページが `slides.md` に登録されていることを検証する、`require-slides-entry` 規則のテストです。規則の `meta.type` が `problem` であることを確認します。');
  assert.strictEqual(requireSlidesEntryRule.meta?.type, 'problem');
});

test('メッセージを読むと、missingEntry が定義されている', async () => {
  await explains('規則のメッセージとして `missingEntry` が定義されていることを確認します。');
  const meta = requireSlidesEntryRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.missingEntry);
});

test('create を呼ぶと、root と Program のビジターを返す', async () => {
  await explains('`create` を呼んだ場合に、`root` と `Program` のビジターが関数として返ることを確認します。');
  const mockContext = {
    sourceCode: { getText: () => '' },
    filename: '/test.md',
  };
  const visitors = requireSlidesEntryRule.create(mockContext as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('既存のページファイルを渡すと、報告しない', async () => {
  await explains('`slides.md` に登録済みのページファイルを渡した場合に、報告されないことを確認します。');
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

test('_references/ 配下のファイルだと、スキップする', async () => {
  await explains('`_references/` 配下のファイルを渡した場合に、検証が行われず、報告されないことを確認します。');
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

test('slides.md に含まれないファイルを渡すと、missingEntry を報告する', async () => {
  await explains('`slides.md` に登録されていないファイルを渡した場合に、`missingEntry` が 1 件報告されることを確認します。');
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

test('pages/ 外のファイルだと、slides.md が見つからないのでスキップする', async () => {
  await explains('`pages/` の外のファイルを渡した場合に、`slides.md` を見つけられず、検証が行われないため、報告されないことを確認します。');
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

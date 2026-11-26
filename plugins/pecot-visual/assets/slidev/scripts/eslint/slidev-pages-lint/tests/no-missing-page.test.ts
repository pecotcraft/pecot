import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import noMissingPageRule from '../lib/rules/no-missing-page.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

const templatesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');
const slidesFile = path.join(templatesDir, 'slides.md');
const slidesContent = fs.readFileSync(slidesFile, 'utf-8');

interface MockReport {
  messageId?: string;
  data?: { filePath?: string };
  loc?: { line?: number };
}

test('meta.type を読むと、problem を返す', async () => {
  await explains('`no-missing-page` ルールの種類のテストです。ルールの `meta.type` を参照した場合に、`problem` であることを確認します。');
  assert.strictEqual(noMissingPageRule.meta?.type, 'problem');
});

test('メッセージを読むと、missingPage が定義されている', async () => {
  await explains('`no-missing-page` ルールのメッセージ定義のテストです。ルールのメッセージを参照した場合に、`missingPage` が定義されていることを確認します。');
  const meta = noMissingPageRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.missingPage);
});

test('create を呼ぶと、root と Program のビジターを返す', async () => {
  await explains('`no-missing-page` ルールの `create` のテストです。`create` を呼び出した場合に、`root` と `Program` のビジターが返ることを確認します。');
  const mockContext = {
    sourceCode: { getText: () => '' },
    filename: '/test/slides.md',
  };
  const visitors = noMissingPageRule.create(mockContext as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('fixture deck の slides.md を渡すと、報告しない', async () => {
  await explains('`no-missing-page` ルールが fixture deck の `slides.md` を検証するテストです。参照先がすべて存在する `slides.md` を渡した場合に、報告が 0 件であることを確認します。');
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

test('存在しないファイルを参照すると、missingPage を報告する', async () => {
  await explains('`no-missing-page` ルールが存在しないファイルへの参照を検出するテストです。存在しないページを `src` で参照した場合に、`missingPage` が 1 件、参照の行番号つきで報告されることを確認します。');
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

test('存在しないファイル参照が複数あると、参照ごとに報告する', async () => {
  await explains('`no-missing-page` ルールが複数の不正な参照を検出するテストです。存在しないファイルを 2 件参照した場合に、参照ごとにファイルのパスと行番号つきで報告されることを確認します。');
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

test('src: 行が無いファイルを渡すと、報告しない', async () => {
  await explains('`no-missing-page` ルールが `src:` 行のないファイルを検証するテストです。`src:` 行が存在しないファイルを渡した場合に、報告が 0 件であることを確認します。');
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

test('getText が失敗すると、スキップする', async () => {
  await explains('`no-missing-page` ルールが本文の取得に失敗した場合のテストです。`getText` が例外を投げた場合に、検証をスキップして報告が 0 件であることを確認します。');
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

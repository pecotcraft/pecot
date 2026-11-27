import { test } from 'vitest';
import assert from 'node:assert';
import noTripleHyphenInFrontmatter, {
  findExtraSeparators,
} from '../lib/rules/no-triple-hyphen-in-frontmatter.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

test('余分な --- が無い正常な frontmatter だと、検出しない', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。余分な `---` がない正常な frontmatter の場合に、空配列を返すことを確認します。');
  const code = `---
layout: default
---
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('frontmatter が無い（1 行目が --- でない）と、検出しない', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。frontmatter がない（1 行目が `---` でない）場合に、空配列を返すことを確認します。');
  const code = `# Hello
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('空文字列を渡すと、検出しない', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。空文字列の場合に、空配列を返すことを確認します。');
  assert.deepStrictEqual(findExtraSeparators(''), []);
});

test('null と undefined を渡すと、空配列を返す', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。`null` や `undefined` を渡した場合に、空配列を返すことを確認します。');
  assert.deepStrictEqual(findExtraSeparators(null as unknown as string), []);
  assert.deepStrictEqual(findExtraSeparators(undefined as unknown as string), []);
});

test('frontmatter が閉じていない（--- が 1 つだけ）と、検出しない', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。frontmatter が閉じていない（`---` が 1 つだけ）場合に、空配列を返すことを確認します。');
  const code = `---
layout: x
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('余分な --- が 1 箇所（3 個の --- 行）あると、その行を検出する', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。`---` の行が 3 つある場合に、余分な 3 つ目の行番号（5）を返すことを確認します。');
  const code = `---
title: "test"
---
layout: default
---
`;
  const result = findExtraSeparators(code);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], 5);
});

test('余分な --- が 2 箇所（4 個の --- 行）あると、2 箇所とも検出する', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。`---` の行が 4 つある場合に、余分な 2 か所の行番号（5 と 7）を返すことを確認します。');
  const code = `---
title: "test"
---
layout: default
---
description: "more"
---
`;
  const result = findExtraSeparators(code);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0], 5);
  assert.strictEqual(result[1], 7);
});

test('末尾にスペースが付いた "--- " でも、検出する', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。末尾に空白が付いた `--- ` の場合でも、余分な区切りとして検出することを確認します。');
  const code = `---
title: "test"
---
layout: default
---${' '}
`;
  const result = findExtraSeparators(code);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], 5);
});

test('"----"（4 ハイフン）だと、検出しない', async () => {
  await explains('frontmatter の余分な `---` を検出する、`findExtraSeparators` のテストです。ハイフンが 4 つの行（`----`）の場合に、区切りとみなさず検出しないことを確認します。');
  const code = `---
----
---
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('ルールオブジェクトを読むと、問題の種類・メッセージ・create 関数を持つ', async () => {
  await explains('ESLint ルール `no-triple-hyphen-in-frontmatter` の定義のテストです。`meta` に問題の種類（`problem`）とメッセージを持ち、`create` が関数であることを確認します。');
  assert.strictEqual(noTripleHyphenInFrontmatter.meta?.type, 'problem');
  assert.ok((noTripleHyphenInFrontmatter.meta as { messages: Record<string, string> }).messages.tripleHyphenInFrontmatter);
  assert.strictEqual(typeof noTripleHyphenInFrontmatter.create, 'function');
});

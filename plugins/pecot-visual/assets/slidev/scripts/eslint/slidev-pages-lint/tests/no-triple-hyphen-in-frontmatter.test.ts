import { test } from 'vitest';
import assert from 'node:assert';
import noTripleHyphenInFrontmatter, {
  findExtraSeparators,
} from '../lib/rules/no-triple-hyphen-in-frontmatter.ts';

test('余分な --- が無い正常な frontmatter だと、検出しない', () => {
  const code = `---
layout: default
---
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('frontmatter が無い（1 行目が --- でない）と、検出しない', () => {
  const code = `# Hello
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('空文字列を渡すと、検出しない', () => {
  assert.deepStrictEqual(findExtraSeparators(''), []);
});

test('null と undefined を渡すと、空配列を返す', () => {
  assert.deepStrictEqual(findExtraSeparators(null as unknown as string), []);
  assert.deepStrictEqual(findExtraSeparators(undefined as unknown as string), []);
});

test('frontmatter が閉じていない（--- が 1 つだけ）と、検出しない', () => {
  const code = `---
layout: x
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('余分な --- が 1 箇所（3 個の --- 行）あると、その行を検出する', () => {
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

test('余分な --- が 2 箇所（4 個の --- 行）あると、2 箇所とも検出する', () => {
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

test('末尾にスペースが付いた "--- " でも、検出する', () => {
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

test('"----"（4 ハイフン）だと、検出しない', () => {
  const code = `---
----
---
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('ルールオブジェクトを読むと、問題の種類・メッセージ・create 関数を持つ', () => {
  assert.strictEqual(noTripleHyphenInFrontmatter.meta?.type, 'problem');
  assert.ok((noTripleHyphenInFrontmatter.meta as { messages: Record<string, string> }).messages.tripleHyphenInFrontmatter);
  assert.strictEqual(typeof noTripleHyphenInFrontmatter.create, 'function');
});

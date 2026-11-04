import { test } from 'node:test';
import assert from 'node:assert';
import noTripleHyphenInFrontmatter, {
  findExtraSeparators,
} from '../lib/rules/no-triple-hyphen-in-frontmatter.ts';

test('no-triple-hyphen-in-frontmatter: 正常なフロントマター（余分な---なし）', () => {
  const code = `---
layout: default
---
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('no-triple-hyphen-in-frontmatter: フロントマターなし（1行目が---でない）', () => {
  const code = `# Hello
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('no-triple-hyphen-in-frontmatter: 空文字列', () => {
  assert.deepStrictEqual(findExtraSeparators(''), []);
});

test('no-triple-hyphen-in-frontmatter: null/undefinedは空配列', () => {
  assert.deepStrictEqual(findExtraSeparators(null as unknown as string), []);
  assert.deepStrictEqual(findExtraSeparators(undefined as unknown as string), []);
});

test('no-triple-hyphen-in-frontmatter: フロントマター未閉じ（---が1つだけ）', () => {
  const code = `---
layout: x
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('no-triple-hyphen-in-frontmatter: 余分な---が1箇所（3個の---行）', () => {
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

test('no-triple-hyphen-in-frontmatter: 余分な---が2箇所（4個の---行）', () => {
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

test('no-triple-hyphen-in-frontmatter: 末尾スペース付き "--- " も検出される', () => {
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

test('no-triple-hyphen-in-frontmatter: "----"（4ハイフン）は検出されない', () => {
  const code = `---
----
---
`;
  assert.deepStrictEqual(findExtraSeparators(code), []);
});

test('no-triple-hyphen-in-frontmatter: ルールオブジェクトが正しい構造を持つ', () => {
  assert.strictEqual(noTripleHyphenInFrontmatter.meta?.type, 'problem');
  assert.ok((noTripleHyphenInFrontmatter.meta as { messages: Record<string, string> }).messages.tripleHyphenInFrontmatter);
  assert.strictEqual(typeof noTripleHyphenInFrontmatter.create, 'function');
});

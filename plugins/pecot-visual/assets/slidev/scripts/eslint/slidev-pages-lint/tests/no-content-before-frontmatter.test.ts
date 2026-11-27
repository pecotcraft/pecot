import { test } from 'vitest';
import assert from 'node:assert';
import noContentBeforeFrontmatter, {
  hasContentBeforeFrontmatter,
} from '../lib/rules/no-content-before-frontmatter.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

test('frontmatter が先頭にあると、先頭に内容なしと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` が、frontmatter より前の内容を判定するテストです。frontmatter が先頭にある場合は、内容なしとして `false` を返すことを確認します。');
  const code = `---
layout: default
title: "Slide"
---

# Content
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('frontmatter だけのファイルを渡すと、先頭に内容なしと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` が、frontmatter だけのファイルを判定するテストです。本文を持たないファイルの場合に、内容なしとして `false` を返すことを確認します。');
  const code = `---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('frontmatter が無いファイルを渡すと、対象外として先頭に内容なしと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` が、frontmatter を持たないファイルを判定するテストです。frontmatter が存在しない場合は対象外として、`false` を返すことを確認します。');
  const code = `# No frontmatter
Just content.
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('空ファイルを渡すと、先頭に内容なしと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` に空の文字列を渡すテストです。空のファイルの場合に、内容なしとして `false` を返すことを確認します。');
  assert.strictEqual(hasContentBeforeFrontmatter(''), false);
});

test('null と undefined を渡すと、先頭に内容なしと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` に文字列以外を渡すテストです。`null` や `undefined` を渡した場合に、例外を発生させず `false` を返すことを確認します。');
  assert.strictEqual(hasContentBeforeFrontmatter(null as unknown as string), false);
  assert.strictEqual(hasContentBeforeFrontmatter(undefined as unknown as string), false);
});

test('HTML コメントの後に frontmatter があると、先頭に内容ありと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` が、frontmatter より前の HTML コメントを判定するテストです。コメントの後に frontmatter が続く場合に、内容ありとして `true` を返すことを確認します。');
  const code = `<!-- comment -->
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('テキストの後に frontmatter があると、先頭に内容ありと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` が、frontmatter より前の文字列を判定するテストです。テキストの後に frontmatter が続く場合に、内容ありとして `true` を返すことを確認します。');
  const code = `some text
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('空行の後に frontmatter があると、先頭に内容ありと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` が、frontmatter より前の空行を判定するテストです。空行の後に frontmatter が続く場合に、内容ありとして `true` を返すことを確認します。');
  const code = `
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('複数行のコメントの後に frontmatter があると、先頭に内容ありと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` が、複数行にわたる HTML コメントを判定するテストです。複数行のコメントの後に frontmatter が続く場合に、内容ありとして `true` を返すことを確認します。');
  const code = `<!--
  multi-line comment
-->
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('複数の空行の後に frontmatter があると、先頭に内容ありと判定する', async () => {
  await explains('`hasContentBeforeFrontmatter` が、連続する空行を判定するテストです。複数の空行の後に frontmatter が続く場合に、内容ありとして `true` を返すことを確認します。');
  const code = `


---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('ルールオブジェクトを読むと、問題の種類・メッセージ・create 関数を持つ', async () => {
  await explains('`no-content-before-frontmatter` ルールの定義のテストです。ルールオブジェクトが、問題の種類 `problem`、メッセージ `contentBeforeFrontmatter`、`create` 関数を持つことを確認します。');
  assert.strictEqual(noContentBeforeFrontmatter.meta?.type, 'problem');
  assert.ok((noContentBeforeFrontmatter.meta as { messages: Record<string, string> }).messages.contentBeforeFrontmatter);
  assert.strictEqual(typeof noContentBeforeFrontmatter.create, 'function');
});

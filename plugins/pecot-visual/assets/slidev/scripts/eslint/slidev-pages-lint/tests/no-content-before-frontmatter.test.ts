import { test } from 'vitest';
import assert from 'node:assert';
import noContentBeforeFrontmatter, {
  hasContentBeforeFrontmatter,
} from '../lib/rules/no-content-before-frontmatter.ts';

test('frontmatter が先頭にあると、先頭に内容なしと判定する', () => {
  const code = `---
layout: default
title: "Slide"
---

# Content
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('frontmatter だけのファイルを渡すと、先頭に内容なしと判定する', () => {
  const code = `---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('frontmatter が無いファイルを渡すと、対象外として先頭に内容なしと判定する', () => {
  const code = `# No frontmatter
Just content.
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('空ファイルを渡すと、先頭に内容なしと判定する', () => {
  assert.strictEqual(hasContentBeforeFrontmatter(''), false);
});

test('null と undefined を渡すと、先頭に内容なしと判定する', () => {
  assert.strictEqual(hasContentBeforeFrontmatter(null as unknown as string), false);
  assert.strictEqual(hasContentBeforeFrontmatter(undefined as unknown as string), false);
});

test('HTML コメントの後に frontmatter があると、先頭に内容ありと判定する', () => {
  const code = `<!-- comment -->
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('テキストの後に frontmatter があると、先頭に内容ありと判定する', () => {
  const code = `some text
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('空行の後に frontmatter があると、先頭に内容ありと判定する', () => {
  const code = `
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('複数行のコメントの後に frontmatter があると、先頭に内容ありと判定する', () => {
  const code = `<!--
  multi-line comment
-->
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('複数の空行の後に frontmatter があると、先頭に内容ありと判定する', () => {
  const code = `


---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('ルールオブジェクトを読むと、問題の種類・メッセージ・create 関数を持つ', () => {
  assert.strictEqual(noContentBeforeFrontmatter.meta?.type, 'problem');
  assert.ok((noContentBeforeFrontmatter.meta as { messages: Record<string, string> }).messages.contentBeforeFrontmatter);
  assert.strictEqual(typeof noContentBeforeFrontmatter.create, 'function');
});

import { test } from 'node:test';
import assert from 'node:assert';
import noContentBeforeFrontmatter, {
  hasContentBeforeFrontmatter,
} from '../lib/rules/no-content-before-frontmatter.ts';

test('no-content-before-frontmatter: frontmatterが先頭にある場合は正常', () => {
  const code = `---
layout: default
title: "Slide"
---

# Content
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('no-content-before-frontmatter: frontmatterのみのファイルは正常', () => {
  const code = `---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('no-content-before-frontmatter: frontmatterなしのファイルは対象外（正常）', () => {
  const code = `# No frontmatter
Just content.
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), false);
});

test('no-content-before-frontmatter: 空ファイルは正常', () => {
  assert.strictEqual(hasContentBeforeFrontmatter(''), false);
});

test('no-content-before-frontmatter: null/undefinedは正常', () => {
  assert.strictEqual(hasContentBeforeFrontmatter(null as unknown as string), false);
  assert.strictEqual(hasContentBeforeFrontmatter(undefined as unknown as string), false);
});

test('no-content-before-frontmatter: HTMLコメント後にfrontmatterがある場合は違反', () => {
  const code = `<!-- comment -->
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('no-content-before-frontmatter: テキスト後にfrontmatterがある場合は違反', () => {
  const code = `some text
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('no-content-before-frontmatter: 空行後にfrontmatterがある場合は違反', () => {
  const code = `
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('no-content-before-frontmatter: 複数行のコメント後にfrontmatterがある場合は違反', () => {
  const code = `<!--
  multi-line comment
-->
---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('no-content-before-frontmatter: 空行複数行後にfrontmatterがある場合は違反', () => {
  const code = `


---
layout: default
---
`;
  assert.strictEqual(hasContentBeforeFrontmatter(code), true);
});

test('no-content-before-frontmatter: ルールオブジェクトが正しい構造を持つ', () => {
  assert.strictEqual(noContentBeforeFrontmatter.meta?.type, 'problem');
  assert.ok((noContentBeforeFrontmatter.meta as { messages: Record<string, string> }).messages.contentBeforeFrontmatter);
  assert.strictEqual(typeof noContentBeforeFrontmatter.create, 'function');
});

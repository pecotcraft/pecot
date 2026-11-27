import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import maxCharsRule from '../lib/rules/max-chars.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

describe('max-chars ルール構造', () => {
  it('meta を読むと、type・docs・maxChars と emptyText のメッセージが定義されている', async () => {
    await explains('`max-chars` ルールの `meta` のテストです。種類が `problem` で、`docs` と、`maxChars` および `emptyText` のメッセージが定義されていることを確認します。');
    const meta = maxCharsRule.meta as { type: string; docs: unknown; messages: Record<string, string> };
    assert.strictEqual(meta.type, 'problem');
    assert.ok(meta.docs);
    assert.ok(meta.messages.maxChars);
    assert.ok(meta.messages.emptyText);
  });

  it('meta.messages を読むと、maxItems のメッセージが array items を含んで定義されている', async () => {
    await explains('`max-chars` ルールの `maxItems` メッセージのテストです。メッセージが定義され、本文に `array items` が含まれることを確認します。');
    const meta = maxCharsRule.meta as { messages: Record<string, string> };
    assert.ok(meta.messages.maxItems);
    assert.ok(meta.messages.maxItems.includes('array items'));
  });

  it('create を参照すると、関数を返す', async () => {
    await explains('`max-chars` ルールの `create` のテストです。`create` が関数として定義されていることを確認します。');
    assert.strictEqual(typeof maxCharsRule.create, 'function');
  });

  it('create を呼ぶと、root と Program のビジターを関数で返す', async () => {
    await explains('`max-chars` ルールの `create` を呼び出すテストです。ルールのコンテキストを渡した場合に、`root` と `Program` のビジターを、どちらも関数として返すことを確認します。');
    const visitors = maxCharsRule.create({
      sourceCode: { getText: () => '' },
      filename: '/test/pages/test.md',
    } as never) as unknown as Record<string, unknown>;
    assert.ok(visitors.root);
    assert.ok(visitors.Program);
    assert.strictEqual(typeof visitors.root, 'function');
    assert.strictEqual(typeof visitors.Program, 'function');
  });
});

describe('max-chars 実データ検証（統合テスト的）', () => {
  it('constraint-loader を import すると、parseFrontmatter と getTextConstraints が関数で取れる', async () => {
    await explains('`constraint-loader` モジュールの公開関数のテストです。モジュールを読み込んだ場合に、`parseFrontmatter` と `getTextConstraints` が関数として取得できることを確認します。');
    const { parseFrontmatter, getTextConstraints } = await import(
      '../lib/utils/constraint-loader.ts'
    );
    assert.strictEqual(typeof parseFrontmatter, 'function');
    assert.strictEqual(typeof getTextConstraints, 'function');
  });

  it('cover レイアウトの frontmatter を渡すと、layout と coverTitle を読み取る', async () => {
    await explains('`parseFrontmatter` が cover レイアウトの frontmatter を解析するテストです。`layout` が `cover` で `coverTitle` を持つ frontmatter の場合に、両方の値を取得することを確認します。');
    const { parseFrontmatter } = await import('../lib/utils/constraint-loader.ts');
    const md = `---
layout: cover
coverTitle: "Presentation Title"
eyebrow: "SUBTITLE TEXT"
date: "February 2026"
---`;
    const fm = parseFrontmatter(md) as { layout: string; coverTitle: string };
    assert.strictEqual(fm.layout, 'cover');
    assert.strictEqual(fm.coverTitle, 'Presentation Title');
  });

  it('text_constraints が空のオブジェクトだと、空のオブジェクトを返す', async () => {
    await explains('`getTextConstraints` のテストです。`text_constraints` が空のオブジェクトの場合に、空のオブジェクトを返すことを確認します。');
    const { getTextConstraints } = await import('../lib/utils/constraint-loader.ts');
    const constraints = getTextConstraints({ text_constraints: {} });
    assert.deepStrictEqual(constraints, {});
  });

  it('text_constraints にレイアウト固有の制約があると、その制約を返す', async () => {
    await explains('`getTextConstraints` のテストです。`text_constraints` に `coverTitle` の制約が指定されている場合に、その `max_chars` の値を含めて返すことを確認します。');
    const { getTextConstraints } = await import('../lib/utils/constraint-loader.ts');
    const reference = {
      text_constraints: {
        coverTitle: { max_chars: 9 },
      },
    };
    const constraints = getTextConstraints(reference);
    assert.ok(constraints.coverTitle);
    assert.strictEqual(constraints.coverTitle.max_chars, 9);
  });

  it('text_constraints が無いと、空のオブジェクトを返す', async () => {
    await explains('`getTextConstraints` のテストです。reference が `text_constraints` を持たない場合に、空のオブジェクトを返すことを確認します。');
    const { getTextConstraints } = await import('../lib/utils/constraint-loader.ts');
    const constraints = getTextConstraints({});
    assert.deepStrictEqual(constraints, {});
  });

  it('includes が空でも、text_constraints のキーを返す', async () => {
    await explains('`getTextConstraints` のテストです。`includes` が空の配列でも、`text_constraints` に指定した `titleContent.label` の制約を返すことを確認します。');
    const { getTextConstraints } = await import('../lib/utils/constraint-loader.ts');
    const reference = {
      includes: [],
      text_constraints: {
        'titleContent.label': { max_chars: 19 },
      },
    };
    const constraints = getTextConstraints(reference);
    assert.ok(constraints['titleContent.label']);
  });
});

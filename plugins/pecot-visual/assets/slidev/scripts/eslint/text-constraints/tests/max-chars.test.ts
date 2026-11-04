import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import maxCharsRule from '../lib/rules/max-chars.ts';

describe('max-chars ルール構造', () => {
  it('meta が正しく定義されている', () => {
    const meta = maxCharsRule.meta as { type: string; docs: unknown; messages: Record<string, string> };
    assert.strictEqual(meta.type, 'problem');
    assert.ok(meta.docs);
    assert.ok(meta.messages.maxChars);
    assert.ok(meta.messages.emptyText);
  });

  it('meta.messages.maxItems が定義されている', () => {
    const meta = maxCharsRule.meta as { messages: Record<string, string> };
    assert.ok(meta.messages.maxItems);
    assert.ok(meta.messages.maxItems.includes('配列要素数'));
  });

  it('create が関数を返す', () => {
    assert.strictEqual(typeof maxCharsRule.create, 'function');
  });

  it('create が root と Program ビジターを返す', () => {
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
  it('constraint-loader の import が正しく動作する', async () => {
    const { parseFrontmatter, getTextConstraints } = await import(
      '../lib/utils/constraint-loader.ts'
    );
    assert.strictEqual(typeof parseFrontmatter, 'function');
    assert.strictEqual(typeof getTextConstraints, 'function');
  });

  it('parseFrontmatter で coverレイアウトをパースできる', async () => {
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

  it('getTextConstraints で空オブジェクトを正しく処理する', async () => {
    const { getTextConstraints } = await import('../lib/utils/constraint-loader.ts');
    const constraints = getTextConstraints({ text_constraints: {} });
    assert.deepStrictEqual(constraints, {});
  });

  it('getTextConstraints でレイアウト固有の制約を取得する', async () => {
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

  it('getTextConstraints で text_constraints がない場合は空オブジェクト', async () => {
    const { getTextConstraints } = await import('../lib/utils/constraint-loader.ts');
    const constraints = getTextConstraints({});
    assert.deepStrictEqual(constraints, {});
  });

  it('getTextConstraints で includes の text_constraints もマージする', async () => {
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

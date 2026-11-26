import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { validateSchema } from '../lib/schema-validator.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

describe('schema-validator', () => {
  describe('layout files', () => {
    it('必須の項目がすべてそろったレイアウトのファイルを渡すと、検証を通す', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。必須の項目がすべて存在するデータの場合に、検証に成功し、エラーが 0 件であることを確認します。');
      const data = {
        layout: 'cover',
        category: 'figure',
        description: 'Cover slide',
        includes: ['_common'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Use short titles'],
        anti_patterns: ['Avoid long text'],
        examples: [{ name: 'Basic', frontmatter: '---\nlayout: cover\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('props を持つレイアウトのファイルを渡すと、検証を通す', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`props` と `text_constraints` を持つデータの場合に、検証に成功することを確認します。');
      const data = {
        layout: 'cover',
        category: 'figure',
        description: 'Cover slide',
        includes: ['_common'],
        props: { title: { type: 'String', description: 'Slide title' } },
        text_constraints: { title: { max_chars: 20 } },
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Use short titles'],
        anti_patterns: ['Avoid long text'],
        examples: [{ name: 'Basic', frontmatter: '---\nlayout: cover\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
    });

    it('props を持たないレイアウトのファイルを渡すと、検証を通す', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`props` が存在しないデータの場合にも、検証に成功することを確認します。');
      const data = {
        layout: 'end',
        category: 'figure',
        description: 'End slide',
        includes: ['_common', '_footer'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Use defaults'],
        anti_patterns: ['Do not skip'],
        examples: [{ name: 'Basic', frontmatter: '---\nlayout: end\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
    });

    it('レイアウトのファイルに description が無いと、検証に失敗する', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`description` が存在しないデータの場合に、検証に失敗し、エラーに `description` が含まれることを確認します。');
      const data = {
        layout: 'cover',
        category: 'figure',
        includes: ['_common'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Tip'],
        anti_patterns: ['Bad'],
        examples: [{ name: 'Basic', frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.message.includes('description')));
    });

    it('レイアウトのファイルに includes が無いと、検証に失敗する', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`includes` が存在しないデータの場合に、検証に失敗することを確認します。');
      const data = {
        layout: 'cover',
        category: 'figure',
        description: 'Cover slide',
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Tip'],
        anti_patterns: ['Bad'],
        examples: [{ name: 'Basic', frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('clicks.supported が無いと、検証に失敗する', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`clicks` に `supported` が存在しないデータの場合に、検証に失敗することを確認します。');
      const data = {
        layout: 'cover',
        category: 'figure',
        description: 'Cover slide',
        includes: ['_common'],
        text_constraints: {},
        clicks: {},
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Tip'],
        anti_patterns: ['Bad'],
        examples: [{ name: 'Basic', frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('best_practices が空だと、検証に失敗する', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`best_practices` が空の配列のデータの場合に、検証に失敗することを確認します。');
      const data = {
        layout: 'cover',
        category: 'figure',
        description: 'Cover slide',
        includes: ['_common'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: [],
        anti_patterns: ['Bad'],
        examples: [{ name: 'Basic', frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('レイアウトのファイルに category が無いと、検証に失敗する', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`category` が存在しないデータの場合に、検証に失敗し、エラーに `category` が含まれることを確認します。');
      const data = {
        layout: 'cover',
        description: 'Cover slide',
        includes: ['_common'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Tip'],
        anti_patterns: ['Bad'],
        examples: [{ name: 'Basic', frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.message.includes('category')));
    });

    it('category が空文字列だと、検証に失敗する', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`category` が空の文字列のデータの場合に、検証に失敗することを確認します。');
      const data = {
        layout: 'cover',
        description: 'Cover slide',
        category: '',
        includes: ['_common'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Tip'],
        anti_patterns: ['Bad'],
        examples: [{ name: 'Basic', frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('category の無い hidden のレイアウトのファイルを渡すと、検証を通す', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`status` が `hidden` のレイアウトの場合は、`category` が存在しなくても、検証に成功することを確認します。');
      const data = {
        layout: 'card-render-test',
        description: 'Rendering fixture',
        status: 'hidden',
        includes: ['_common'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Tip'],
        anti_patterns: ['Bad'],
        examples: [{ name: 'Basic', frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('category の無い deprecated のレイアウトのファイルを渡すと、検証に失敗する', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`status` が `deprecated` のレイアウトで `category` が存在しない場合に、検証に失敗し、エラーに `category` が含まれることを確認します。');
      const data = {
        layout: 'visual-left',
        description: 'Legacy layout',
        status: 'deprecated',
        includes: ['_common'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Tip'],
        anti_patterns: ['Bad'],
        examples: [{ name: 'Basic', frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.message.includes('category')));
    });

    it('examples の要素に name が無いと、検証に失敗する', async () => {
      await explains('レイアウトの reference を検証する `validateSchema` のテストです。`examples` の要素が `name` を持たない場合に、検証に失敗することを確認します。');
      const data = {
        layout: 'cover',
        category: 'figure',
        description: 'Cover slide',
        includes: ['_common'],
        text_constraints: {},
        clicks: { supported: false },
        pptx: { supported: true, known_issues: [] },
        best_practices: ['Tip'],
        anti_patterns: ['Bad'],
        examples: [{ frontmatter: '---\n---' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });
  });

  describe('props validation', () => {
    const baseLayout = {
      layout: 'test',
      category: 'figure',
      description: 'Test layout',
      includes: ['_common'],
      text_constraints: {},
      clicks: { supported: false },
      pptx: { supported: true },
      best_practices: ['Tip'],
      anti_patterns: ['Bad'],
      examples: [{ name: 'Basic', frontmatter: '---\nlayout: test\n---' }],
    };

    it('type・description・default を持つ単純な props を渡すと、検証を通す', async () => {
      await explains('`props` の検証のテストです。`type`・`description`・`default` を持つ単純な prop の場合に、検証に成功し、エラーが 0 件であることを確認します。');
      const data = {
        ...baseLayout,
        props: {
          title: { type: 'String', description: 'Slide title', default: "''" },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('type が Object で子の props を持つ props を渡すと、検証を通す', async () => {
      await explains('`props` の検証のテストです。`type` が `Object` で、子の `props` を持つ prop の場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          config: {
            type: 'Object',
            description: 'Configuration object',
            props: {
              color: { type: 'String', description: 'Color value' },
            },
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('type が Array で items を持つ props を渡すと、検証を通す', async () => {
      await explains('`props` の検証のテストです。`type` が `Array` で、`items` を持つ prop の場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          tags: {
            type: 'Array',
            description: 'Tag list',
            items: {
              label: { type: 'String', description: 'Tag label' },
            },
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('v-html・required・enum を持つ props を渡すと、検証を通す', async () => {
      await explains('`props` の検証のテストです。`v-html`・`required`・`enum` を持つ prop の場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          content: {
            type: 'String',
            description: 'HTML content',
            'v-html': true,
            required: true,
            enum: ['left', 'center', 'right'],
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('props に children のキーがあると、検証に失敗する', async () => {
      await explains('`props` の検証のテストです。廃止された `children` のキーを持つ prop の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          container: {
            type: 'Object',
            description: 'Container element',
            children: {
              item: { type: 'String', description: 'Child item' },
            },
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('props に element のキーがあると、検証に失敗する', async () => {
      await explains('`props` の検証のテストです。廃止された `element` のキーを持つ prop の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          list: {
            type: 'Array',
            description: 'List of elements',
            element: {
              name: { type: 'String', description: 'Element name' },
            },
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('props に note のキーがあると、検証を通す', async () => {
      await explains('`props` の検証のテストです。補足の `note` のキーを持つ prop の場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          title: {
            type: 'String',
            description: 'Title text',
            note: 'Keep it short',
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('配列の props に same_length_as のキーがあると、検証を通す', async () => {
      await explains('`props` の検証のテストです。配列の prop が、別の prop 名を指定した `same_length_as` を持つ場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          rows: { type: 'Array', description: 'Row list' },
          items: {
            type: 'Array',
            description: 'Item list',
            same_length_as: 'rows',
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('same_length_as の値が文字列でないと、検証に失敗する', async () => {
      await explains('`props` の検証のテストです。`same_length_as` の値が文字列でなく数値の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          items: {
            type: 'Array',
            description: 'Item list',
            same_length_as: 123,
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('props に許可されていないキーがあると、検証に失敗する', async () => {
      await explains('`props` の検証のテストです。仕様で許可していない `max_chars_per_line` のキーを持つ prop の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          title: {
            type: 'String',
            description: 'Title',
            max_chars_per_line: 40,
          },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('props に type が無いと、検証に失敗する', async () => {
      await explains('`props` の検証のテストです。`type` が存在しない prop の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          title: { description: 'Title text' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('props に description が無いと、検証に失敗する', async () => {
      await explains('`props` の検証のテストです。`description` が存在しない prop の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          title: { type: 'String' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('props の type が不正な値だと、検証に失敗する', async () => {
      await explains('`props` の検証のテストです。`type` に定義されていない値 `Str` を指定した場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        props: {
          title: { type: 'Str', description: 'Title' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('ネストした props に違反があると、YAML のキーのパスで報告する', async () => {
      await explains('`props` の検証エラーの位置のテストです。入れ子の prop に違反がある場合に、エラーの `path` が、YAML のキーのパス（`/props/title` や `/props/title/type`）になることを確認します。');
      const data = {
        ...baseLayout,
        props: { title: { type: 'Str' } },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.path === '/props/title'));
      assert.ok(result.errors.some((e) => e.path === '/props/title/type'));
    });
  });

  describe('text_constraints validation', () => {
    const baseLayout = {
      layout: 'test',
      category: 'figure',
      description: 'Test layout',
      includes: ['_common'],
      clicks: { supported: false },
      pptx: { supported: true },
      best_practices: ['Tip'],
      anti_patterns: ['Bad'],
      examples: [{ name: 'Basic', frontmatter: '---\nlayout: test\n---' }],
    };

    it('min_chars と max_chars を持つ text_constraints を渡すと、検証を通す', async () => {
      await explains('`text_constraints` の検証のテストです。`min_chars` と `max_chars` を持つ制約の場合に、検証に成功し、エラーが 0 件であることを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          title: { min_chars: 5, max_chars: 20 },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('note を持つ text_constraints を渡すと、検証を通す', async () => {
      await explains('`text_constraints` の検証のテストです。補足の `note` を持つ制約の場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          title: { max_chars: 20, note: 'Keep concise' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('max_items を持つ text_constraints を渡すと、検証を通す', async () => {
      await explains('`text_constraints` の検証のテストです。`max_items` を持つ制約の場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          chatMessages: { max_items: 6, note: '3ラリー上限' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('min_items を持つ text_constraints を渡すと、検証を通す', async () => {
      await explains('`text_constraints` の検証のテストです。`min_items` を持つ制約の場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          rows: { min_items: 3, max_items: 6, note: '行は 3 件以上' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('min_items が 0 だと、検証に失敗する', async () => {
      await explains('`text_constraints` の検証のテストです。`min_items` が 1 未満の 0 の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          rows: { min_items: 0 },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('min_items が負の数だと、検証に失敗する', async () => {
      await explains('`text_constraints` の検証のテストです。`min_items` が負の数の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          rows: { min_items: -1 },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('min_items が文字列だと、検証に失敗する', async () => {
      await explains('`text_constraints` の検証のテストです。`min_items` が数値でなく文字列の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          rows: { min_items: 'three' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('bold_required を持つ text_constraints を渡すと、検証を通す', async () => {
      await explains('`text_constraints` の検証のテストです。真偽値の `bold_required` を持つ制約の場合に、検証に成功することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          'items[].description': { min_chars: 10, max_chars: 90, bold_required: true },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('bold_required が文字列だと、検証に失敗する', async () => {
      await explains('`text_constraints` の検証のテストです。`bold_required` が真偽値でなく文字列の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          'items[].description': { bold_required: 'true' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('max_items が負の数だと、検証に失敗する', async () => {
      await explains('`text_constraints` の検証のテストです。`max_items` が負の数の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          chatMessages: { max_items: -1 },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('max_items が文字列だと、検証に失敗する', async () => {
      await explains('`text_constraints` の検証のテストです。`max_items` が数値でなく文字列の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          chatMessages: { max_items: 'six' },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('text_constraints に許可されていないキーがあると、検証に失敗する', async () => {
      await explains('`text_constraints` の検証のテストです。仕様で許可していない `max_chars_per_line` のキーを持つ制約の場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          title: { max_chars_per_line: 40 },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });

    it('max_chars が数値でないと、検証に失敗する', async () => {
      await explains('`text_constraints` の検証のテストです。`max_chars` が数値でなくオブジェクトの場合に、検証に失敗することを確認します。');
      const data = {
        ...baseLayout,
        text_constraints: {
          title: { max_chars: { en: 40, ja: 20 } },
        },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
    });
  });

  describe('shared files', () => {
    it('description だけの共有ファイルを渡すと、検証を通す', async () => {
      await explains('共有ファイルを検証する `validateSchema` のテストです。`description` だけを持つデータの場合に、検証に成功することを確認します。');
      const data = { description: 'Common properties' };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
    });

    it('description と props を持つ共有ファイルを渡すと、検証を通す', async () => {
      await explains('共有ファイルを検証する `validateSchema` のテストです。`description` と `props` を持つデータの場合に、検証に成功することを確認します。');
      const data = {
        description: 'Header props',
        props: { minimalHeader: { type: 'Boolean', default: 'false' } },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
    });

    it('追加のプロパティを持つ共有ファイルを渡すと、検証を通す', async () => {
      await explains('共有ファイルを検証する `validateSchema` のテストです。定義にない追加のプロパティを持つデータの場合にも、検証に成功することを確認します。');
      const data = {
        description: 'Common properties',
        props: { sensitivity: {} },
        presentation_flow: { recommended_structure: {} },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
    });

    it('layout_categories を持つ共有ファイルを渡すと、検証を通す', async () => {
      await explains('共有ファイルを検証する `validateSchema` のテストです。`id`・`label`・`question` を持つ `layout_categories` を含むデータの場合に、検証に成功することを確認します。');
      const data = {
        description: 'Common properties',
        layout_categories: [
          { id: 'figure', label: '図', question: '図で見せる' },
          { id: 'table', label: '表', question: '軸のある表で見せる' },
        ],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('layout_categories の要素に question が無いと、検証に失敗する', async () => {
      await explains('共有ファイルを検証する `validateSchema` のテストです。`layout_categories` の要素が `question` を持たない場合に、検証に失敗することを確認します。');
      const data = {
        description: 'Common properties',
        layout_categories: [{ id: 'figure', label: '図' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('layout_categories の要素に未知のキーがあると、検証に失敗する', async () => {
      await explains('共有ファイルを検証する `validateSchema` のテストです。`layout_categories` の要素に未定義のキーがある場合に、検証に失敗することを確認します。');
      const data = {
        description: 'Common properties',
        layout_categories: [{ id: 'figure', label: '図', question: '図で見せる', note: 'x' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('layout_categories が配列でないと、検証に失敗する', async () => {
      await explains('共有ファイルを検証する `validateSchema` のテストです。`layout_categories` が配列でなくオブジェクトの場合に、検証に失敗することを確認します。');
      const data = {
        description: 'Common properties',
        layout_categories: { figure: '図' },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('共有ファイルに description が無いと、検証に失敗する', async () => {
      await explains('共有ファイルを検証する `validateSchema` のテストです。`description` が存在しないデータの場合に、検証に失敗することを確認します。');
      const data = {
        props: { sensitivity: { type: 'String' } },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });
  });
});

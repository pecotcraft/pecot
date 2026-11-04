import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../lib/schema-validator.ts';

describe('schema-validator', () => {
  describe('layout files', () => {
    it('should pass a valid layout file with all required fields', () => {
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

    it('should pass a layout file with props', () => {
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

    it('should pass a layout file without props (like end.yaml)', () => {
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

    it('should fail when layout file is missing description', () => {
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

    it('should fail when layout file is missing includes', () => {
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

    it('should fail when clicks.supported is missing', () => {
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

    it('should fail when best_practices is empty', () => {
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

    it('should fail when layout file is missing category', () => {
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

    it('should fail when category is an empty string', () => {
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

    it('should pass a hidden layout file without category', () => {
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

    it('should fail when a deprecated layout file is missing category', () => {
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

    it('should fail when examples item is missing name', () => {
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

    it('should pass flat props with type, description, and default', () => {
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

    it('should pass nested props with type Object and sub-props', () => {
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

    it('should pass array props with type Array and items', () => {
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

    it('should pass props with v-html, required, and enum fields', () => {
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

    it('should fail props with children key (nested schema uses props/items)', () => {
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

    it('should fail props with element key (nested schema uses props/items)', () => {
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

    it('should pass props with note key', () => {
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

    it('should pass array props with same_length_as key', () => {
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

    it('should fail props with non-string same_length_as value', () => {
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

    it('should fail props with disallowed key', () => {
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

    it('should fail props when type is missing', () => {
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

    it('should fail props when description is missing', () => {
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

    it('should fail props with invalid type value', () => {
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

    it('should pass text_constraints with min_chars and max_chars', () => {
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

    it('should pass text_constraints with note', () => {
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

    it('should pass text_constraints with max_items', () => {
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

    it('should pass text_constraints with min_items', () => {
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

    it('should fail text_constraints with invalid min_items (zero)', () => {
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

    it('should fail text_constraints with invalid min_items (negative)', () => {
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

    it('should fail text_constraints with invalid min_items (string)', () => {
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

    it('should pass text_constraints with bold_required', () => {
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

    it('should fail text_constraints with invalid bold_required (string)', () => {
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

    it('should fail text_constraints with invalid max_items (negative)', () => {
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

    it('should fail text_constraints with invalid max_items (string)', () => {
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

    it('should fail text_constraints with disallowed key', () => {
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

    it('should fail text_constraints when max_chars is not a number', () => {
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
    it('should pass a valid shared file with just description', () => {
      const data = { description: 'Common properties' };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
    });

    it('should pass a shared file with description and props', () => {
      const data = {
        description: 'Header props',
        props: { minimalHeader: { type: 'Boolean', default: 'false' } },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
    });

    it('should pass a shared file with additional properties', () => {
      const data = {
        description: 'Common properties',
        props: { sensitivity: {} },
        presentation_flow: { recommended_structure: {} },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, true);
    });

    it('should pass a shared file with layout_categories', () => {
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

    it('should fail when a layout_categories item is missing question', () => {
      const data = {
        description: 'Common properties',
        layout_categories: [{ id: 'figure', label: '図' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('should fail when a layout_categories item has an unknown key', () => {
      const data = {
        description: 'Common properties',
        layout_categories: [{ id: 'figure', label: '図', question: '図で見せる', note: 'x' }],
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('should fail when layout_categories is not an array', () => {
      const data = {
        description: 'Common properties',
        layout_categories: { figure: '図' },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });

    it('should fail when shared file is missing description', () => {
      const data = {
        props: { sensitivity: { type: 'String' } },
      };
      const result = validateSchema(data);
      assert.equal(result.valid, false);
    });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { validateSemantics } from '../lib/semantic-validator.ts';
import { join } from 'node:path';

const REFS_DIR = join(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references');

interface GanttTask {
  id: string;
  name: string;
  start: string;
  end: string;
  children?: GanttTask[];
}

describe('semantic-validator', () => {
  describe('text-constraints/min-max', () => {
    it('should pass when min_chars <= max_chars', () => {
      const data = {
        layout: 'test',
        text_constraints: {
          title: { min_chars: 5, max_chars: 18 },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const minMaxErrors = errors.filter((e) => e.rule === 'text-constraints/min-max');
      assert.equal(minMaxErrors.length, 0);
    });

    it('should fail when min_chars > max_chars', () => {
      const data = {
        layout: 'test',
        text_constraints: {
          title: { min_chars: 50, max_chars: 5 },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const minMaxErrors = errors.filter((e) => e.rule === 'text-constraints/min-max');
      assert.equal(minMaxErrors.length, 1);
    });

    it('should fail when min_items > max_items', () => {
      const data = {
        layout: 'test',
        text_constraints: {
          rows: { min_items: 7, max_items: 6 },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const minMaxErrors = errors.filter((e) => e.rule === 'text-constraints/min-max');
      assert.equal(minMaxErrors.length, 1);
    });

    it('should pass when min_items == max_items', () => {
      const data = {
        layout: 'test',
        text_constraints: {
          rows: { min_items: 3, max_items: 3 },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const minMaxErrors = errors.filter((e) => e.rule === 'text-constraints/min-max');
      assert.equal(minMaxErrors.length, 0);
    });

    it('should skip when text_constraints is empty object', () => {
      const data = {
        layout: 'test',
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const minMaxErrors = errors.filter((e) => e.rule === 'text-constraints/min-max');
      assert.equal(minMaxErrors.length, 0);
    });
  });

  describe('text-constraints/allowed-keys', () => {
    it('should pass when max_items is used as constraint key', () => {
      const data = {
        layout: 'test',
        text_constraints: {
          chatMessages: { max_items: 6 },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const keyErrors = errors.filter((e) => e.rule === 'text-constraints/allowed-keys');
      assert.equal(keyErrors.length, 0);
    });

    it('should pass when min_items is used as constraint key', () => {
      const data = {
        layout: 'test',
        text_constraints: {
          rows: { min_items: 3, max_items: 6 },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const keyErrors = errors.filter((e) => e.rule === 'text-constraints/allowed-keys');
      assert.equal(keyErrors.length, 0);
    });
  });

  describe('text-constraints/bold-required', () => {
    function makeData(descriptions: string[]) {
      const items = descriptions.map((d) => `    - description: ${d}`).join('\n');
      return {
        layout: 'test',
        text_constraints: {
          'items[].description': { min_chars: 1, max_chars: 90, bold_required: true },
        },
        examples: [
          {
            name: 'bold',
            frontmatter: `---\nlayout: test\nitems:\n${items}\n---`,
          },
        ],
      };
    }

    function boldErrors(data: Parameters<typeof validateSemantics>[0]) {
      return validateSemantics(data, join(REFS_DIR, 'test.yaml')).filter(
        (e) => e.rule === 'text-constraints/bold-required',
      );
    }

    it('should accept bold_required as a constraint key', () => {
      const errors = validateSemantics(
        { layout: 'test', text_constraints: { title: { bold_required: true } } },
        join(REFS_DIR, 'test.yaml'),
      );
      assert.equal(errors.filter((e) => e.rule === 'text-constraints/allowed-keys').length, 0);
    });

    it('should pass when example text has <strong>', () => {
      assert.equal(boldErrors(makeData(['"<strong>要点</strong>のある説明"'])).length, 0);
    });

    it('should fail when example text has no bold emphasis', () => {
      const errors = boldErrors(makeData(['"太字のない説明"']));
      assert.equal(errors.length, 1);
      assert.ok(errors[0].message.includes('items[0].description'));
    });

    it('should fail when example text uses <b> instead of <strong>', () => {
      assert.equal(boldErrors(makeData(['"<b>要点</b>のある説明"'])).length, 1);
    });

    it('should report per array element', () => {
      const errors = boldErrors(
        makeData(['"太字なし"', '"<strong>要点</strong>あり"', '"これも太字なし"']),
      );
      assert.equal(errors.length, 2);
      assert.ok(errors[0].message.includes('items[0].description'));
      assert.ok(errors[1].message.includes('items[2].description'));
    });

    it('should skip bold check when bold_required is absent', () => {
      const data = {
        layout: 'test',
        text_constraints: { 'items[].description': { max_chars: 90 } },
        examples: [
          {
            name: 'no-bold-constraint',
            frontmatter: '---\nlayout: test\nitems:\n    - description: "太字のない説明"\n---',
          },
        ],
      };
      assert.equal(boldErrors(data).length, 0);
    });
  });

  describe('includes/file-exists', () => {
    it('should pass when included files exist', () => {
      const data = {
        layout: 'cover',
        includes: ['_common', '_footer'],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      const includeErrors = errors.filter((e) => e.rule === 'includes/file-exists');
      assert.equal(includeErrors.length, 0);
    });

    it('should fail when included file does not exist', () => {
      const data = {
        layout: 'test',
        includes: ['_nonexistent'],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const includeErrors = errors.filter((e) => e.rule === 'includes/file-exists');
      assert.equal(includeErrors.length, 1);
      assert.ok(includeErrors[0].message.includes('_nonexistent'));
    });
  });

  describe('includes/props-collision', () => {
    it('should pass when no props collide with includes', () => {
      const data = {
        layout: 'cover',
        includes: ['_common', '_footer'],
        props: { coverTitle: {}, eyebrow: {} },
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      const collisionErrors = errors.filter((e) => e.rule === 'includes/props-collision');
      assert.equal(collisionErrors.length, 0);
    });

    it('should fail when layout prop collides with includes prop', () => {
      const data = {
        layout: 'cover',
        includes: ['_common', '_header'],
        props: { description: {}, coverTitle: {} },
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      const collisionErrors = errors.filter((e) => e.rule === 'includes/props-collision');
      assert.equal(collisionErrors.length, 1);
      assert.ok(collisionErrors[0].message.includes('description'));
      assert.ok(collisionErrors[0].message.includes('_header'));
    });

    it('should report multiple collisions from different includes', () => {
      const data = {
        layout: 'cover',
        includes: ['_common', '_header', '_footer'],
        props: { sensitivity: {}, description: {} },
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      const collisionErrors = errors.filter((e) => e.rule === 'includes/props-collision');
      assert.equal(collisionErrors.length, 2);
    });

    it('should skip when layout has no props (like end.yaml)', () => {
      const data = {
        layout: 'end',
        includes: ['_common', '_footer'],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'end.yaml'));
      const collisionErrors = errors.filter((e) => e.rule === 'includes/props-collision');
      assert.equal(collisionErrors.length, 0);
    });

    it('should skip when includes file has no props', () => {
      const data = {
        layout: 'test',
        includes: ['_nonexistent'],
        props: { description: {} },
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const collisionErrors = errors.filter((e) => e.rule === 'includes/props-collision');
      assert.equal(collisionErrors.length, 0);
    });
  });

  describe('same-length-as/target-exists', () => {
    it('should pass when same_length_as points to a sibling array prop', () => {
      const data = {
        layout: 'test',
        includes: [],
        text_constraints: {},
        props: {
          rows: { type: 'Array', description: 'Row list' },
          items: { type: 'Array', description: 'Item list', same_length_as: 'rows' },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const targetErrors = errors.filter((e) => e.rule === 'same-length-as/target-exists');
      assert.equal(targetErrors.length, 0);
    });

    it('should pass when same_length_as points to a nested array prop via dot path', () => {
      const data = {
        layout: 'test',
        includes: [],
        text_constraints: {},
        props: {
          statContent: {
            type: 'Object',
            description: 'Stat content',
            props: { rows: { type: 'Array', description: 'Row list' } },
          },
          readout: {
            type: 'Object',
            description: 'Readout',
            props: {
              items: {
                type: 'Array',
                description: 'Item list',
                same_length_as: 'statContent.rows',
              },
            },
          },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const targetErrors = errors.filter((e) => e.rule === 'same-length-as/target-exists');
      assert.equal(targetErrors.length, 0);
    });

    it('should fail when same_length_as points to a non-existent prop path', () => {
      const data = {
        layout: 'test',
        includes: [],
        text_constraints: {},
        props: {
          items: {
            type: 'Array',
            description: 'Item list',
            same_length_as: 'statContent.rowss',
          },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const targetErrors = errors.filter((e) => e.rule === 'same-length-as/target-exists');
      assert.equal(targetErrors.length, 1);
      assert.ok(targetErrors[0].message.includes('statContent.rowss'));
    });

    it('should skip when no props are declared', () => {
      const data = {
        layout: 'test',
        includes: [],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const targetErrors = errors.filter((e) => e.rule === 'same-length-as/target-exists');
      assert.equal(targetErrors.length, 0);
    });

    it('stat-readout.yaml: readout.items の same_length_as (statContent.rows) が実在するパスを指す', () => {
      const yamlContent = readFileSync(join(REFS_DIR, 'stat-readout.yaml'), 'utf-8');
      const data = yaml.load(yamlContent) as Record<string, unknown>;
      const errors = validateSemantics(data, join(REFS_DIR, 'stat-readout.yaml'));
      const targetErrors = errors.filter((e) => e.rule === 'same-length-as/target-exists');
      assert.equal(targetErrors.length, 0);
    });
  });

  describe('layout/filename-match', () => {
    it('should pass when layout matches filename', () => {
      const data = {
        layout: 'cover',
        includes: ['_common'],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      const matchErrors = errors.filter((e) => e.rule === 'layout/filename-match');
      assert.equal(matchErrors.length, 0);
    });

    it('should fail when layout does not match filename', () => {
      const data = {
        layout: 'wrong-name',
        includes: ['_common'],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      const matchErrors = errors.filter((e) => e.rule === 'layout/filename-match');
      assert.equal(matchErrors.length, 1);
    });
  });

  describe('category vocabulary (_common.yaml)', () => {
    // 語彙の確認は _common.yaml 1 ファイルの検証としてだけ実行される。
    // レイアウト側から参照すると、同じ違反がレイアウト件数分重複する。
    // _common.yaml 自身の行には 0 件と出てしまう。
    function withRefsDir(
      layoutFiles: Record<string, string>,
      run: (refsDir: string) => void,
    ): void {
      const refsDir = mkdtempSync(join(tmpdir(), 'pecotv-vocabulary-'));
      try {
        for (const [name, content] of Object.entries(layoutFiles)) {
          writeFileSync(join(refsDir, name), content, 'utf-8');
        }
        run(refsDir);
      } finally {
        rmSync(refsDir, { recursive: true, force: true });
      }
    }

    interface Category {
      id: string;
      label: string;
      question: string;
    }

    const FIGURE: Category = { id: 'figure', label: '図', question: '図で見せる' };
    const TABLE: Category = { id: 'table', label: '表', question: '軸のある表で見せる' };

    function vocabulary(categories: unknown[]): Record<string, unknown> {
      return { description: 'shared', layout_categories: categories };
    }

    it('should pass for a well-formed vocabulary', () => {
      withRefsDir({}, (refsDir) => {
        const errors = validateSemantics(
          vocabulary([FIGURE, TABLE]),
          join(refsDir, '_common.yaml'),
        );
        assert.deepEqual(errors, []);
      });
    });

    it('should fail when layout_categories is absent', () => {
      withRefsDir({}, (refsDir) => {
        const errors = validateSemantics(
          { description: 'shared' },
          join(refsDir, '_common.yaml'),
        );
        const categoryErrors = errors.filter((e) => e.rule === 'category/known');
        assert.equal(categoryErrors.length, 1);
        assert.ok(categoryErrors[0].message.includes('layout_categories'));
        assert.ok(categoryErrors[0].message.includes('slide_sync'));
      });
    });

    it('should fail when layout_categories has duplicated ids', () => {
      withRefsDir({}, (refsDir) => {
        const errors = validateSemantics(
          vocabulary([FIGURE, TABLE, { ...FIGURE, label: '図（重複）' }]),
          join(refsDir, '_common.yaml'),
        );
        const categoryErrors = errors.filter((e) => e.rule === 'category/known');
        assert.equal(categoryErrors.length, 1);
        assert.ok(categoryErrors[0].message.includes('duplicate'));
      });
    });

    it('should pass for the fixture deck _common.yaml', () => {
      const common = yaml.load(
        readFileSync(join(REFS_DIR, '_common.yaml'), 'utf-8'),
      ) as Record<string, unknown>;
      const errors = validateSemantics(common, join(REFS_DIR, '_common.yaml'));
      assert.deepEqual(errors, []);
    });
  });

  describe('category/known', () => {
    // 隣接 _common.yaml の中身を差し替えられるよう、レイアウト yaml は一時ディレクトリに置く
    // （実テンプレートの _common.yaml は正しい語彙を持つため、異常系を作れない）。
    function withRefsDir(commonYaml: string | null, run: (refsDir: string) => void): void {
      const refsDir = mkdtempSync(join(tmpdir(), 'pecotv-category-'));
      try {
        if (commonYaml !== null) writeFileSync(join(refsDir, '_common.yaml'), commonYaml, 'utf-8');
        run(refsDir);
      } finally {
        rmSync(refsDir, { recursive: true, force: true });
      }
    }

    const VALID_COMMON = [
      'description: shared',
      'layout_categories:',
      "  - id: 'figure'",
      "    label: '図'",
      "    question: '図で見せる'",
      "  - id: 'table'",
      "    label: '表'",
      "    question: '軸のある表で見せる'",
      '',
    ].join('\n');

    it('should pass when category is declared in _common.yaml', () => {
      withRefsDir(VALID_COMMON, (refsDir) => {
        const errors = validateSemantics(
          { layout: 'test', category: 'figure' },
          join(refsDir, 'test.yaml'),
        );
        assert.deepEqual(errors.filter((e) => e.rule === 'category/known'), []);
      });
    });

    it('should fail when category is not in layout_categories', () => {
      withRefsDir(VALID_COMMON, (refsDir) => {
        const errors = validateSemantics(
          { layout: 'test', category: 'bogus' },
          join(refsDir, 'test.yaml'),
        );
        const categoryErrors = errors.filter((e) => e.rule === 'category/known');
        assert.equal(categoryErrors.length, 1);
        assert.ok(categoryErrors[0].message.includes('bogus'));
        assert.ok(categoryErrors[0].message.includes('slide_sync'));
      });
    });

    // 語彙を読めないとき、レイアウト側は報告しない。レイアウト件数分の重複報告を避けるため。
    // 報告は _common.yaml 自身の検証（語彙不在）と loader の parse 層（構文エラー）が担う。
    it('should stay silent when the adjacent _common.yaml is missing', () => {
      withRefsDir(null, (refsDir) => {
        const errors = validateSemantics(
          { layout: 'test', category: 'figure' },
          join(refsDir, 'test.yaml'),
        );
        assert.deepEqual(errors.filter((e) => e.rule.startsWith('category/')), []);
      });
    });

    it('should stay silent when _common.yaml has no layout_categories, which _common.yaml itself reports', () => {
      withRefsDir('description: shared\n', (refsDir) => {
        const fromLayout = validateSemantics(
          { layout: 'test', category: 'figure' },
          join(refsDir, 'test.yaml'),
        );
        assert.deepEqual(fromLayout.filter((e) => e.rule.startsWith('category/')), []);

        const fromCommon = validateSemantics(
          { description: 'shared' },
          join(refsDir, '_common.yaml'),
        );
        const categoryErrors = fromCommon.filter((e) => e.rule === 'category/known');
        assert.equal(categoryErrors.length, 1);
        assert.ok(categoryErrors[0].message.includes('layout_categories'));
      });
    });

    it('should skip hidden layouts that have no category', () => {
      withRefsDir(null, (refsDir) => {
        const errors = validateSemantics(
          { layout: 'test', status: 'hidden' },
          join(refsDir, 'test.yaml'),
        );
        assert.deepEqual(errors.filter((e) => e.rule === 'category/known'), []);
      });
    });

    it('should not report a missing category (schema layer owns it)', () => {
      withRefsDir(VALID_COMMON, (refsDir) => {
        const errors = validateSemantics({ layout: 'test' }, join(refsDir, 'test.yaml'));
        assert.deepEqual(errors.filter((e) => e.rule === 'category/known'), []);
      });
    });

    it('should pass for a layout whose category is in the fixture deck _common.yaml', () => {
      const errors = validateSemantics(
        { layout: 'two-column', category: 'two-column' },
        join(REFS_DIR, 'two-column.yaml'),
      );
      assert.deepEqual(errors.filter((e) => e.rule === 'category/known'), []);
    });
  });

  describe('shared files', () => {
    // _common.yaml 以外の共有ファイルは語彙を持たないため、語彙規則の対象外。
    it('should return no errors for shared files (no layout)', () => {
      const data = {
        description: 'Common properties',
        props: { sensitivity: {} },
      };
      const errors = validateSemantics(data, join(REFS_DIR, '_header.yaml'));
      assert.equal(errors.length, 0);
    });
  });

  describe('ganttchart/max-tasks', () => {
    function makeTasks(count: number): GanttTask[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `task${i + 1}`,
        name: `タスク${i + 1}`,
        start: '2026-04-01',
        end: '2026-04-10',
      }));
    }

    function makeGanttExample({
      tasks,
      withTitle = false,
      name = 'test',
    }: {
      tasks: GanttTask[];
      withTitle?: boolean;
      name?: string;
    }) {
      const titleBlock = withTitle
        ? 'titleContent:\n  label: "LABEL"\n  title: "テスト"\n'
        : '';
      const taskLines = tasks
        .map((t) => {
          let line = `    - id: "${t.id}"\n      name: "${t.name}"\n      start: "${t.start}"\n      end: "${t.end}"`;
          if (t.children) {
            line += '\n      children:';
            for (const c of t.children) {
              line += `\n        - id: "${c.id}"\n          name: "${c.name}"\n          start: "${c.start}"\n          end: "${c.end}"`;
            }
          }
          return line;
        })
        .join('\n');
      return {
        name,
        frontmatter: `---\nlayout: ganttchart\n${titleBlock}chartContent:\n  tasks:\n${taskLines}\n---`,
      };
    }

    it('should pass when tasks <= 11', () => {
      const data = {
        layout: 'ganttchart',
        examples: [makeGanttExample({ tasks: makeTasks(11), withTitle: true })],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      const ganttErrors = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
      assert.equal(ganttErrors.length, 0);
    });

    it('should fail when tasks > 11', () => {
      const data = {
        layout: 'ganttchart',
        examples: [makeGanttExample({ tasks: makeTasks(12), withTitle: true })],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      const ganttErrors = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
      assert.equal(ganttErrors.length, 1);
      assert.ok(ganttErrors[0].message.includes('12'));
      assert.ok(ganttErrors[0].message.includes('11'));
    });

    it('should fail when tasks > 11 even without titleContent', () => {
      const data = {
        layout: 'ganttchart',
        examples: [makeGanttExample({ tasks: makeTasks(12), withTitle: false })],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      const ganttErrors = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
      assert.equal(ganttErrors.length, 1);
      assert.ok(ganttErrors[0].message.includes('12'));
      assert.ok(ganttErrors[0].message.includes('11'));
    });

    it('should count children recursively and pass when within limit', () => {
      const tasks: GanttTask[] = [
        { ...makeTasks(1)[0], children: makeTasks(2) },
        {
          ...makeTasks(1)[0],
          id: 'parent2',
          children: makeTasks(2).map((t, i) => ({ ...t, id: `child${i + 3}` })),
        },
      ];
      const data = {
        layout: 'ganttchart',
        examples: [makeGanttExample({ tasks, withTitle: false })],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      const ganttErrors = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
      assert.equal(ganttErrors.length, 0);
    });

    it('should count children recursively and fail when exceeding limit', () => {
      const tasks: GanttTask[] = Array.from({ length: 4 }, (_, i) => ({
        id: `parent${i + 1}`,
        name: `親タスク${i + 1}`,
        start: '2026-04-01',
        end: '2026-04-10',
        children: [
          {
            id: `child${i * 2 + 1}`,
            name: `子タスク${i * 2 + 1}`,
            start: '2026-04-01',
            end: '2026-04-10',
          },
          {
            id: `child${i * 2 + 2}`,
            name: `子タスク${i * 2 + 2}`,
            start: '2026-04-01',
            end: '2026-04-10',
          },
        ],
      }));
      const data = {
        layout: 'ganttchart',
        examples: [makeGanttExample({ tasks, withTitle: true })],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      const ganttErrors = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
      assert.equal(ganttErrors.length, 1);
      assert.ok(ganttErrors[0].message.includes('12'));
    });

    it('should skip non-ganttchart layouts', () => {
      const data = {
        layout: 'other',
        examples: [
          {
            name: 'test',
            frontmatter:
              '---\nlayout: other\nchartContent:\n  tasks:\n    - id: t1\n      name: t\n      start: 2026-01-01\n      end: 2026-01-02\n---',
          },
        ],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      const ganttErrors = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
      assert.equal(ganttErrors.length, 0);
    });
  });

  describe('checkSlideFilesTextViolations with nested structure', () => {
    it('should scan nested presentation directories via findPresentationDirs', () => {
      const data = {
        layout: 'cover',
        text_constraints: {
          coverTitle1: { min_chars: 1, max_chars: 100 },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      assert.ok(Array.isArray(errors));
    });

    it('should not fail when _presentations directory does not exist', () => {
      const data = {
        layout: 'test-nonexistent',
        text_constraints: {
          title: { max_chars: 25 },
        },
      };
      const fakeRefsDir = join(import.meta.dirname, 'fake-nonexistent-refs');
      const errors = validateSemantics(data, join(fakeRefsDir, 'test.yaml'));
      const textErrors = errors.filter((e) => e.rule === 'text-constraints/text-violation');
      assert.equal(textErrors.length, 0);
    });
  });
});

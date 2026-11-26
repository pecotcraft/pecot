import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    it('min_chars が max_chars 以下だと、エラーを返さない', () => {
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

    it('min_chars が max_chars より大きいと、エラーを返す', () => {
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

    it('min_items が max_items より大きいと、エラーを返す', () => {
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

    it('min_items と max_items が等しいと、エラーを返さない', () => {
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

    it('text_constraints が空のオブジェクトだと、min-max の検証をしない', () => {
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
    it('制約のキーに max_items を使うと、エラーを返さない', () => {
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

    it('制約のキーに min_items を使うと、エラーを返さない', () => {
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

    it('制約のキーに bold_required を使うと、allowed-keys のエラーを返さない', () => {
      const errors = validateSemantics(
        { layout: 'test', text_constraints: { title: { bold_required: true } } },
        join(REFS_DIR, 'test.yaml'),
      );
      assert.equal(errors.filter((e) => e.rule === 'text-constraints/allowed-keys').length, 0);
    });

    it('例の文に <strong> があると、エラーを返さない', () => {
      assert.equal(boldErrors(makeData(['"<strong>要点</strong>のある説明"'])).length, 0);
    });

    it('例の文に太字の強調が無いと、エラーを返す', () => {
      const errors = boldErrors(makeData(['"太字のない説明"']));
      assert.equal(errors.length, 1);
      assert.ok(errors[0].message.includes('items[0].description'));
    });

    it('例の文が <strong> でなく <b> を使うと、エラーを返す', () => {
      assert.equal(boldErrors(makeData(['"<b>要点</b>のある説明"'])).length, 1);
    });

    it('配列の要素に太字の無いものがあると、要素ごとにエラーを返す', () => {
      const errors = boldErrors(
        makeData(['"太字なし"', '"<strong>要点</strong>あり"', '"これも太字なし"']),
      );
      assert.equal(errors.length, 2);
      assert.ok(errors[0].message.includes('items[0].description'));
      assert.ok(errors[1].message.includes('items[2].description'));
    });

    it('bold_required が無いと、太字の検証をしない', () => {
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
    it('includes のファイルがすべてあると、エラーを返さない', () => {
      const data = {
        layout: 'cover',
        includes: ['_common', '_footer'],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      const includeErrors = errors.filter((e) => e.rule === 'includes/file-exists');
      assert.equal(includeErrors.length, 0);
    });

    it('includes のファイルが存在しないと、エラーを返す', () => {
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
    it('props が includes の props と重ならないと、エラーを返さない', () => {
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

    it('レイアウトの props が includes の props と重なると、エラーを返す', () => {
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

    it('複数の includes と props が重なると、重なりごとにエラーを返す', () => {
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

    it('レイアウトが props を持たないと、props の重なりを検証しない', () => {
      const data = {
        layout: 'end',
        includes: ['_common', '_footer'],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'end.yaml'));
      const collisionErrors = errors.filter((e) => e.rule === 'includes/props-collision');
      assert.equal(collisionErrors.length, 0);
    });

    it('includes のファイルが props を持たないと、props の重なりを検証しない', () => {
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
    it('same_length_as が兄弟の配列の props を指すと、エラーを返さない', () => {
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

    it('same_length_as がドット区切りで入れ子の配列の props を指すと、エラーを返さない', () => {
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

    it('same_length_as が存在しない props のパスを指すと、エラーを返す', () => {
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

    it('props を宣言していないと、same_length_as を検証しない', () => {
      const data = {
        layout: 'test',
        includes: [],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const targetErrors = errors.filter((e) => e.rule === 'same-length-as/target-exists');
      assert.equal(targetErrors.length, 0);
    });

    it('stat-readout.yaml の readout.items の same_length_as が statContent.rows を指すと、エラーを返さない', () => {
      const yamlContent = readFileSync(join(REFS_DIR, 'stat-readout.yaml'), 'utf-8');
      const data = yaml.load(yamlContent) as Record<string, unknown>;
      const errors = validateSemantics(data, join(REFS_DIR, 'stat-readout.yaml'));
      const targetErrors = errors.filter((e) => e.rule === 'same-length-as/target-exists');
      assert.equal(targetErrors.length, 0);
    });
  });

  describe('layout/filename-match', () => {
    it('layout がファイル名と一致すると、エラーを返さない', () => {
      const data = {
        layout: 'cover',
        includes: ['_common'],
        text_constraints: {},
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      const matchErrors = errors.filter((e) => e.rule === 'layout/filename-match');
      assert.equal(matchErrors.length, 0);
    });

    it('layout がファイル名と一致しないと、エラーを返す', () => {
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

    it('語彙の形が正しい _common.yaml を渡すと、エラーを返さない', () => {
      withRefsDir({}, (refsDir) => {
        const errors = validateSemantics(
          vocabulary([FIGURE, TABLE]),
          join(refsDir, '_common.yaml'),
        );
        assert.deepEqual(errors, []);
      });
    });

    it('layout_categories が無いと、エラーを返す', () => {
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

    it('layout_categories の id が重複すると、エラーを返す', () => {
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

    it('fixture deck の _common.yaml を渡すと、エラーを返さない', () => {
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

    it('category が _common.yaml に宣言されていると、エラーを返さない', () => {
      withRefsDir(VALID_COMMON, (refsDir) => {
        const errors = validateSemantics(
          { layout: 'test', category: 'figure' },
          join(refsDir, 'test.yaml'),
        );
        assert.deepEqual(errors.filter((e) => e.rule === 'category/known'), []);
      });
    });

    it('category が layout_categories に無いと、エラーを返す', () => {
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
    it('隣の _common.yaml が無いと、category のエラーを返さない', () => {
      withRefsDir(null, (refsDir) => {
        const errors = validateSemantics(
          { layout: 'test', category: 'figure' },
          join(refsDir, 'test.yaml'),
        );
        assert.deepEqual(errors.filter((e) => e.rule.startsWith('category/')), []);
      });
    });

    it('_common.yaml に layout_categories が無いと、レイアウト側は category のエラーを返さず、_common.yaml 自身が報告する', () => {
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

    it('category の無い hidden のレイアウトだと、category の検証をしない', () => {
      withRefsDir(null, (refsDir) => {
        const errors = validateSemantics(
          { layout: 'test', status: 'hidden' },
          join(refsDir, 'test.yaml'),
        );
        assert.deepEqual(errors.filter((e) => e.rule === 'category/known'), []);
      });
    });

    it('category が無いと、category/known では報告しない', () => {
      withRefsDir(VALID_COMMON, (refsDir) => {
        const errors = validateSemantics({ layout: 'test' }, join(refsDir, 'test.yaml'));
        assert.deepEqual(errors.filter((e) => e.rule === 'category/known'), []);
      });
    });

    it('category が fixture deck の _common.yaml にあるレイアウトだと、エラーを返さない', () => {
      const errors = validateSemantics(
        { layout: 'two-column', category: 'two-column' },
        join(REFS_DIR, 'two-column.yaml'),
      );
      assert.deepEqual(errors.filter((e) => e.rule === 'category/known'), []);
    });
  });

  describe('shared files', () => {
    // _common.yaml 以外の共有ファイルは語彙を持たないため、語彙規則の対象外。
    it('layout の無い共有ファイルを渡すと、エラーを返さない', () => {
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

    it('タスクが 11 件以下だと、エラーを返さない', () => {
      const data = {
        layout: 'ganttchart',
        examples: [makeGanttExample({ tasks: makeTasks(11), withTitle: true })],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      const ganttErrors = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
      assert.equal(ganttErrors.length, 0);
    });

    it('タスクが 11 件を超えると、エラーを返す', () => {
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

    it('titleContent が無くても、タスクが 11 件を超えるとエラーを返す', () => {
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

    it('子のタスクを再帰で数えて上限以内だと、エラーを返さない', () => {
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

    it('子のタスクを再帰で数えて上限を超えると、エラーを返す', () => {
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

    it('ganttchart 以外のレイアウトだと、検証しない', () => {
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
    it('入れ子のプレゼンテーションのディレクトリがあると、findPresentationDirs で走査し、エラーの配列を返す', () => {
      const data = {
        layout: 'cover',
        text_constraints: {
          coverTitle1: { min_chars: 1, max_chars: 100 },
        },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'cover.yaml'));
      assert.ok(Array.isArray(errors));
    });

    it('_presentations のディレクトリが無いと、text-violation のエラーを返さない', () => {
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
  describe('一時ディレクトリの構成を走査する検証', () => {
    // root/_presentations/<name>/{slides.md,pages/*.md} と root/deck/ja/pages/_references/ を作る
    function makeTree() {
      const root = mkdtempSync(join(tmpdir(), 'semval-'));
      const pagesDir = join(root, 'deck', 'ja', 'pages');
      const refsDir = join(pagesDir, '_references');
      mkdirSync(refsDir, { recursive: true });
      return {
        root,
        pagesDir,
        refsDir,
        refPath: (name: string) => join(refsDir, `${name}.yaml`),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
      };
    }

    function ganttMd(count: number): string {
      const tasks = Array.from(
        { length: count },
        (_, i) => `    - id: t${i}\n      name: n${i}\n      start: 2026-01-01\n      end: 2026-01-02`,
      ).join('\n');
      return `---\nlayout: ganttchart\nchartContent:\n  tasks:\n${tasks}\n---\n`;
    }

    it('制約の値がオブジェクトでないと、キーと上限の検証を読み飛ばす', () => {
      const data = {
        layout: 'test',
        text_constraints: { a: null, b: 'str', c: { min_chars: 'x', max_chars: 3 } },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      assert.deepEqual(
        errors.filter((e) => e.rule.startsWith('text-constraints/')),
        [],
      );
    });

    it('text_constraints が配列・文字列・オブジェクトのどれでもないと、検証を読み飛ばす', () => {
      const data = { layout: 'test', text_constraints: 'oops' as unknown as Record<string, unknown> };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      assert.deepEqual(
        errors.filter((e) => e.rule.startsWith('text-constraints/')),
        [],
      );
    });

    it('許可されていない制約のキーがあると、キーを含むエラーを返す', () => {
      const data = { layout: 'test', text_constraints: { title: { max_chars: 5, bogus: 1 } } };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const keyErrors = errors.filter((e) => e.rule === 'text-constraints/allowed-keys');
      assert.equal(keyErrors.length, 1);
      assert.ok(keyErrors[0].message.includes('title: key not allowed: bogus'));
    });

    it('includes のファイルが yaml として読めないと、props の重なりを検証せずに続ける', () => {
      const t = makeTree();
      try {
        writeFileSync(join(t.refsDir, 'shared.yaml'), 'props: [unclosed');
        const data = { layout: 'lay', includes: ['shared'], props: { a: {} } };
        const errors = validateSemantics(data, t.refPath('lay'));
        assert.equal(errors.filter((e) => e.rule === 'includes/props-collision').length, 0);
      } finally {
        t.cleanup();
      }
    });

    it('layout の props が includes の props と重ならないキーだけだと、重なりを返さない', () => {
      const t = makeTree();
      try {
        writeFileSync(join(t.refsDir, 'shared.yaml'), 'props:\n  other:\n    type: string\n');
        const data = { layout: 'lay', includes: ['shared'], props: { a: { type: 'string' } } };
        const errors = validateSemantics(data, t.refPath('lay'));
        assert.equal(errors.filter((e) => e.rule === 'includes/props-collision').length, 0);
      } finally {
        t.cleanup();
      }
    });

    it('includes が配列でないと、存在確認も重なりの検証もしない', () => {
      const data = {
        layout: 'test',
        includes: 'shared' as unknown as string[],
        props: { a: {} },
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      assert.equal(errors.filter((e) => e.rule.startsWith('includes/')).length, 0);
    });

    it('_common.yaml が yaml として読めないと、category/known を返さない', () => {
      const t = makeTree();
      try {
        writeFileSync(join(t.refsDir, '_common.yaml'), 'layout_categories: [unclosed');
        const data = { layout: 'lay', category: 'anything' };
        const errors = validateSemantics(data, t.refPath('lay'));
        assert.equal(errors.filter((e) => e.rule === 'category/known').length, 0);
      } finally {
        t.cleanup();
      }
    });

    it('_common.yaml の layout_categories に id の無い要素や null があると、id のあるものだけを語彙にする', () => {
      const t = makeTree();
      try {
        writeFileSync(
          join(t.refsDir, '_common.yaml'),
          'layout_categories:\n  - id: known\n  - null\n  - name: noid\n  - id: 5\n',
        );
        const ok = validateSemantics({ layout: 'lay', category: 'known' }, t.refPath('lay'));
        assert.equal(ok.filter((e) => e.rule === 'category/known').length, 0);
        const ng = validateSemantics({ layout: 'lay', category: 'other' }, t.refPath('lay'));
        const catErrors = ng.filter((e) => e.rule === 'category/known');
        assert.equal(catErrors.length, 1);
        assert.ok(catErrors[0].message.includes('(defined: known)'));
      } finally {
        t.cleanup();
      }
    });

    it('_common.yaml の語彙の検証で、id の無い要素と重複しない id は重複として数えない', () => {
      const data = {
        layout: undefined,
        layout_categories: [{ id: 'a' }, { id: 'b' }, null, { name: 'x' }],
      };
      const errors = validateSemantics(data, join(REFS_DIR, '_common.yaml'));
      assert.deepEqual(errors, []);
    });

    it('examples の frontmatter が yaml として読めないと、その例を読み飛ばす', () => {
      const data = {
        layout: 'test',
        text_constraints: { title: { max_chars: 2 } },
        examples: [{ name: 'broken', frontmatter: '---\nlayout: [unclosed\n---' }],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      assert.equal(errors.filter((e) => e.rule === 'text-constraints/text-violation').length, 0);
    });

    it('examples の frontmatter が無い例や、オブジェクトにならない例を読み飛ばす', () => {
      const data = {
        layout: 'test',
        text_constraints: { title: { max_chars: 2 } },
        examples: [{ name: 'empty' }, { name: 'scalar', frontmatter: '---\njust text\n---' }],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      assert.equal(errors.filter((e) => e.rule === 'text-constraints/text-violation').length, 0);
    });

    it('examples に text_constraints が無いと、文字数の検証をしない', () => {
      const data = {
        layout: 'test',
        examples: [{ name: 'a', frontmatter: '---\nlayout: test\ntitle: abcdef\n---' }],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      assert.equal(errors.filter((e) => e.rule === 'text-constraints/text-violation').length, 0);
    });

    it('examples の文字数が上限を超えると、例の名前と添字を含むエラーを返す', () => {
      const data = {
        layout: 'test',
        text_constraints: { title: { max_chars: 2 } },
        examples: [
          { frontmatter: '---\ntitle: abcdef\n---' },
          { name: 'named', frontmatter: '---\ntitle: abcdef\n---' },
        ],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      const violations = errors.filter((e) => e.rule === 'text-constraints/text-violation');
      assert.equal(violations.length, 2);
      assert.ok(violations[0].message.startsWith('examples[0] title:'));
      assert.ok(violations[1].message.startsWith('examples[1](named) title:'));
    });

    it('examples の値が文字列でない・空白だけだと、文字数の検証をしない', () => {
      const data = {
        layout: 'test',
        text_constraints: { title: { max_chars: 1 }, sub: { max_chars: 1 } },
        examples: [{ name: 'a', frontmatter: '---\ntitle: 12345\nsub: "   "\n---' }],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      assert.equal(errors.filter((e) => e.rule === 'text-constraints/text-violation').length, 0);
    });

    it('制約が null の項目でも、文字数と太字の検証を落とさずに進める', () => {
      const data = {
        layout: 'test',
        text_constraints: { title: null as unknown as Record<string, unknown> },
        examples: [{ name: 'a', frontmatter: '---\ntitle: abcdef\n---' }],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'test.yaml'));
      assert.equal(errors.filter((e) => e.rule.startsWith('text-constraints/')).length, 0);
    });

    it('pages の md が同じ layout で上限を超えると、ファイル名つきのエラーを返し、別 layout・md 以外・読めない md は読み飛ばす', () => {
      const t = makeTree();
      try {
        writeFileSync(join(t.pagesDir, 'hit.md'), '---\nlayout: lay\ntitle: abcdef\n---\n');
        writeFileSync(join(t.pagesDir, 'other.md'), '---\nlayout: else\ntitle: abcdef\n---\n');
        writeFileSync(join(t.pagesDir, 'nofm.md'), 'no frontmatter\n');
        writeFileSync(join(t.pagesDir, 'note.txt'), '---\nlayout: lay\ntitle: abcdef\n---\n');
        mkdirSync(join(t.pagesDir, 'dir.md'));
        const data = { layout: 'lay', text_constraints: { title: { max_chars: 2 } } };
        const errors = validateSemantics(data, t.refPath('lay'));
        const violations = errors.filter((e) => e.rule === 'text-constraints/text-violation');
        assert.equal(violations.length, 1);
        assert.ok(violations[0].message.startsWith('hit.md title:'));
      } finally {
        t.cleanup();
      }
    });

    it('_presentations の入れ子の pages の md が上限を超えると、_presentations からの相対パスでエラーを返す', () => {
      const t = makeTree();
      try {
        const nested = join(t.root, '_presentations', 'group', 'talk');
        mkdirSync(join(nested, 'pages'), { recursive: true });
        writeFileSync(join(nested, 'slides.md'), '# slides\n');
        writeFileSync(join(nested, 'pages', 'p.md'), '---\nlayout: lay\ntitle: abcdef\n---\n');
        // slides.md はあるが pages の無い発表と、slides.md の無い空ディレクトリ
        const noPages = join(t.root, '_presentations', 'nopages');
        mkdirSync(noPages, { recursive: true });
        writeFileSync(join(noPages, 'slides.md'), '# slides\n');
        mkdirSync(join(t.root, '_presentations', 'empty'), { recursive: true });
        const data = { layout: 'lay', text_constraints: { title: { max_chars: 2 } } };
        const errors = validateSemantics(data, t.refPath('lay'));
        const violations = errors.filter((e) => e.rule === 'text-constraints/text-violation');
        assert.equal(violations.length, 1);
        assert.ok(
          violations[0].message.startsWith('_presentations/group/talk/pages/p.md title:'),
          violations[0].message,
        );
      } finally {
        t.cleanup();
      }
    });

    it('pages の md の太字が必須で、太字が無いと、ファイルを示して bold-required を返す', () => {
      const t = makeTree();
      try {
        writeFileSync(join(t.pagesDir, 'b.md'), '---\nlayout: lay\ntitle: plain\n---\n');
        const data = {
          layout: 'lay',
          text_constraints: { title: { bold_required: true } },
        };
        const errors = validateSemantics(data, t.refPath('lay'));
        const bold = errors.filter((e) => e.rule === 'text-constraints/bold-required');
        assert.equal(bold.length, 1);
        assert.ok(bold[0].message.startsWith('b.md title:'));
      } finally {
        t.cleanup();
      }
    });

    it('ganttchart の pages の md が行数の上限を超えると、ファイル名つきでエラーを返す', () => {
      const t = makeTree();
      try {
        writeFileSync(join(t.pagesDir, 'big.md'), ganttMd(12));
        writeFileSync(join(t.pagesDir, 'small.md'), ganttMd(3));
        writeFileSync(join(t.pagesDir, 'other.md'), ganttMd(12).replace('ganttchart', 'cover'));
        writeFileSync(join(t.pagesDir, 'notasks.md'), '---\nlayout: ganttchart\nchartContent:\n  tasks: none\n---\n');
        writeFileSync(join(t.pagesDir, 'nofm.md'), 'plain\n');
        mkdirSync(join(t.pagesDir, 'dir.md'));
        const data = { layout: 'ganttchart' };
        const errors = validateSemantics(data, t.refPath('ganttchart'));
        const gantt = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
        assert.equal(gantt.length, 1);
        assert.equal(gantt[0].message, 'big.md: task row count 12 exceeds the limit 11');
      } finally {
        t.cleanup();
      }
    });

    it('ganttchart の _presentations の pages の md が上限を超えると、相対パスでエラーを返す', () => {
      const t = makeTree();
      try {
        const talk = join(t.root, '_presentations', 'talk');
        mkdirSync(join(talk, 'pages'), { recursive: true });
        writeFileSync(join(talk, 'slides.md'), '# s\n');
        writeFileSync(join(talk, 'pages', 'g.md'), ganttMd(12));
        const errors = validateSemantics({ layout: 'ganttchart' }, t.refPath('ganttchart'));
        const gantt = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
        assert.equal(gantt.length, 1);
        assert.ok(gantt[0].message.startsWith('_presentations/talk/pages/g.md:'));
      } finally {
        t.cleanup();
      }
    });

    it('ganttchart の examples で、読めない frontmatter・配列でないタスク・タスクの無い例を読み飛ばす', () => {
      const data = {
        layout: 'ganttchart',
        examples: [
          { name: 'none' },
          { name: 'broken', frontmatter: '---\nlayout: [x\n---' },
          { name: 'scalar', frontmatter: '---\nplain\n---' },
          { name: 'notarray', frontmatter: '---\nchartContent:\n  tasks: no\n---' },
        ],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      assert.equal(errors.filter((e) => e.rule === 'ganttchart/max-tasks').length, 0);
    });

    it('ganttchart の examples が配列でないと、行数を数えない', () => {
      const data = { layout: 'ganttchart', examples: 'x' as unknown as [] };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      assert.equal(errors.filter((e) => e.rule === 'ganttchart/max-tasks').length, 0);
    });

    it('ganttchart の例に名前があると、エラーの文に名前を含める', () => {
      const data = {
        layout: 'ganttchart',
        examples: [{ name: 'named', frontmatter: ganttMd(12) }],
      };
      const errors = validateSemantics(data, join(REFS_DIR, 'ganttchart.yaml'));
      const gantt = errors.filter((e) => e.rule === 'ganttchart/max-tasks');
      assert.equal(gantt.length, 1);
      assert.ok(gantt[0].message.startsWith('examples[0](named):'));
    });
  });
});

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getLayoutProps,
  getLayoutPropTree,
  loadLayoutReference,
  parseFrontmatter,
  clearCache,
} from '@v-slidev/eslint-shared';
import { collectUnknownProps } from '../lib/utils/prop-tree-walker.ts';
import noUnknownPropsRule, { SLIDEV_STANDARD_KEYS } from '../lib/rules/no-unknown-props.ts';

test('getLayoutProps: propsセクションからキー一覧を取得', () => {
  const reference = {
    props: {
      sensitivity: { type: 'String', default: "'Internal'" },
      titleContent: { type: 'Object', default: 'null' },
    },
  };
  const result = getLayoutProps(reference);
  assert.deepStrictEqual(result, ['sensitivity', 'titleContent']);
});

test('getLayoutProps: propsが null → 空配列', () => {
  assert.deepStrictEqual(getLayoutProps({ props: null }), []);
});

test('getLayoutProps: propsセクションなし → 空配列', () => {
  assert.deepStrictEqual(getLayoutProps({}), []);
});

test('getLayoutProps: referenceが null → 空配列', () => {
  assert.deepStrictEqual(getLayoutProps(null), []);
});

test('getLayoutProps: referenceが undefined → 空配列', () => {
  assert.deepStrictEqual(getLayoutProps(undefined), []);
});

test('getLayoutProps: propsが文字列（不正） → 空配列', () => {
  assert.deepStrictEqual(getLayoutProps({ props: 'invalid' }), []);
});

const referencesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references');

test('getLayoutProps (includes): agenda は _common + _header + _footer のpropsを含む', () => {
  clearCache();
  const reference = {
    includes: ['_common', '_header', '_footer'],
    props: {
      titleContent: { type: 'Object' },
      items: { type: 'Array' },
    },
  };
  const result = getLayoutProps(reference, [referencesDir]);
  assert.ok(result.includes('description'), 'description from _header');
  assert.ok(result.includes('minimalHeader'), 'minimalHeader from _header');
  assert.ok(result.includes('sensitivity'), 'sensitivity from _footer');
  assert.ok(result.includes('titleContent'), 'titleContent from layout');
  assert.ok(result.includes('items'), 'items from layout');
});

test('getLayoutProps (includes): referencesDir なしだと includes を無視', () => {
  const reference = {
    includes: ['_common', '_header'],
    props: { titleContent: { type: 'Object' } },
  };
  const result = getLayoutProps(reference);
  assert.deepStrictEqual(result, ['titleContent']);
});

test('getLayoutProps (includes): includes が空配列', () => {
  const reference = {
    includes: [],
    props: { sensitivity: { type: 'String' } },
  };
  const result = getLayoutProps(reference, [referencesDir]);
  assert.deepStrictEqual(result, ['sensitivity']);
});

test('getLayoutProps (includes): 存在しない共有YAMLは無視', () => {
  clearCache();
  const reference = {
    includes: ['_nonexistent'],
    props: { titleContent: { type: 'Object' } },
  };
  const result = getLayoutProps(reference, [referencesDir]);
  assert.deepStrictEqual(result, ['titleContent']);
});

test('SLIDEV_STANDARD_KEYS: layoutを含む', () => {
  assert.ok(SLIDEV_STANDARD_KEYS.has('layout'));
});

test('SLIDEV_STANDARD_KEYS: clicksを含む', () => {
  assert.ok(SLIDEV_STANDARD_KEYS.has('clicks'));
});

test('SLIDEV_STANDARD_KEYS: titleを含む', () => {
  assert.ok(SLIDEV_STANDARD_KEYS.has('title'));
});

test('SLIDEV_STANDARD_KEYS: transitionを含む', () => {
  assert.ok(SLIDEV_STANDARD_KEYS.has('transition'));
});

test('SLIDEV_STANDARD_KEYS: 全15キーが定義されている', () => {
  const expected = [
    'layout', 'class', 'clicks', 'clicksStart', 'preload',
    'hide', 'disabled', 'hideInToc', 'title', 'level',
    'routeAlias', 'zoom', 'dragPos', 'src', 'transition',
  ];
  assert.strictEqual(SLIDEV_STANDARD_KEYS.size, expected.length);
  for (const key of expected) {
    assert.ok(SLIDEV_STANDARD_KEYS.has(key), `missing: ${key}`);
  }
});

test('SLIDEV_STANDARD_KEYS: 未知のキーは含まない', () => {
  assert.ok(!SLIDEV_STANDARD_KEYS.has('sensitivity'));
  assert.ok(!SLIDEV_STANDARD_KEYS.has('coverTitle'));
  assert.ok(!SLIDEV_STANDARD_KEYS.has('debug'));
});

test('no-unknown-props: ルールオブジェクトが正しい構造を持つ', () => {
  const meta = noUnknownPropsRule.meta as { type: string; messages: Record<string, string> };
  assert.strictEqual(meta.type, 'problem');
  assert.ok(meta.messages.unknownProp);
  assert.strictEqual(typeof noUnknownPropsRule.create, 'function');
});

test('no-unknown-props: createがroot/Programビジターを返す', () => {
  const mockContext = {
    sourceCode: { getText: () => '' },
    filename: '/test.md',
  };
  const visitors = noUnknownPropsRule.create(mockContext as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('no-unknown-props: unknownNestedProp メッセージが定義されている', () => {
  const meta = noUnknownPropsRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.unknownNestedProp);
});

// getLayoutPropTree

test('getLayoutPropTree: ネスト schema をツリーとして取得', () => {
  const reference = {
    props: {
      titleContent: { type: 'Object', props: { label: { type: 'String' } } },
      steps: {
        type: 'Array',
        items: {
          point1: { type: 'String' },
          marker: { type: 'Object', props: { px: { type: 'Number' } } },
        },
      },
      checks: { type: 'Array<String>' },
    },
  };
  const tree = getLayoutPropTree(reference);
  assert.deepStrictEqual(Object.keys(tree), ['titleContent', 'steps', 'checks']);
  assert.strictEqual(tree.titleContent.type, 'Object');
  assert.deepStrictEqual(Object.keys(tree.titleContent.props ?? {}), ['label']);
  assert.deepStrictEqual(Object.keys(tree.steps.items ?? {}), ['point1', 'marker']);
  assert.deepStrictEqual(Object.keys(tree.steps.items?.marker.props ?? {}), ['px']);
  // Array<String>（items 宣言なし）は、props と items のどちらも持たない
  assert.strictEqual(tree.checks.items, undefined);
  assert.strictEqual(tree.checks.props, undefined);
});

test('getLayoutPropTree (includes): 実 _references をマージしネストを保持', () => {
  clearCache();
  const reference = {
    includes: ['_common', '_header', '_footer'],
    props: {
      titleContent: { type: 'Object', props: { label: { type: 'String' } } },
    },
  };
  const tree = getLayoutPropTree(reference, [referencesDir]);
  assert.ok('description' in tree, 'description from _header');
  assert.ok('sensitivity' in tree, 'sensitivity from _footer');
  assert.ok('titleContent' in tree, 'titleContent from layout');
  assert.deepStrictEqual(Object.keys(tree.titleContent.props ?? {}), ['label']);
});

test('getLayoutPropTree: null / undefined / 不正型 → 空 map', () => {
  assert.deepStrictEqual(getLayoutPropTree(null), {});
  assert.deepStrictEqual(getLayoutPropTree(undefined), {});
  assert.deepStrictEqual(getLayoutPropTree({}), {});
  assert.deepStrictEqual(getLayoutPropTree({ props: 'invalid' }), {});
  assert.deepStrictEqual(getLayoutPropTree({ props: null }), {});
});

test('getLayoutPropTree: getLayoutProps は Object.keys(getLayoutPropTree) と等価', () => {
  clearCache();
  const pure = { props: { a: { type: 'String' }, b: { type: 'Object' } } };
  assert.deepStrictEqual(getLayoutProps(pure), Object.keys(getLayoutPropTree(pure)));
  const withIncludes = {
    includes: ['_header', '_footer'],
    props: { titleContent: { type: 'Object' }, steps: { type: 'Array' } },
  };
  assert.deepStrictEqual(
    getLayoutProps(withIncludes, [referencesDir]),
    Object.keys(getLayoutPropTree(withIncludes, [referencesDir])),
  );
});

test('getLayoutPropTree: __proto__ 等の危険キーは prototype を汚染せず skip される', () => {
  // JSON.parse は __proto__ を「素の own プロパティ」として生成する
  // （YAML パーサ由来の汚染ペイロードを模倣）。
  const reference = JSON.parse(
    '{"props":{"__proto__":{"type":"String"},"constructor":{"type":"String"},' +
      '"titleContent":{"type":"Object","props":{"__proto__":{"type":"String"},"label":{"type":"String"}}},' +
      '"safe":{"type":"String"}}}',
  ) as Record<string, unknown>;
  const tree = getLayoutPropTree(reference);
  // 危険キーは skip、安全キーのみ残る（トップレベル）
  assert.deepStrictEqual(Object.keys(tree), ['titleContent', 'safe']);
  // ネスト（buildNodeMap の分岐）でも skip
  assert.deepStrictEqual(Object.keys(tree.titleContent.props ?? {}), ['label']);
  // tree / Object.prototype いずれも汚染されていない
  assert.strictEqual(Object.getPrototypeOf(tree), Object.prototype);
  assert.strictEqual((({} as Record<string, unknown>).type), undefined);
});

// collectUnknownProps

function loadTree(layoutName: string): Record<string, unknown> {
  const reference = loadLayoutReference([referencesDir], layoutName);
  return getLayoutPropTree(reference, [referencesDir]) as unknown as Record<string, unknown>;
}

test('collectUnknownProps: Object 配下の typo を検出（パス付き）', () => {
  const tree = { titleContent: { type: 'Object', props: { label: { type: 'String' } } } };
  const findings = collectUnknownProps(
    { titleContent: { labell: 'x' } },
    tree,
    SLIDEV_STANDARD_KEYS,
  );
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].path, 'titleContent.labell');
  assert.deepStrictEqual(findings[0].allowed, ['label']);
});

test('collectUnknownProps: annotated-image の廃止キーを実インデックスパスで検出', () => {
  clearCache();
  const tree = loadTree('annotated-image');
  const findings = collectUnknownProps(
    { layout: 'annotated-image', steps: [{ point1: '操作', action1: '旧', description1: '旧' }] },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  const paths = findings.map((f) => f.path);
  assert.ok(paths.includes('steps[0].action1'), `action1 missing: ${paths.join(', ')}`);
  assert.ok(paths.includes('steps[0].description1'), `description1 missing: ${paths.join(', ')}`);
  // allowed は同階層（steps 要素）の schema キー
  assert.ok(findings[0].allowed.includes('point1'));
  assert.ok(findings[0].allowed.includes('notes1'));
});

test('collectUnknownProps: 深いネスト（image.srcc NG / marker.px OK）', () => {
  clearCache();
  const tree = loadTree('annotated-image');
  const findings = collectUnknownProps(
    { steps: [{ image: { srcc: 'x' }, marker: { px: 10, py: 20 } }] },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  const paths = findings.map((f) => f.path);
  assert.deepStrictEqual(paths, ['steps[0].image.srcc']);
  assert.deepStrictEqual(findings[0].allowed, ['src', 'alt', 'objectFit']);
});

test('collectUnknownProps: 標準キーは降下しない', () => {
  clearCache();
  const tree = loadTree('annotated-image');
  const findings = collectUnknownProps(
    { title: { weird: 1 }, clicks: 5, layout: 'annotated-image' },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.deepStrictEqual(findings, []);
});

test('collectUnknownProps: items 宣言なし Array は skip', () => {
  const findings = collectUnknownProps(
    { radarIndicators: [{ foo: 1 }] },
    { radarIndicators: { type: 'Array' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('collectUnknownProps: Array<String>（スカラー配列）は skip', () => {
  const findings = collectUnknownProps(
    { tags: ['a', 'b'] },
    { tags: { type: 'Array<String>' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('collectUnknownProps: props 宣言なし Object は skip', () => {
  const findings = collectUnknownProps(
    { meta: { anything: 1 } },
    { meta: { type: 'Object' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('collectUnknownProps: media-right-image の新表記（props/items）が機能', () => {
  clearCache();
  const tree = loadTree('media-right-image');
  const findings = collectUnknownProps(
    { layout: 'media-right-image', descriptionContent: { items: [{ title: 'x', titl: 'typo' }] } },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.ok(findings.map((f) => f.path).includes('descriptionContent.items[0].titl'));
});

test('collectUnknownProps: agenda の新表記（items）が機能', () => {
  clearCache();
  const tree = loadTree('agenda');
  const findings = collectUnknownProps(
    { layout: 'agenda', items: [{ section: 'x', sectionn: 'typo' }] },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.ok(findings.map((f) => f.path).includes('items[0].sectionn'));
});

test('collectUnknownProps: media-right-chart の descriptionContent.items[] 配下 typo を検出', () => {
  clearCache();
  const tree = loadTree('media-right-chart');
  const findings = collectUnknownProps(
    {
      layout: 'media-right-chart',
      descriptionContent: { items: [{ title: 'x', titlee: 'typo' }] },
    },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  const finding = findings.find((f) => f.path === 'descriptionContent.items[0].titlee');
  assert.ok(finding, `titlee missing: ${findings.map((f) => f.path).join(', ')}`);
  assert.strictEqual(finding.isNested, true);
  assert.ok(finding.allowed.includes('title'));
  assert.ok(finding.allowed.includes('description'));
});

test('collectUnknownProps: examples を持つ全レイアウトの examples は 0 件', () => {
  // 配列のネストの形を 3 種含む。
  // - steps[].terminal.lines[] の 2 段配列
  // - tableContent.rows[].cells[] の Object > Array > Array<String>
  // - statContent.rows[] と readout.items[] の 2 つの Object 配列
  // レイアウトは fixture deck の references から列挙する。
  const layoutNames = fs
    .readdirSync(referencesDir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('_'))
    .map((f) => f.replace(/\.yaml$/, ''));
  assert.ok(layoutNames.length > 0, 'references に layout の yaml が無い');
  for (const layoutName of layoutNames) {
    clearCache();
    const reference = loadLayoutReference([referencesDir], layoutName) as {
      examples?: { frontmatter: string }[];
    };
    const tree = getLayoutPropTree(reference, [referencesDir]);
    const examples = reference?.examples ?? [];
    assert.ok(examples.length > 0, `${layoutName} に examples が無い`);
    for (const example of examples) {
      const fm = parseFrontmatter(example.frontmatter) as Record<string, unknown>;
      const findings = collectUnknownProps(fm, tree, SLIDEV_STANDARD_KEYS);
      assert.deepStrictEqual(
        findings,
        [],
        `${layoutName} example に予期しない finding: ${JSON.stringify(findings)}`,
      );
    }
  }
});

// rule レベル（mock context）

interface CapturedReport {
  messageId: string;
  data: { path?: string; prop?: string; allowed?: string; layout?: string };
}

function runRule(text: string, filename: string): CapturedReport[] {
  const reports: CapturedReport[] = [];
  const context = {
    sourceCode: { getText: () => text },
    filename,
    settings: { 'slidev-theme': { referencesDirectories: [referencesDir] } },
    report: (descriptor: CapturedReport) => reports.push(descriptor),
  };
  const visitors = noUnknownPropsRule.create(context as never) as unknown as {
    Program: (node: unknown) => void;
  };
  visitors.Program({});
  return reports;
}

test('rule: annotated-image の廃止キーで unknownNestedProp を report（負のコントロール）', () => {
  clearCache();
  const text = [
    '---',
    'layout: annotated-image',
    'title: "テスト見出し"',
    'steps:',
    '  - point1: "操作する"',
    '    action1: "旧キー"',
    '    description: "廃止エイリアス"',
    '    marker: { px: 10, py: 20 }',
    '---',
    '',
  ].join('\n');
  const filename = path.join(referencesDir, '..', 'neg-control.md');
  const reports = runRule(text, filename);
  const nestedPaths = reports
    .filter((r) => r.messageId === 'unknownNestedProp')
    .map((r) => r.data.path);
  assert.ok(nestedPaths.includes('steps[0].action1'), `action1 missing: ${nestedPaths.join(', ')}`);
  assert.ok(nestedPaths.includes('steps[0].description'), `description missing: ${nestedPaths.join(', ')}`);
});

test('rule: pages 配下の全 *.md が report 0 件（正のコントロール）', () => {
  clearCache();
  const pagesDir = path.dirname(referencesDir);
  const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'pages に *.md が無い');
  const offenders: { file: string; findings: string[] }[] = [];
  for (const file of files) {
    const full = path.join(pagesDir, file);
    const text = fs.readFileSync(full, 'utf-8');
    const reports = runRule(text, full);
    if (reports.length > 0) {
      offenders.push({
        file,
        findings: reports.map((r) => `${r.messageId}:${r.data.path ?? r.data.prop}`),
      });
    }
  }
  assert.deepStrictEqual(offenders, [], `unexpected findings:\n${JSON.stringify(offenders, null, 2)}`);
});

// テーマの宣言（layouts.references）が値の出どころであることを、テスト用テーマの references で固定する

const fixtureReferences = path.resolve(
  import.meta.dirname,
  '../../../../../../cli/tests/fixtures/themes/with-declaration/references',
);

function runWithReferences(text: string, referencesDirectories: string[]): CapturedReport[] {
  const reports: CapturedReport[] = [];
  const context = {
    sourceCode: { getText: () => text },
    filename: path.join(fixtureReferences, '..', 'page.md'),
    settings: { 'slidev-theme': { referencesDirectories } },
    report: (descriptor: CapturedReport) => reports.push(descriptor),
  };
  const visitors = noUnknownPropsRule.create(context as never) as unknown as {
    Program: (node: unknown) => void;
  };
  visitors.Program({});
  return reports;
}

test('rule: テーマが宣言した references の props で未知のキーを report する', () => {
  clearCache();
  const text = ['---', 'layout: panel', 'heading: "見出し"', 'bogus: 1', '---', ''].join('\n');
  const reports = runWithReferences(text, [fixtureReferences]);
  assert.deepStrictEqual(
    reports.map((r) => [r.messageId, r.data.prop]),
    [['unknownProp', 'bogus']],
  );
});

test('rule: テーマが宣言した references の props と includes に沿うキーは report しない', () => {
  clearCache();
  const text = ['---', 'layout: panel', 'heading: "見出し"', 'caption: "説明"', '---', ''].join('\n');
  assert.deepStrictEqual(runWithReferences(text, [fixtureReferences]), []);
});

test('rule: talk-dir 側の references が先にあれば、テーマ側の同名のレイアウトより優先する', () => {
  clearCache();
  const talkReferences = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-references-'));
  try {
    fs.writeFileSync(
      path.join(talkReferences, 'panel.yaml'),
      ['layout: panel', 'props:', '  heading:', "    type: 'String'", '  bogus:', "    type: 'Number'", ''].join('\n'),
    );
    const text = ['---', 'layout: panel', 'heading: "見出し"', 'bogus: 1', '---', ''].join('\n');
    assert.deepStrictEqual(runWithReferences(text, [talkReferences, fixtureReferences]), []);
    assert.strictEqual(runWithReferences(text, [fixtureReferences, talkReferences]).length, 1);
  } finally {
    fs.rmSync(talkReferences, { recursive: true, force: true });
  }
});

test('rule: references の場所が settings に無ければ検証しない', () => {
  clearCache();
  const text = ['---', 'layout: panel', 'bogus: 1', '---', ''].join('\n');
  assert.deepStrictEqual(runWithReferences(text, []), []);
});

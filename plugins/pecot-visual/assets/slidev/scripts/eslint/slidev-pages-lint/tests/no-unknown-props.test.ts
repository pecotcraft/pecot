import { test } from 'vitest';
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

test('props セクションがあると、キーの一覧を取得する', () => {
  const reference = {
    props: {
      sensitivity: { type: 'String', default: "'Internal'" },
      titleContent: { type: 'Object', default: 'null' },
    },
  };
  const result = getLayoutProps(reference);
  assert.deepStrictEqual(result, ['sensitivity', 'titleContent']);
});

test('props が null だと、空配列を返す', () => {
  assert.deepStrictEqual(getLayoutProps({ props: null }), []);
});

test('props セクションが無いと、空配列を返す', () => {
  assert.deepStrictEqual(getLayoutProps({}), []);
});

test('reference が null だと、空配列を返す', () => {
  assert.deepStrictEqual(getLayoutProps(null), []);
});

test('reference が undefined だと、空配列を返す', () => {
  assert.deepStrictEqual(getLayoutProps(undefined), []);
});

test('props が文字列（不正）だと、空配列を返す', () => {
  assert.deepStrictEqual(getLayoutProps({ props: 'invalid' }), []);
});

const referencesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references');

test('agenda を読むと、_common・_header・_footer の props を含める', () => {
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

test('referencesDir が無いと、includes を無視する', () => {
  const reference = {
    includes: ['_common', '_header'],
    props: { titleContent: { type: 'Object' } },
  };
  const result = getLayoutProps(reference);
  assert.deepStrictEqual(result, ['titleContent']);
});

test('includes が空配列でも、props を返す', () => {
  const reference = {
    includes: [],
    props: { sensitivity: { type: 'String' } },
  };
  const result = getLayoutProps(reference, [referencesDir]);
  assert.deepStrictEqual(result, ['sensitivity']);
});

test('存在しない共有 YAML を includes に書くと、無視する', () => {
  clearCache();
  const reference = {
    includes: ['_nonexistent'],
    props: { titleContent: { type: 'Object' } },
  };
  const result = getLayoutProps(reference, [referencesDir]);
  assert.deepStrictEqual(result, ['titleContent']);
});

test('SLIDEV_STANDARD_KEYS を読むと、layout を含む', () => {
  assert.ok(SLIDEV_STANDARD_KEYS.has('layout'));
});

test('SLIDEV_STANDARD_KEYS を読むと、clicks を含む', () => {
  assert.ok(SLIDEV_STANDARD_KEYS.has('clicks'));
});

test('SLIDEV_STANDARD_KEYS を読むと、title を含む', () => {
  assert.ok(SLIDEV_STANDARD_KEYS.has('title'));
});

test('SLIDEV_STANDARD_KEYS を読むと、transition を含む', () => {
  assert.ok(SLIDEV_STANDARD_KEYS.has('transition'));
});

test('SLIDEV_STANDARD_KEYS を読むと、15 個のキーが定義されている', () => {
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

test('SLIDEV_STANDARD_KEYS に未知のキーを探すと、含まれない', () => {
  assert.ok(!SLIDEV_STANDARD_KEYS.has('sensitivity'));
  assert.ok(!SLIDEV_STANDARD_KEYS.has('coverTitle'));
  assert.ok(!SLIDEV_STANDARD_KEYS.has('debug'));
});

test('ルールオブジェクトを読むと、問題の種類・メッセージ・create 関数を持つ', () => {
  const meta = noUnknownPropsRule.meta as { type: string; messages: Record<string, string> };
  assert.strictEqual(meta.type, 'problem');
  assert.ok(meta.messages.unknownProp);
  assert.strictEqual(typeof noUnknownPropsRule.create, 'function');
});

test('create を呼ぶと、root と Program のビジターを返す', () => {
  const mockContext = {
    sourceCode: { getText: () => '' },
    filename: '/test.md',
  };
  const visitors = noUnknownPropsRule.create(mockContext as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('メッセージを読むと、unknownNestedProp が定義されている', () => {
  const meta = noUnknownPropsRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.unknownNestedProp);
});

// getLayoutPropTree

test('ネストした schema を渡すと、ツリーとして取得する', () => {
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

test('実 _references を includes ごとにマージすると、ネストを保ったまま取得する', () => {
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

test('null・undefined・不正な型を渡すと、空の map を返す', () => {
  assert.deepStrictEqual(getLayoutPropTree(null), {});
  assert.deepStrictEqual(getLayoutPropTree(undefined), {});
  assert.deepStrictEqual(getLayoutPropTree({}), {});
  assert.deepStrictEqual(getLayoutPropTree({ props: 'invalid' }), {});
  assert.deepStrictEqual(getLayoutPropTree({ props: null }), {});
});

test('getLayoutProps と Object.keys(getLayoutPropTree) を比べると、等しい', () => {
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

test('__proto__ などの危険なキーがあると、prototype を汚染せず skip する', () => {
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

test('Object 配下に typo があると、パス付きで検出する', () => {
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

test('annotated-image の廃止キーがあると、実インデックスのパスで検出する', () => {
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

test('深いネストだと、image.srcc を検出し、marker.px は検出しない', () => {
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

test('標準キーだと、降下しない', () => {
  clearCache();
  const tree = loadTree('annotated-image');
  const findings = collectUnknownProps(
    { title: { weird: 1 }, clicks: 5, layout: 'annotated-image' },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.deepStrictEqual(findings, []);
});

test('items 宣言が無い Array だと、skip する', () => {
  const findings = collectUnknownProps(
    { radarIndicators: [{ foo: 1 }] },
    { radarIndicators: { type: 'Array' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('Array<String>（スカラー配列）だと、skip する', () => {
  const findings = collectUnknownProps(
    { tags: ['a', 'b'] },
    { tags: { type: 'Array<String>' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('props 宣言が無い Object だと、skip する', () => {
  const findings = collectUnknownProps(
    { meta: { anything: 1 } },
    { meta: { type: 'Object' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('media-right-image の新表記（props/items）だと、検出が機能する', () => {
  clearCache();
  const tree = loadTree('media-right-image');
  const findings = collectUnknownProps(
    { layout: 'media-right-image', descriptionContent: { items: [{ title: 'x', titl: 'typo' }] } },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.ok(findings.map((f) => f.path).includes('descriptionContent.items[0].titl'));
});

test('agenda の新表記（items）だと、検出が機能する', () => {
  clearCache();
  const tree = loadTree('agenda');
  const findings = collectUnknownProps(
    { layout: 'agenda', items: [{ section: 'x', sectionn: 'typo' }] },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.ok(findings.map((f) => f.path).includes('items[0].sectionn'));
});

test('media-right-chart の descriptionContent.items[] 配下に typo があると、検出する', () => {
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

test('examples を持つ全レイアウトの examples を渡すと、未知のキーを 0 件にする', () => {
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

test('annotated-image の廃止キーがあると、unknownNestedProp を報告する（負のコントロール）', () => {
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

test('pages 配下の全 *.md を渡すと、報告しない（正のコントロール）', () => {
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

test('テーマが宣言した references の props に無いキーがあると、報告する', () => {
  clearCache();
  const text = ['---', 'layout: panel', 'heading: "見出し"', 'bogus: 1', '---', ''].join('\n');
  const reports = runWithReferences(text, [fixtureReferences]);
  assert.deepStrictEqual(
    reports.map((r) => [r.messageId, r.data.prop]),
    [['unknownProp', 'bogus']],
  );
});

test('テーマが宣言した references の props と includes に沿うキーだと、報告しない', () => {
  clearCache();
  const text = ['---', 'layout: panel', 'heading: "見出し"', 'caption: "説明"', '---', ''].join('\n');
  assert.deepStrictEqual(runWithReferences(text, [fixtureReferences]), []);
});

test('talk-dir 側の references が先にあると、テーマ側の同名のレイアウトより優先する', () => {
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

test('references の場所が settings に無いと、検証しない', () => {
  clearCache();
  const text = ['---', 'layout: panel', 'bogus: 1', '---', ''].join('\n');
  assert.deepStrictEqual(runWithReferences(text, []), []);
});

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
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

test('props セクションがあると、キーの一覧を取得する', async () => {
  await explains('`getLayoutProps` が `props` セクションからキーを取得するテストです。`props` セクションがある場合に、キーの一覧が返ることを確認します。');
  const reference = {
    props: {
      sensitivity: { type: 'String', default: "'Internal'" },
      titleContent: { type: 'Object', default: 'null' },
    },
  };
  const result = getLayoutProps(reference);
  assert.deepStrictEqual(result, ['sensitivity', 'titleContent']);
});

test('props が null だと、空配列を返す', async () => {
  await explains('`getLayoutProps` が `props` が `null` の場合を扱うテストです。`props` が `null` の場合に、空の配列が返ることを確認します。');
  assert.deepStrictEqual(getLayoutProps({ props: null }), []);
});

test('props セクションが無いと、空配列を返す', async () => {
  await explains('`getLayoutProps` が `props` セクションのない場合を扱うテストです。`props` セクションが存在しない場合に、空の配列が返ることを確認します。');
  assert.deepStrictEqual(getLayoutProps({}), []);
});

test('reference が null だと、空配列を返す', async () => {
  await explains('`getLayoutProps` が `reference` を `null` で受け取る場合のテストです。`reference` が `null` の場合に、例外を発生させず空の配列が返ることを確認します。');
  assert.deepStrictEqual(getLayoutProps(null), []);
});

test('reference が undefined だと、空配列を返す', async () => {
  await explains('`getLayoutProps` が `reference` を `undefined` で受け取る場合のテストです。`reference` が `undefined` の場合に、例外を発生させず空の配列が返ることを確認します。');
  assert.deepStrictEqual(getLayoutProps(undefined), []);
});

test('props が文字列（不正）だと、空配列を返す', async () => {
  await explains('`getLayoutProps` が不正な `props` を扱うテストです。`props` が文字列の場合に、空の配列が返ることを確認します。');
  assert.deepStrictEqual(getLayoutProps({ props: 'invalid' }), []);
});

const referencesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references');

test('agenda を読むと、_common・_header・_footer の props を含める', async () => {
  await explains('`getLayoutProps` が `includes` の共有 YAML を取り込むテストです。`agenda` のように `_common`・`_header`・`_footer` を取り込む場合に、それぞれの `props` とレイアウト自身の `props` が含まれることを確認します。');
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

test('referencesDir が無いと、includes を無視する', async () => {
  await explains('`getLayoutProps` が `referencesDir` を受け取らない場合のテストです。`referencesDir` が存在しない場合に、`includes` を無視してレイアウト自身の `props` だけが返ることを確認します。');
  const reference = {
    includes: ['_common', '_header'],
    props: { titleContent: { type: 'Object' } },
  };
  const result = getLayoutProps(reference);
  assert.deepStrictEqual(result, ['titleContent']);
});

test('includes が空配列でも、props を返す', async () => {
  await explains('`getLayoutProps` が空の `includes` を扱うテストです。`includes` が空の配列の場合でも、レイアウト自身の `props` が返ることを確認します。');
  const reference = {
    includes: [],
    props: { sensitivity: { type: 'String' } },
  };
  const result = getLayoutProps(reference, [referencesDir]);
  assert.deepStrictEqual(result, ['sensitivity']);
});

test('存在しない共有 YAML を includes に書くと、無視する', async () => {
  await explains('`getLayoutProps` が存在しない共有 YAML を扱うテストです。`includes` に存在しない共有 YAML を書いた場合に、無視してレイアウト自身の `props` だけが返ることを確認します。');
  clearCache();
  const reference = {
    includes: ['_nonexistent'],
    props: { titleContent: { type: 'Object' } },
  };
  const result = getLayoutProps(reference, [referencesDir]);
  assert.deepStrictEqual(result, ['titleContent']);
});

test('SLIDEV_STANDARD_KEYS を読むと、layout を含む', async () => {
  await explains('`SLIDEV_STANDARD_KEYS` の内容のテストです。標準のキーの集合を参照した場合に、`layout` が含まれることを確認します。');
  assert.ok(SLIDEV_STANDARD_KEYS.has('layout'));
});

test('SLIDEV_STANDARD_KEYS を読むと、clicks を含む', async () => {
  await explains('`SLIDEV_STANDARD_KEYS` の内容のテストです。標準のキーの集合を参照した場合に、`clicks` が含まれることを確認します。');
  assert.ok(SLIDEV_STANDARD_KEYS.has('clicks'));
});

test('SLIDEV_STANDARD_KEYS を読むと、title を含む', async () => {
  await explains('`SLIDEV_STANDARD_KEYS` の内容のテストです。標準のキーの集合を参照した場合に、`title` が含まれることを確認します。');
  assert.ok(SLIDEV_STANDARD_KEYS.has('title'));
});

test('SLIDEV_STANDARD_KEYS を読むと、transition を含む', async () => {
  await explains('`SLIDEV_STANDARD_KEYS` の内容のテストです。標準のキーの集合を参照した場合に、`transition` が含まれることを確認します。');
  assert.ok(SLIDEV_STANDARD_KEYS.has('transition'));
});

test('SLIDEV_STANDARD_KEYS を読むと、15 個のキーが定義されている', async () => {
  await explains('`SLIDEV_STANDARD_KEYS` のキーの数のテストです。標準のキーの集合を参照した場合に、`layout` や `class` など 15 個のキーがすべて定義されていることを確認します。');
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

test('SLIDEV_STANDARD_KEYS に未知のキーを探すと、含まれない', async () => {
  await explains('`SLIDEV_STANDARD_KEYS` が標準以外のキーを含まないテストです。`sensitivity` や `coverTitle` など標準以外のキーを探した場合に、含まれないことを確認します。');
  assert.ok(!SLIDEV_STANDARD_KEYS.has('sensitivity'));
  assert.ok(!SLIDEV_STANDARD_KEYS.has('coverTitle'));
  assert.ok(!SLIDEV_STANDARD_KEYS.has('debug'));
});

test('ルールオブジェクトを読むと、問題の種類・メッセージ・create 関数を持つ', async () => {
  await explains('`no-unknown-props` ルールの定義のテストです。ルールを参照した場合に、種類が `problem` で、メッセージと `create` 関数が定義されていることを確認します。');
  const meta = noUnknownPropsRule.meta as { type: string; messages: Record<string, string> };
  assert.strictEqual(meta.type, 'problem');
  assert.ok(meta.messages.unknownProp);
  assert.strictEqual(typeof noUnknownPropsRule.create, 'function');
});

test('create を呼ぶと、root と Program のビジターを返す', async () => {
  await explains('`no-unknown-props` ルールの `create` のテストです。`create` を呼び出した場合に、`root` と `Program` のビジターが返ることを確認します。');
  const mockContext = {
    sourceCode: { getText: () => '' },
    filename: '/test.md',
  };
  const visitors = noUnknownPropsRule.create(mockContext as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
});

test('メッセージを読むと、unknownNestedProp が定義されている', async () => {
  await explains('`no-unknown-props` ルールのメッセージ定義のテストです。ルールのメッセージを参照した場合に、`unknownNestedProp` が定義されていることを確認します。');
  const meta = noUnknownPropsRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.unknownNestedProp);
});

// getLayoutPropTree

test('ネストした schema を渡すと、ツリーとして取得する', async () => {
  await explains('`getLayoutPropTree` がネストした schema を取得するテストです。`Object` と `Array` が入れ子になった schema を渡した場合に、ネストを保ったツリーが返ることを確認します。');
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

test('実 _references を includes ごとにマージすると、ネストを保ったまま取得する', async () => {
  await explains('`getLayoutPropTree` が実際の `_references` の `includes` を取り込むテストです。共有 YAML を取り込む場合に、ネストを保ったまま各 `props` が含まれることを確認します。');
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

test('null・undefined・不正な型を渡すと、空の map を返す', async () => {
  await explains('`getLayoutPropTree` が不正な入力を扱うテストです。`null`・`undefined`・不正な型を渡した場合に、空のマップが返ることを確認します。');
  assert.deepStrictEqual(getLayoutPropTree(null), {});
  assert.deepStrictEqual(getLayoutPropTree(undefined), {});
  assert.deepStrictEqual(getLayoutPropTree({}), {});
  assert.deepStrictEqual(getLayoutPropTree({ props: 'invalid' }), {});
  assert.deepStrictEqual(getLayoutPropTree({ props: null }), {});
});

test('getLayoutProps と Object.keys(getLayoutPropTree) を比べると、等しい', async () => {
  await explains('`getLayoutProps` と `getLayoutPropTree` の整合性のテストです。同じ reference を渡した場合に、`getLayoutProps` の結果が `getLayoutPropTree` のキーと一致することを確認します。');
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

test('__proto__ などの危険なキーがあると、prototype を汚染せず skip する', async () => {
  await explains('`getLayoutPropTree` が危険なキーを無視するテストです。`__proto__` や `constructor` をキーに持つ reference を渡した場合に、prototype が汚染されず、危険なキーが除かれることを確認します。');
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

test('Object 配下に typo があると、パス付きで検出する', async () => {
  await explains('`collectUnknownProps` が `Object` 配下の誤記を検出するテストです。`Object` 配下に未知のキーがある場合に、パスつきで 1 件検出され、許可されるキーが示されることを確認します。');
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

test('annotated-image の廃止キーがあると、実インデックスのパスで検出する', async () => {
  await explains('`collectUnknownProps` が `annotated-image` の廃止されたキーを検出するテストです。廃止されたキーを配列の要素へ書いた場合に、実際の添字を含むパスで検出されることを確認します。');
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

test('深いネストだと、image.srcc を検出し、marker.px は検出しない', async () => {
  await explains('`collectUnknownProps` が深いネストを検証するテストです。`image` 配下の誤記がある場合に、`steps[0].image.srcc` だけが検出され、正しい `marker.px` は検出されないことを確認します。');
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

test('標準キーだと、降下しない', async () => {
  await explains('`collectUnknownProps` が標準のキーを検証しないテストです。標準のキーの配下に任意の値がある場合に、検出が 0 件であることを確認します。');
  clearCache();
  const tree = loadTree('annotated-image');
  const findings = collectUnknownProps(
    { title: { weird: 1 }, clicks: 5, layout: 'annotated-image' },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.deepStrictEqual(findings, []);
});

test('items 宣言が無い Array だと、skip する', async () => {
  await explains('`collectUnknownProps` が `items` を宣言していない `Array` を扱うテストです。`items` の宣言が存在しない `Array` の場合に、検証をスキップして検出が 0 件であることを確認します。');
  const findings = collectUnknownProps(
    { radarIndicators: [{ foo: 1 }] },
    { radarIndicators: { type: 'Array' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('Array<String>（スカラー配列）だと、skip する', async () => {
  await explains('`collectUnknownProps` がスカラーの配列を扱うテストです。`Array<String>` の場合に、検証をスキップして検出が 0 件であることを確認します。');
  const findings = collectUnknownProps(
    { tags: ['a', 'b'] },
    { tags: { type: 'Array<String>' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('props 宣言が無い Object だと、skip する', async () => {
  await explains('`collectUnknownProps` が `props` を宣言していない `Object` を扱うテストです。`props` の宣言が存在しない `Object` の場合に、検証をスキップして検出が 0 件であることを確認します。');
  const findings = collectUnknownProps(
    { meta: { anything: 1 } },
    { meta: { type: 'Object' } },
    new Set(),
  );
  assert.deepStrictEqual(findings, []);
});

test('media-right-image の新表記（props/items）だと、検出が機能する', async () => {
  await explains('`collectUnknownProps` が `media-right-image` の新しい表記を検証するテストです。`props` と `items` で書いたレイアウトの場合に、配列の要素の誤記が検出されることを確認します。');
  clearCache();
  const tree = loadTree('media-right-image');
  const findings = collectUnknownProps(
    { layout: 'media-right-image', descriptionContent: { items: [{ title: 'x', titl: 'typo' }] } },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.ok(findings.map((f) => f.path).includes('descriptionContent.items[0].titl'));
});

test('agenda の新表記（items）だと、検出が機能する', async () => {
  await explains('`collectUnknownProps` が `agenda` の新しい表記を検証するテストです。`items` で書いたレイアウトの場合に、配列の要素の誤記が検出されることを確認します。');
  clearCache();
  const tree = loadTree('agenda');
  const findings = collectUnknownProps(
    { layout: 'agenda', items: [{ section: 'x', sectionn: 'typo' }] },
    tree as never,
    SLIDEV_STANDARD_KEYS,
  );
  assert.ok(findings.map((f) => f.path).includes('items[0].sectionn'));
});

test('media-right-chart の descriptionContent.items[] 配下に typo があると、検出する', async () => {
  await explains('`collectUnknownProps` が `media-right-chart` の `descriptionContent.items[]` を検証するテストです。配下に誤記がある場合に、ネストした指摘として検出され、許可されるキーが示されることを確認します。');
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

test('examples を持つ全レイアウトの examples を渡すと、未知のキーを 0 件にする', async () => {
  await explains('`collectUnknownProps` が各レイアウトの `examples` を受け入れるテストです。`examples` を持つ全レイアウトの `examples` を渡した場合に、未知のキーが 0 件であることを確認します。');
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

test('annotated-image の廃止キーがあると、unknownNestedProp を報告する（負のコントロール）', async () => {
  await explains('`no-unknown-props` ルールが `annotated-image` の廃止されたキーを報告するテストです。廃止されたキーを含む頁の場合に、`unknownNestedProp` がパスつきで報告されることを確認します。');
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

test('pages 配下の全 *.md を渡すと、報告しない（正のコントロール）', async () => {
  await explains('`no-unknown-props` ルールが fixture deck の頁を受け入れるテストです。`pages` 配下のすべての `*.md` を渡した場合に、報告が 0 件であることを確認します。');
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

test('テーマが宣言した references の props に無いキーがあると、報告する', async () => {
  await explains('`no-unknown-props` ルールがテーマの宣言した `references` を使うテストです。`props` に存在しないキーがある場合に、`unknownProp` が報告されることを確認します。');
  clearCache();
  const text = ['---', 'layout: panel', 'heading: "見出し"', 'bogus: 1', '---', ''].join('\n');
  const reports = runWithReferences(text, [fixtureReferences]);
  assert.deepStrictEqual(
    reports.map((r) => [r.messageId, r.data.prop]),
    [['unknownProp', 'bogus']],
  );
});

test('テーマが宣言した references の props と includes に沿うキーだと、報告しない', async () => {
  await explains('`no-unknown-props` ルールがテーマの宣言した `references` を使うテストです。`props` と `includes` に沿うキーの場合に、報告が 0 件であることを確認します。');
  clearCache();
  const text = ['---', 'layout: panel', 'heading: "見出し"', 'caption: "説明"', '---', ''].join('\n');
  assert.deepStrictEqual(runWithReferences(text, [fixtureReferences]), []);
});

test('talk-dir 側の references が先にあると、テーマ側の同名のレイアウトより優先する', async () => {
  await explains('`no-unknown-props` ルールが `references` の優先順位を扱うテストです。talk-dir 側の `references` を先頭へ並べた場合に、テーマ側の同名のレイアウトより優先されることを確認します。');
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

test('references の場所が settings に無いと、検証しない', async () => {
  await explains('`no-unknown-props` ルールが `references` の場所を受け取らない場合のテストです。settings へ場所を指定していない場合に、検証せず報告が 0 件であることを確認します。');
  clearCache();
  const text = ['---', 'layout: panel', 'bogus: 1', '---', ''].join('\n');
  assert.deepStrictEqual(runWithReferences(text, []), []);
});

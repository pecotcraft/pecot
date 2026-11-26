import { test } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import noNumericAssetPrefixRule from '../lib/rules/no-numeric-asset-prefix.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

const templatesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');
const pagesDir = path.join(templatesDir, 'pages');
const pageFile = path.join(pagesDir, 'cover.md');
const referencesPage = path.join(pagesDir, '_references', 'cover.md');

interface Report {
  messageId?: string;
  data?: { fileName?: string };
  loc?: { line: number; column: number };
}

function createVisitors(
  contextOverrides: Record<string, unknown>,
  reports: Report[],
): { root: (n: unknown) => void; image: (n: unknown) => void } {
  const mockContext = {
    filename: pageFile,
    report: (descriptor: Report) => reports.push(descriptor),
    ...contextOverrides,
  };
  return noNumericAssetPrefixRule.create(mockContext as never) as unknown as {
    root: (n: unknown) => void;
    image: (n: unknown) => void;
  };
}

// frontmatter 側: 生テキストを与えて root ビジターを回す
function runOnText(text: string, filePath: string = pageFile): Report[] {
  const reports: Report[] = [];
  createVisitors({ filename: filePath, sourceCode: { getText: () => text } }, reports).root({});
  return reports;
}

// 本文側: markdown/commonmark の image ノードを与える
function runOnImage(node: unknown, filePath: string = pageFile): Report[] {
  const reports: Report[] = [];
  createVisitors({ filename: filePath, sourceCode: { getText: () => '' } }, reports).image(node);
  return reports;
}

function frontmatter(body: string): string {
  return `---\n${body}\n---\n`;
}

test('meta.type を読むと、problem を返す', async () => {
  await explains('ルールの `meta.type` のテストです。`problem` であることを確認します。');
  assert.strictEqual(noNumericAssetPrefixRule.meta?.type, 'problem');
});

test('メッセージを読むと、numericAssetPrefix が定義されている', async () => {
  await explains('ルールの `meta.messages` のテストです。`numericAssetPrefix` のメッセージが定義されていることを確認します。');
  const meta = noNumericAssetPrefixRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.numericAssetPrefix);
});

test('create を呼ぶと、root・Program・image のビジターを返す', async () => {
  await explains('ルールの `create` のテストです。`root`・`Program`・`image` のビジターを関数として返すことを確認します。');
  const visitors = noNumericAssetPrefixRule.create({
    filename: pageFile,
    sourceCode: { getText: () => '' },
  } as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
  assert.strictEqual(typeof visitors.image, 'function');
});

test('frontmatter のトップレベルの文字列が数字始まりだと、検出する', async () => {
  await explains('frontmatter の画像参照を検証する、`no-numeric-asset-prefix` のテストです。トップレベルの文字列が数字で始まるファイル名の場合に、`numericAssetPrefix` を 1 件報告することを確認します。');
  const reports = runOnText(frontmatter("background: '/assets/04-lib-circleci-success.png'"));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'numericAssetPrefix');
  assert.strictEqual(reports[0].data?.fileName, '04-lib-circleci-success.png');
});

test('ネストした object・array 配下の参照が数字始まりでも、検出する', async () => {
  await explains('frontmatter の画像参照を検証する、`no-numeric-asset-prefix` のテストです。ネストしたオブジェクトや配列の下にある参照が数字で始まる場合でも、すべて検出してファイル名を報告することを確認します。');
  const reports = runOnText(
    frontmatter(
      [
        'imageContent:',
        "  src: 'assets/samples/01_login.png'",
        'steps:',
        '  - image:',
        "      src: 'assets/samples/02.deploy.jpeg'",
        "  - image: { src: 'assets/samples/03-result.WEBP' }",
      ].join('\n'),
    ),
  );
  assert.deepStrictEqual(
    reports.map((r) => r.data?.fileName),
    ['01_login.png', '02.deploy.jpeg', '03-result.WEBP'],
  );
});

test('区切り文字を伴わない数字始まりでも、検出する', async () => {
  await explains('数字始まりのファイル名の検出のテストです。`04.png` や `01cover.png` のように区切り文字を伴わない場合でも、検出することを確認します。');
  const reports = runOnText(
    frontmatter(
      [
        "a: 'assets/samples/04.png'",
        "b: 'assets/samples/01cover.png'",
        "c: 'assets/samples/2024review.jpg'",
      ].join('\n'),
    ),
  );
  assert.deepStrictEqual(
    reports.map((r) => r.data?.fileName),
    ['04.png', '01cover.png', '2024review.jpg'],
  );
});

test('数字で始まらない名前だと、検出しない', async () => {
  await explains('数字始まりのファイル名の検出のテストです。数字で始まらないファイル名の場合に、検出しないことを確認します。');
  const reports = runOnText(
    frontmatter(
      [
        "src: 'assets/samples/lib-circleci-success.png'",
        "alt: 'step2-deploy-done.svg'",
        "other: 'assets/samples/landscape-16x9.jpg'",
      ].join('\n'),
    ),
  );
  assert.strictEqual(reports.length, 0);
});

test('外部 URL だと、対象外として検出しない', async () => {
  await explains('検出の対象範囲のテストです。`https://` の URL や `data:` の URI の場合に、対象外として検出しないことを確認します。');
  const reports = runOnText(
    frontmatter(
      [
        "src: 'https://example.com/assets/04-lib-circleci-success.png'",
        "logo: 'data:image/png;base64,00-x.png'",
      ].join('\n'),
    ),
  );
  assert.strictEqual(reports.length, 0);
});

test('画像以外の拡張子だと、対象外として検出しない', async () => {
  await explains('検出の対象範囲のテストです。`.md` や `.drawio` のような画像以外の拡張子の場合に、対象外として検出しないことを確認します。');
  const reports = runOnText(
    frontmatter(["src: '01-cover.md'", "xmlSrc: '/slides/diagrams/02-flow.drawio'"].join('\n')),
  );
  assert.strictEqual(reports.length, 0);
});

test('文字列以外のスカラー値だと、無視する', async () => {
  await explains('検出の対象範囲のテストです。数値・真偽値・空の値のような文字列以外のスカラー値の場合に、無視することを確認します。');
  const reports = runOnText(frontmatter(['clicks: 3', 'hide: false', 'title:'].join('\n')));
  assert.strictEqual(reports.length, 0);
});

test('frontmatter が無い頁だと、検出しない', async () => {
  await explains('frontmatter が存在しないページの場合に、検出しないことを確認します。');
  const reports = runOnText('# 見出しのみ\n');
  assert.strictEqual(reports.length, 0);
});

test('getText() が throw すると、何もしない', async () => {
  await explains('ソースの取得（`getText`）が例外を投げた場合に、何も報告しないことを確認します。');
  const reports: Report[] = [];
  createVisitors(
    {
      sourceCode: {
        getText: () => {
          throw new Error('no source');
        },
      },
    },
    reports,
  ).root({});
  assert.strictEqual(reports.length, 0);
});

test('数字始まりの参照があると、frontmatter の該当行を指摘位置にする', async () => {
  await explains('指摘位置のテストです。数字始まりの参照がある場合に、指摘位置が frontmatter の該当行になることを確認します。');
  const reports = runOnText(
    frontmatter(
      ['layout: annotated-image', 'imageContent:', "  src: 'assets/samples/04-x.png'"].join('\n'),
    ),
  );
  assert.deepStrictEqual(reports[0].loc, { line: 4, column: 0 });
});

test('raw 行に現れない値（quote 表記差）だと、1 行目を指摘位置にする', async () => {
  await explains('指摘位置のテストです。frontmatter の生の行に現れない値（引用符の表記が異なる値）の場合に、指摘位置が 1 行目になることを確認します。');
  const reports = runOnText(frontmatter(['layout: cover', "alt: '04''s-shot.png'"].join('\n')));
  assert.strictEqual(reports[0].data?.fileName, "04's-shot.png");
  assert.deepStrictEqual(reports[0].loc, { line: 1, column: 0 });
});

test('_references/ 配下だと、frontmatter と本文を skip する', async () => {
  await explains('`_references/` 配下のページの場合に、frontmatter と本文のどちらも検証せず、何も報告しないことを確認します。');
  assert.strictEqual(
    runOnText(frontmatter("src: 'assets/samples/04-x.png'"), referencesPage).length,
    0,
  );
  assert.strictEqual(runOnImage({ url: '04-x.png' }, referencesPage).length, 0);
});

test('本文の image ノードが数字始まりだと、ノード自身の位置で検出する', async () => {
  await explains('本文の image ノードを検証する、`no-numeric-asset-prefix` のテストです。ファイル名が数字で始まる場合に、ノード自身の位置で検出することを確認します。');
  const reports = runOnImage({ url: '05-lib-deploy-done.png' });
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.fileName, '05-lib-deploy-done.png');
  assert.strictEqual(reports[0].loc, undefined);
});

test('本文の image ノードが場面ベース名だと、検出しない', async () => {
  await explains('本文の image ノードを検証する、`no-numeric-asset-prefix` のテストです。場面を表す名前（数字で始まらない名前）の場合に、検出しないことを確認します。');
  assert.strictEqual(runOnImage({ url: '/slides/images/lib-deploy-done.png' }).length, 0);
});

test('url を持たない image ノードだと、無視する', async () => {
  await explains('本文の image ノードを検証する、`no-numeric-asset-prefix` のテストです。`url` を持たないノードの場合に、無視することを確認します。');
  assert.strictEqual(runOnImage({}).length, 0);
});

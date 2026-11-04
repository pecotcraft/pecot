import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import noNumericAssetPrefixRule from '../lib/rules/no-numeric-asset-prefix.ts';

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

test('no-numeric-asset-prefix: meta.type が problem', () => {
  assert.strictEqual(noNumericAssetPrefixRule.meta?.type, 'problem');
});

test('no-numeric-asset-prefix: numericAssetPrefix メッセージが定義されている', () => {
  const meta = noNumericAssetPrefixRule.meta as { messages: Record<string, string> };
  assert.ok(meta.messages.numericAssetPrefix);
});

test('no-numeric-asset-prefix: create が root/Program/image ビジターを返す', () => {
  const visitors = noNumericAssetPrefixRule.create({
    filename: pageFile,
    sourceCode: { getText: () => '' },
  } as never) as unknown as Record<string, unknown>;
  assert.strictEqual(typeof visitors.root, 'function');
  assert.strictEqual(typeof visitors.Program, 'function');
  assert.strictEqual(typeof visitors.image, 'function');
});

test('no-numeric-asset-prefix: frontmatter のトップレベル文字列を検出', () => {
  const reports = runOnText(frontmatter("background: '/assets/04-lib-circleci-success.png'"));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'numericAssetPrefix');
  assert.strictEqual(reports[0].data?.fileName, '04-lib-circleci-success.png');
});

test('no-numeric-asset-prefix: ネストした object / array 配下の参照も検出', () => {
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

test('no-numeric-asset-prefix: 区切り文字を伴わない数字始まりも検出', () => {
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

test('no-numeric-asset-prefix: 数字で始まらない名前は検出しない', () => {
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

test('no-numeric-asset-prefix: 外部 URL は対象外', () => {
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

test('no-numeric-asset-prefix: 画像以外の拡張子は対象外', () => {
  const reports = runOnText(
    frontmatter(["src: '01-cover.md'", "xmlSrc: '/slides/diagrams/02-flow.drawio'"].join('\n')),
  );
  assert.strictEqual(reports.length, 0);
});

test('no-numeric-asset-prefix: 文字列以外のスカラー値は無視する', () => {
  const reports = runOnText(frontmatter(['clicks: 3', 'hide: false', 'title:'].join('\n')));
  assert.strictEqual(reports.length, 0);
});

test('no-numeric-asset-prefix: frontmatter が無いページは検出しない', () => {
  const reports = runOnText('# 見出しのみ\n');
  assert.strictEqual(reports.length, 0);
});

test('no-numeric-asset-prefix: getText() が throw する場合は何もしない', () => {
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

test('no-numeric-asset-prefix: 指摘位置は frontmatter の該当行', () => {
  const reports = runOnText(
    frontmatter(
      ['layout: annotated-image', 'imageContent:', "  src: 'assets/samples/04-x.png'"].join('\n'),
    ),
  );
  assert.deepStrictEqual(reports[0].loc, { line: 4, column: 0 });
});

test('no-numeric-asset-prefix: raw 行に現れない値（quote 表記差）は 1 行目に寄せる', () => {
  const reports = runOnText(frontmatter(['layout: cover', "alt: '04''s-shot.png'"].join('\n')));
  assert.strictEqual(reports[0].data?.fileName, "04's-shot.png");
  assert.deepStrictEqual(reports[0].loc, { line: 1, column: 0 });
});

test('no-numeric-asset-prefix: _references/ 配下は frontmatter / 本文とも skip', () => {
  assert.strictEqual(
    runOnText(frontmatter("src: 'assets/samples/04-x.png'"), referencesPage).length,
    0,
  );
  assert.strictEqual(runOnImage({ url: '04-x.png' }, referencesPage).length, 0);
});

test('no-numeric-asset-prefix: 本文の image ノードを検出（位置はノード自身）', () => {
  const reports = runOnImage({ url: '05-lib-deploy-done.png' });
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.fileName, '05-lib-deploy-done.png');
  assert.strictEqual(reports[0].loc, undefined);
});

test('no-numeric-asset-prefix: 本文の image ノードが場面ベース名なら検出しない', () => {
  assert.strictEqual(runOnImage({ url: '/slides/images/lib-deploy-done.png' }).length, 0);
});

test('no-numeric-asset-prefix: url を持たない image ノードは無視する', () => {
  assert.strictEqual(runOnImage({}).length, 0);
});

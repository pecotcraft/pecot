// 12 規則を実 ESLint（RuleTester）で通すテスト。
//
// 規則本体の create() を mock context で呼ぶテストは、次の 2 つを通らない。
// ESLint が実際に渡す context（sourceCode / filename）の形と、markdown 言語が作る root ノードの位置。
// ここでは `language: 'markdown/commonmark'` で実 ESLint を起動し、報告の messageId と行を固定する。
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuleTester } from 'eslint';
import markdown from '@eslint/markdown';
import { clearSlidesCache } from '../lib/utils/slides-loader.ts';
import noContentBeforeFrontmatter from '../lib/rules/no-content-before-frontmatter.ts';
import noMissingMarkerCell from '../lib/rules/no-missing-marker-cell.ts';
import noMissingPage from '../lib/rules/no-missing-page.ts';
import noNumericAssetPrefix from '../lib/rules/no-numeric-asset-prefix.ts';
import noNumericFilenamePrefix from '../lib/rules/no-numeric-filename-prefix.ts';
import noScaledDrawio from '../lib/rules/no-scaled-drawio.ts';
import noTripleHyphenInFrontmatter from '../lib/rules/no-triple-hyphen-in-frontmatter.ts';
import noUnknownProps from '../lib/rules/no-unknown-props.ts';
import oneSlidePerFile from '../lib/rules/one-slide-per-file.ts';
import requireMatchingLength from '../lib/rules/require-matching-length.ts';
import requireSlidesEntry from '../lib/rules/require-slides-entry.ts';
import validateClicks from '../lib/rules/validate-clicks.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// 規則テスト用の汎用の talk-dir（_shared/tests/fixtures/deck）
const templateRoot = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');

// 規則が `pages/_references`・`slides.md`・`public/` を実ファイルで探すため、
// fixture deck の references を写した talk-dir を組む。RuleTester の case は定義時に
// filename が要るので、同期で組んでから run を呼ぶ。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidev-pages-lint-rt-'));
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
fs.cpSync(path.join(templateRoot, 'pages', '_references'), path.join(root, 'pages', '_references'), {
  recursive: true,
});
fs.mkdirSync(path.join(root, 'public', 'assets', 'diagrams'), { recursive: true });
fs.copyFileSync(
  path.join(templateRoot, 'public', 'assets', 'diagrams', 'order-api.drawio'),
  path.join(root, 'public', 'assets', 'diagrams', 'order-api.drawio'),
);
// 図形 1 つだけの draw.io。表示枠に収まる図と、表示枠より十分大きい図（fitDiagram の scale が 1 未満）
const singleVertexDiagram = (width: number, height: number): string =>
  [
    '<mxfile><diagram id="d" name="p"><mxGraphModel><root>',
    '<mxCell id="0"/><mxCell id="1" parent="0"/>',
    '<mxCell id="v" value="b" style="rounded=0;" parent="1" vertex="1">',
    `<mxGeometry x="0" y="0" width="${width}" height="${height}" as="geometry"/></mxCell>`,
    '</root></mxGraphModel></diagram></mxfile>',
  ].join('\n');
fs.writeFileSync(path.join(root, 'public', 'assets', 'diagrams', 'small.drawio'), singleVertexDiagram(100, 50));
fs.writeFileSync(path.join(root, 'public', 'assets', 'diagrams', 'big.drawio'), singleVertexDiagram(3000, 2000));

const listedPages = ['ok.md', 'clicks-ok.md'];
fs.writeFileSync(
  path.join(root, 'slides.md'),
  `${listedPages.map((name) => `---\nsrc: ./pages/${name}\n---\n`).join('\n')}\n---\nsrc: ./pages/missing.md\n---\n`,
);
for (const name of listedPages) {
  fs.writeFileSync(path.join(root, 'pages', name), '---\nlayout: end\n---\n');
}
clearSlidesCache();

const page = (name: string): string => path.join(root, 'pages', name);
const slides = path.join(root, 'slides.md');
const doc = (...lines: string[]): string => `${lines.join('\n')}\n`;

// 規則が受ける値（settings['slidev-theme']）。fixture deck の宣言と、上で組んだ talk-dir の references を使う。
const declaration = JSON.parse(fs.readFileSync(path.join(templateRoot, 'pecot-theme.json'), 'utf-8')) as {
  drawio: { panels: Record<string, { width: number; height: number }>; markerLayouts: string[] };
};
const ruleTester = new RuleTester({
  plugins: { markdown },
  language: 'markdown/commonmark',
  settings: {
    'slidev-theme': {
      referencesDirectories: [path.join(root, 'pages', '_references')],
      panels: declaration.drawio.panels,
      markerLayouts: declaration.drawio.markerLayouts,
    },
  },
});

const end = (...extra: string[]): string =>
  doc('---', 'layout: end', "title: 'END'", "bridgeText: 'x'", ...extra, '---');

ruleTester.run('one-slide-per-file', oneSlidePerFile, {
  valid: [{ code: end(), filename: page('ok.md') }],
  invalid: [
    {
      code: doc(end().trimEnd(), '', end().trimEnd()),
      filename: page('ok.md'),
      errors: [{ messageId: 'multipleSlides', line: 1 }],
    },
  ],
});

ruleTester.run('no-content-before-frontmatter', noContentBeforeFrontmatter, {
  valid: [{ code: end(), filename: page('ok.md') }],
  invalid: [
    {
      code: doc('先頭にコンテンツがあります', end().trimEnd()),
      filename: page('ok.md'),
      errors: [{ messageId: 'contentBeforeFrontmatter', line: 1 }],
    },
  ],
});

ruleTester.run('no-triple-hyphen-in-frontmatter', noTripleHyphenInFrontmatter, {
  valid: [{ code: end(), filename: page('ok.md') }],
  invalid: [
    {
      code: doc('---', 'layout: end', '---', "bridgeText: 'x'", '---'),
      filename: page('ok.md'),
      errors: [{ messageId: 'tripleHyphenInFrontmatter', line: 1 }],
    },
  ],
});

ruleTester.run('validate-clicks', validateClicks, {
  valid: [
    {
      code: doc('---', 'layout: triad-triptych', 'clicks: 3', 'items:', '  - {}', '  - {}', '  - {}', '---'),
      filename: page('clicks-ok.md'),
    },
  ],
  invalid: [
    {
      code: doc('---', 'layout: triad-triptych', 'clicks: 1', 'items:', '  - {}', '  - {}', '  - {}', '---'),
      filename: page('clicks-ok.md'),
      errors: [{ messageId: 'incorrectClicksCount', line: 1 }],
    },
  ],
});

ruleTester.run('no-unknown-props', noUnknownProps, {
  valid: [{ code: end(), filename: page('ok.md') }],
  invalid: [
    {
      code: end("bogusTopLevel: 'x'"),
      filename: page('ok.md'),
      errors: [{ messageId: 'unknownProp', line: 1 }],
    },
    {
      code: doc(
        '---',
        'layout: triad-triptych',
        'clicks: 1',
        'items:',
        '  - { bogusNested: x }',
        '---',
      ),
      filename: page('clicks-ok.md'),
      errors: [{ messageId: 'unknownNestedProp', line: 1 }],
    },
  ],
});

ruleTester.run('require-slides-entry', requireSlidesEntry, {
  valid: [{ code: end(), filename: page('ok.md') }],
  invalid: [
    {
      code: end(),
      filename: page('not-listed.md'),
      errors: [{ messageId: 'missingEntry', line: 1 }],
    },
  ],
});

ruleTester.run('no-missing-page', noMissingPage, {
  valid: [{ code: doc('---', 'src: ./pages/ok.md', '---'), filename: slides }],
  invalid: [
    {
      code: doc('---', 'src: ./pages/ok.md', '---', '', '---', 'src: ./pages/missing.md', '---'),
      filename: slides,
      errors: [{ messageId: 'missingPage', line: 6 }],
    },
  ],
});

ruleTester.run('no-numeric-filename-prefix', noNumericFilenamePrefix, {
  valid: [{ code: end(), filename: page('cover.md') }],
  invalid: [
    {
      code: end(),
      filename: page('3-numeric-name.md'),
      errors: [{ messageId: 'numericFilenamePrefix', line: 1 }],
    },
  ],
});

ruleTester.run('no-numeric-asset-prefix', noNumericAssetPrefix, {
  valid: [
    { code: end("logo: '/assets/logo/brand.png'", ''), filename: page('ok.md') },
    { code: doc(end().trimEnd(), '', '![](https://example.com/2-body.png)'), filename: page('ok.md') },
  ],
  invalid: [
    {
      code: end("logo: '/assets/logo/1-brand.png'"),
      filename: page('ok.md'),
      errors: [{ messageId: 'numericAssetPrefix', line: 5 }],
    },
    {
      code: doc(end().trimEnd(), '', '![](2-body.png)'),
      filename: page('ok.md'),
      errors: [{ messageId: 'numericAssetPrefix', line: 7 }],
    },
  ],
});

const statReadout = (itemsCount: number): string =>
  doc(
    '---',
    'layout: stat-readout',
    'statContent:',
    '  rows:',
    '    - { label: a, value: "1", unit: u, detail: d }',
    '    - { label: b, value: "2", unit: u, detail: d }',
    'readout:',
    '  items:',
    ...Array.from({ length: itemsCount }, () => '    - { claim: c, detail: d }'),
    '---',
  );

ruleTester.run('require-matching-length', requireMatchingLength, {
  valid: [{ code: statReadout(2), filename: page('ok.md') }],
  invalid: [
    {
      code: statReadout(1),
      filename: page('ok.md'),
      errors: [{ messageId: 'lengthMismatch', line: 1 }],
    },
  ],
});

const annotatedDiagram = (cell: string): string =>
  doc(
    '---',
    'layout: annotated-diagram',
    'diagramContent:',
    '  xmlSrc: "/assets/diagrams/order-api.drawio"',
    'steps:',
    `  - marker: { cell: ${cell} }`,
    '---',
  );

ruleTester.run('no-missing-marker-cell', noMissingMarkerCell, {
  valid: [{ code: annotatedDiagram('api-gateway'), filename: page('ok.md') }],
  invalid: [
    {
      code: annotatedDiagram('no-such-cell'),
      filename: page('ok.md'),
      errors: [{ messageId: 'invalidCell', line: 6 }],
    },
  ],
});

const mediaRightDiagram = (xmlSrc: string): string =>
  doc('---', 'layout: media-right-diagram', 'mediaContent:', `  xmlSrc: ${xmlSrc}`, '---');

ruleTester.run('no-scaled-drawio', noScaledDrawio, {
  valid: [{ code: mediaRightDiagram('/assets/diagrams/small.drawio'), filename: page('ok.md') }],
  invalid: [
    {
      code: mediaRightDiagram('/assets/diagrams/big.drawio'),
      filename: page('ok.md'),
      errors: [{ messageId: 'scaled', line: 4 }],
    },
  ],
});

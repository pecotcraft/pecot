import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import noScaledDrawioRule from '../lib/rules/no-scaled-drawio.ts';

type Panels = Record<string, { width: number; height: number }>;

// fixture deck の宣言の値。規則は panels を settings で受ける。
const deckPanels = (
  JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck/pecot-theme.json'), 'utf-8'),
  ) as { drawio: { panels: Panels } }
).drawio.panels;
// テスト用テーマ（cli/tests/fixtures/themes/with-declaration）の宣言の値（panel: 400×300）
const fixturePanels = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../../../../cli/tests/fixtures/themes/with-declaration/pecot-theme.json'),
      'utf-8',
    ),
  ) as { drawio: { panels: Panels } }
).drawio.panels;

interface Report {
  messageId?: string;
  data?: Record<string, string>;
  loc?: { line: number; column: number };
}

// 一時の talk-dir（slides.md・pages/・public/slides/diagrams/）に図を置いて確認する
const talkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaled-drawio-'));
fs.writeFileSync(path.join(talkDir, 'slides.md'), '---\nsrc: ./pages/p.md\n---\n');
fs.mkdirSync(path.join(talkDir, 'pages'));
fs.mkdirSync(path.join(talkDir, 'public', 'slides', 'diagrams'), { recursive: true });
const pageFile = path.join(talkDir, 'pages', 'p.md');
after(() => fs.rmSync(talkDir, { recursive: true, force: true }));

/** 枠線なし（strokeColor=none）の矩形 1 つだけの図。外接矩形は width×height ちょうど */
function writeDiagram(name: string, width: number, height: number, style = 'rounded=0;strokeColor=none;', x = 0): string {
  const xml =
    '<mxfile><diagram name="p"><mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    `<mxCell id="a" value="a" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="0" width="${width}" height="${height}" as="geometry"/></mxCell>` +
    '</root></mxGraphModel></diagram></mxfile>';
  fs.writeFileSync(path.join(talkDir, 'public', 'slides', 'diagrams', name), xml);
  return `/slides/diagrams/${name}`;
}

function run(lines: string[], panels: Panels = deckPanels): Report[] {
  const reports: Report[] = [];
  const visitors = noScaledDrawioRule.create({
    filename: pageFile,
    settings: { 'slidev-theme': { panels } },
    sourceCode: { getText: () => ['---', ...lines, '---', ''].join('\n') },
    report: (descriptor: Report) => reports.push(descriptor),
  } as never) as unknown as { root: (n: unknown) => void };
  visitors.root({});
  return reports;
}

const topicIntro = (src: string) => ['layout: topic-intro', 'mediaContent:', `  xmlSrc: "${src}"`];

test('no-scaled-drawio: meta.type が problem', () => {
  assert.strictEqual(noScaledDrawioRule.meta?.type, 'problem');
});

test('no-scaled-drawio: 上限ちょうどの図は報告しない（topic-intro 435×318）', () => {
  assert.deepStrictEqual(run(topicIntro(writeDiagram('fit.drawio', 435, 318))), []);
});

test('no-scaled-drawio: 横が上限を超える図を指摘する', () => {
  const reports = run(topicIntro(writeDiagram('wide.drawio', 436, 318)));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'scaled');
  assert.deepStrictEqual(reports[0].data, {
    xmlSrc: '/slides/diagrams/wide.drawio',
    layout: 'topic-intro',
    width: '436',
    height: '318',
    maxWidth: '435',
    maxHeight: '318',
    percent: '99',
  });
  assert.strictEqual(reports[0].loc?.line, 4);
});

test('no-scaled-drawio: 縦が上限を超える図を指摘する', () => {
  const reports = run(topicIntro(writeDiagram('tall.drawio', 400, 400)));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.height, '400');
});

test('no-scaled-drawio: 小数で上限を超える図は切り上げの寸法で指摘する', () => {
  const reports = run(topicIntro(writeDiagram('frac.drawio', 435.2, 318)));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.width, '436');
});

test('no-scaled-drawio: media-right-diagram の上限は 435×288', () => {
  const lines = (src: string) => ['layout: media-right-diagram', 'mediaContent:', `  xmlSrc: "${src}"`];
  assert.deepStrictEqual(run(lines(writeDiagram('m-fit.drawio', 435, 288))), []);
  const reports = run(lines(writeDiagram('m-over.drawio', 435, 289)));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.maxHeight, '288');
});

test('no-scaled-drawio: 線幅 2 で 434×318 の図は線幅を含めて上限を超え指摘する', () => {
  const reports = run(topicIntro(writeDiagram('stroke.drawio', 434, 318, 'rounded=0;strokeColor=#000000;strokeWidth=2;')));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.width, '436');
  assert.strictEqual(reports[0].data?.height, '320');
});

test('no-scaled-drawio: x が小数・負でも上限内なら報告しない', () => {
  assert.deepStrictEqual(run(topicIntro(writeDiagram('neg.drawio', 435, 318, 'rounded=0;strokeColor=none;', -10.5))), []);
});

test('no-scaled-drawio: 図形の無い図は報告しない', () => {
  const xml =
    '<mxfile><diagram name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  fs.writeFileSync(path.join(talkDir, 'public', 'slides', 'diagrams', 'empty.drawio'), xml);
  assert.deepStrictEqual(run(topicIntro('/slides/diagrams/empty.drawio')), []);
});

test('no-scaled-drawio: 不正な XML は報告しない', () => {
  fs.writeFileSync(path.join(talkDir, 'public', 'slides', 'diagrams', 'broken.drawio'), '<mxfile><diagram>');
  assert.deepStrictEqual(run(topicIntro('/slides/diagrams/broken.drawio')), []);
});

test('no-scaled-drawio: 図ファイルが無ければ報告しない', () => {
  assert.deepStrictEqual(run(topicIntro('/slides/diagrams/missing.drawio')), []);
});

test('no-scaled-drawio: annotated-diagram は diagramContent と steps[].diagram を確認する', () => {
  const reports = run([
    'layout: annotated-diagram',
    'diagramContent:',
    `  xmlSrc: "${writeDiagram('a-fit.drawio', 500, 330)}"`,
    'steps:',
    '  - point1: "既定の図"',
    '  - point1: "別の図"',
    '    diagram:',
    `      xmlSrc: "${writeDiagram('a-over.drawio', 501, 330)}"`,
  ]);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.xmlSrc, '/slides/diagrams/a-over.drawio');
  assert.strictEqual(reports[0].data?.maxWidth, '500');
  assert.strictEqual(reports[0].data?.maxHeight, '330');
});

test('no-scaled-drawio: 同じ図は 1 回だけ指摘する', () => {
  const src = writeDiagram('dup.drawio', 600, 330);
  const reports = run([
    'layout: annotated-diagram',
    'diagramContent:',
    `  xmlSrc: "${src}"`,
    'steps:',
    '  - point1: "a"',
    '    diagram:',
    `      xmlSrc: "${src}"`,
  ]);
  assert.strictEqual(reports.length, 1);
});

test('no-scaled-drawio: 図パネルを持たないレイアウトは確認しない', () => {
  assert.deepStrictEqual(run(['layout: cover', 'mediaContent:', `  xmlSrc: "${writeDiagram('big.drawio', 900, 900)}"`]), []);
});

test('no-scaled-drawio: fixture deck の見本頁は上限内に収まる', () => {
  const templatesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');
  for (const layout of ['media-right-diagram', 'annotated-diagram']) {
    const file = path.join(templatesDir, 'pages', `${layout}.md`);
    const reports: Report[] = [];
    const visitors = noScaledDrawioRule.create({
      filename: file,
      settings: { 'slidev-theme': { panels: deckPanels } },
      sourceCode: { getText: () => fs.readFileSync(file, 'utf-8') },
      report: (descriptor: Report) => reports.push(descriptor),
    } as never) as unknown as { root: (n: unknown) => void };
    visitors.root({});
    assert.deepStrictEqual(reports, [], layout);
  }
});

// テーマの宣言（drawio.panels）が値の出どころであることを、テスト用テーマの値で固定する

test('no-scaled-drawio: 宣言した枠の上限（400×300 の枠なら 340×240）で判定する', () => {
  const mediaContent = (src: string) => ['layout: panel', 'mediaContent:', `  xmlSrc: "${src}"`];
  assert.deepStrictEqual(run(mediaContent(writeDiagram('t-fit.drawio', 340, 240)), fixturePanels), []);
  const reports = run(mediaContent(writeDiagram('t-over.drawio', 341, 240)), fixturePanels);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.layout, 'panel');
  assert.strictEqual(reports[0].data?.maxWidth, '340');
  assert.strictEqual(reports[0].data?.maxHeight, '240');
});

test('no-scaled-drawio: 宣言に無いレイアウトは、他のテーマで枠を持つレイアウト名でも確認しない', () => {
  const big = writeDiagram('t-big.drawio', 900, 900);
  assert.deepStrictEqual(run(topicIntro(big), fixturePanels), []);
});

test('no-scaled-drawio: 宣言が空なら何も確認しない', () => {
  assert.deepStrictEqual(run(topicIntro(writeDiagram('t-empty.drawio', 900, 900)), {}), []);
});

test('no-scaled-drawio: layout が constructor でも prototype の値を拾わない', () => {
  const lines = ['layout: constructor', 'mediaContent:', `  xmlSrc: "${writeDiagram('t-ctor.drawio', 900, 900)}"`];
  assert.deepStrictEqual(run(lines, fixturePanels), []);
});

test('no-scaled-drawio: xmlSrc の置き場所はレイアウトごとに決め打たず、frontmatter 全体から集める', () => {
  const lines = [
    'layout: panel',
    'extra:',
    '  nested:',
    '    - label: "x"',
    '      diagram:',
    `        xmlSrc: "${writeDiagram('t-nested.drawio', 400, 300)}"`,
  ];
  const reports = run(lines, fixturePanels);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.xmlSrc, '/slides/diagrams/t-nested.drawio');
});

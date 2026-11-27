import { test, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import noScaledDrawioRule from '../lib/rules/no-scaled-drawio.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

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
afterAll(() => fs.rmSync(talkDir, { recursive: true, force: true }));

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

test('meta.type を読むと、problem を返す', async () => {
  await explains('図の寸法が枠の上限を超えることを検出する、`no-scaled-drawio` 規則のテストです。規則の `meta.type` が `problem` であることを確認します。');
  assert.strictEqual(noScaledDrawioRule.meta?.type, 'problem');
});

test('上限ちょうどの図（topic-intro 435×318）だと、報告しない', async () => {
  await explains('`topic-intro` の図が上限（435×318）ちょうどの寸法の場合に、指摘されないことを確認します。');
  assert.deepStrictEqual(run(topicIntro(writeDiagram('fit.drawio', 435, 318))), []);
});

test('横が上限を超える図だと、指摘する', async () => {
  await explains('横が上限を超える図（436×318）の場合に、`scaled` の指摘が 1 件返り、図のパスと寸法、上限、縮小率が指摘のデータに含まれることを確認します。');
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

test('縦が上限を超える図だと、指摘する', async () => {
  await explains('縦が上限を超える図（400×400）の場合に、指摘が 1 件返り、指摘のデータの高さが `400` であることを確認します。');
  const reports = run(topicIntro(writeDiagram('tall.drawio', 400, 400)));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.height, '400');
});

test('小数で上限を超える図だと、切り上げの寸法で指摘する', async () => {
  await explains('幅が小数で上限をわずかに超える図（435.2）の場合に、切り上げた寸法（`436`）で指摘されることを確認します。');
  const reports = run(topicIntro(writeDiagram('frac.drawio', 435.2, 318)));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.width, '436');
});

test('media-right-diagram だと、上限を 435×288 にする', async () => {
  await explains('`media-right-diagram` の場合に、上限が 435×288 になり、高さが 289 の図だけが指摘されることを確認します。');
  const lines = (src: string) => ['layout: media-right-diagram', 'mediaContent:', `  xmlSrc: "${src}"`];
  assert.deepStrictEqual(run(lines(writeDiagram('m-fit.drawio', 435, 288))), []);
  const reports = run(lines(writeDiagram('m-over.drawio', 435, 289)));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.maxHeight, '288');
});

test('線幅 2 で 434×318 の図だと、線幅を含めて上限を超えるので指摘する', async () => {
  await explains('線幅 2 の図（434×318）の場合に、線幅を含めた外接の寸法（436×320）が上限を超えるため、指摘されることを確認します。');
  const reports = run(topicIntro(writeDiagram('stroke.drawio', 434, 318, 'rounded=0;strokeColor=#000000;strokeWidth=2;')));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.width, '436');
  assert.strictEqual(reports[0].data?.height, '320');
});

test('x が小数・負でも上限内だと、報告しない', async () => {
  await explains('図形の `x` 座標が小数や負の値であっても、寸法が上限内であれば指摘されないことを確認します。');
  assert.deepStrictEqual(run(topicIntro(writeDiagram('neg.drawio', 435, 318, 'rounded=0;strokeColor=none;', -10.5))), []);
});

test('図形の無い図だと、報告しない', async () => {
  await explains('図形を持たない図の場合に、指摘されないことを確認します。');
  const xml =
    '<mxfile><diagram name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  fs.writeFileSync(path.join(talkDir, 'public', 'slides', 'diagrams', 'empty.drawio'), xml);
  assert.deepStrictEqual(run(topicIntro('/slides/diagrams/empty.drawio')), []);
});

test('不正な XML だと、報告しない', async () => {
  await explains('不正な XML の図ファイルの場合に、例外が発生せず、指摘されないことを確認します。');
  fs.writeFileSync(path.join(talkDir, 'public', 'slides', 'diagrams', 'broken.drawio'), '<mxfile><diagram>');
  assert.deepStrictEqual(run(topicIntro('/slides/diagrams/broken.drawio')), []);
});

test('図ファイルが無いと、報告しない', async () => {
  await explains('図ファイルが存在しない場合に、指摘されないことを確認します。');
  assert.deepStrictEqual(run(topicIntro('/slides/diagrams/missing.drawio')), []);
});

test('annotated-diagram だと、diagramContent と steps[].diagram を確認する', async () => {
  await explains('`annotated-diagram` の場合に、`diagramContent` と `steps[].diagram` の両方の図が対象になり、上限を超えた図だけが指摘されることを確認します。');
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

test('同じ図が複数あると、1 回だけ指摘する', async () => {
  await explains('同じ図が複数の場所で使われている場合に、指摘が 1 件だけ返ることを確認します。');
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

test('図パネルを持たないレイアウトだと、確認しない', async () => {
  await explains('図の枠を持たないレイアウト（`cover`）の場合に、大きな図があっても指摘されないことを確認します。');
  assert.deepStrictEqual(run(['layout: cover', 'mediaContent:', `  xmlSrc: "${writeDiagram('big.drawio', 900, 900)}"`]), []);
});

test('fixture deck の見本頁を渡すと、上限内に収まっているので報告しない', async () => {
  await explains('fixture deck の見本ページ（`media-right-diagram` と `annotated-diagram`）の場合に、図が上限内に収まっていて、指摘されないことを確認します。');
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

test('宣言した枠が 400×300 だと、上限 340×240 で判定する', async () => {
  await explains('テーマの宣言（`drawio.panels`）で枠を 400×300 と宣言した場合に、上限 340×240 で判定され、上限を超えた図だけが指摘されることを確認します。');
  const mediaContent = (src: string) => ['layout: panel', 'mediaContent:', `  xmlSrc: "${src}"`];
  assert.deepStrictEqual(run(mediaContent(writeDiagram('t-fit.drawio', 340, 240)), fixturePanels), []);
  const reports = run(mediaContent(writeDiagram('t-over.drawio', 341, 240)), fixturePanels);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.layout, 'panel');
  assert.strictEqual(reports[0].data?.maxWidth, '340');
  assert.strictEqual(reports[0].data?.maxHeight, '240');
});

test('宣言に無いレイアウトだと、他のテーマで枠を持つレイアウト名でも確認しない', async () => {
  await explains('テーマの宣言に存在しないレイアウトの場合に、ほかのテーマで枠を持つレイアウト名（`topic-intro`）であっても、指摘されないことを確認します。');
  const big = writeDiagram('t-big.drawio', 900, 900);
  assert.deepStrictEqual(run(topicIntro(big), fixturePanels), []);
});

test('宣言が空だと、何も確認しない', async () => {
  await explains('テーマの宣言（`panels`）が空の場合に、どの図も指摘されないことを確認します。');
  assert.deepStrictEqual(run(topicIntro(writeDiagram('t-empty.drawio', 900, 900)), {}), []);
});

test('layout が constructor だと、prototype の値を拾わない', async () => {
  await explains('`layout` が `constructor` の場合に、`Object` の prototype の値を枠の宣言として拾わず、指摘されないことを確認します。');
  const lines = ['layout: constructor', 'mediaContent:', `  xmlSrc: "${writeDiagram('t-ctor.drawio', 900, 900)}"`];
  assert.deepStrictEqual(run(lines, fixturePanels), []);
});

test('xmlSrc を置く場所がレイアウトごとに違っても、frontmatter 全体から集める', async () => {
  await explains('`xmlSrc` の位置がレイアウトごとに異なっても、frontmatter 全体から集めた図のうち、上限を超えたものが指摘されることを確認します。');
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

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import noMissingMarkerCellRule from '../lib/rules/no-missing-marker-cell.ts';

// fixture deck を talk-dir として使う（slides.md と public/assets/diagrams/order-api.drawio がある）
const templatesDir = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');
const pageFile = path.join(templatesDir, 'pages', 'annotated-diagram.md');
const XML_SRC = '/assets/diagrams/order-api.drawio';

// fixture deck の宣言の値。規則は markerLayouts を settings で受ける。
const deckMarkerLayouts = (
  JSON.parse(fs.readFileSync(path.join(templatesDir, 'pecot-theme.json'), 'utf-8')) as {
    drawio: { markerLayouts: string[] };
  }
).drawio.markerLayouts;
// テスト用テーマ（cli/tests/fixtures/themes/with-declaration）の宣言の値（marked）
const fixtureMarkerLayouts = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../../../../cli/tests/fixtures/themes/with-declaration/pecot-theme.json'),
      'utf-8',
    ),
  ) as { drawio: { markerLayouts: string[] } }
).drawio.markerLayouts;

interface Report {
  messageId?: string;
  data?: Record<string, string>;
  loc?: { line: number; column: number };
}

function run(text: string, filePath: string = pageFile, markerLayouts: string[] = deckMarkerLayouts): Report[] {
  const reports: Report[] = [];
  const visitors = noMissingMarkerCellRule.create({
    filename: filePath,
    settings: { 'slidev-theme': { markerLayouts } },
    sourceCode: { getText: () => text },
    report: (descriptor: Report) => reports.push(descriptor),
  } as never) as unknown as { root: (n: unknown) => void };
  visitors.root({});
  return reports;
}

function page(lines: string[]): string {
  return ['---', ...lines, '---', ''].join('\n');
}

function diagramPage(cells: string[], xmlSrc: string = XML_SRC): string[] {
  return [
    'layout: annotated-diagram',
    'diagramContent:',
    `  xmlSrc: "${xmlSrc}"`,
    'steps:',
    ...cells.flatMap((cell) => [`  - point1: "要所"`, `    marker: { cell: ${cell} }`]),
  ];
}

test('no-missing-marker-cell: meta.type が problem', () => {
  assert.strictEqual(noMissingMarkerCellRule.meta?.type, 'problem');
});

test('no-missing-marker-cell: fixture deck の見本頁でエラーが出ない', () => {
  const reports = run(fs.readFileSync(pageFile, 'utf-8'));
  assert.deepStrictEqual(reports, []);
});

test('no-missing-marker-cell: 存在しない ID を指摘する（陰性対照 1）', () => {
  const reports = run(page(diagramPage(['api-gateway', 'no-such-cell'])));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'invalidCell');
  assert.strictEqual(reports[0].data?.index, '1');
  assert.strictEqual(reports[0].data?.cell, 'no-such-cell');
  assert.match(reports[0].data?.reason ?? '', /not found in the diagram/);
  // 指摘行は該当セルの行（frontmatter の 1 行目は '---'）
  assert.strictEqual(reports[0].loc?.line, 9);
});

test('no-missing-marker-cell: edge の ID を指摘する（陰性対照 2）', () => {
  const reports = run(page(diagramPage(['e-gw-auth'])));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'invalidCell');
  assert.match(reports[0].data?.reason ?? '', /is an edge/);
});

test('no-missing-marker-cell: xmlSrc の図が無ければ図ごとに 1 回だけ指摘する（陰性対照 3）', () => {
  const reports = run(page(diagramPage(['api-gateway', 'order-db'], '/assets/diagrams/missing.drawio')));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'missingDiagram');
  assert.strictEqual(reports[0].data?.xmlSrc, '/assets/diagrams/missing.drawio');
  assert.strictEqual(reports[0].data?.filePath, path.join(templatesDir, 'public', 'assets', 'diagrams', 'missing.drawio'));
});

test('no-missing-marker-cell: steps[].diagram の図で解決する', () => {
  const lines = [
    'layout: annotated-diagram',
    'diagramContent:',
    '  xmlSrc: "/assets/diagrams/missing.drawio"',
    'steps:',
    '  - point1: "要所"',
    '    diagram:',
    `      xmlSrc: "${XML_SRC}"`,
    '    marker: { cell: order-db }',
  ];
  assert.deepStrictEqual(run(page(lines)), []);
});

test('no-missing-marker-cell: 図の指定が無い marker.cell を指摘する', () => {
  const reports = run(page(['layout: annotated-diagram', 'steps:', '  - marker: { cell: api-gateway }']));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'noDiagram');
  assert.strictEqual(reports[0].data?.index, '0');
});

test('no-missing-marker-cell: 解析できない図（圧縮形式）を指摘する', () => {
  const talkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-cell-'));
  try {
    fs.writeFileSync(path.join(talkDir, 'slides.md'), '---\nsrc: ./pages/p.md\n---\n');
    fs.mkdirSync(path.join(talkDir, 'pages'));
    fs.mkdirSync(path.join(talkDir, 'public', 'slides', 'diagrams'), { recursive: true });
    fs.writeFileSync(
      path.join(talkDir, 'public', 'slides', 'diagrams', 'packed.drawio'),
      '<mxfile><diagram name="p">7VhNj9owEP01OYJiO3HI</diagram></mxfile>',
    );
    const reports = run(
      page(diagramPage(['a'], '/slides/diagrams/packed.drawio')),
      path.join(talkDir, 'pages', 'p.md'),
    );
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].messageId, 'invalidDiagram');
    assert.match(reports[0].data?.reason ?? '', /compressed <diagram>/);
  } finally {
    fs.rmSync(talkDir, { recursive: true, force: true });
  }
});

test('no-missing-marker-cell: annotated-diagram 以外のレイアウトは確認しない', () => {
  const lines = diagramPage(['no-such-cell']);
  lines[0] = 'layout: annotated-image';
  assert.deepStrictEqual(run(page(lines)), []);
});

test('no-missing-marker-cell: _references 配下は確認しない', () => {
  const referencesPage = path.join(templatesDir, 'pages', '_references', 'annotated-diagram.md');
  assert.deepStrictEqual(run(page(diagramPage(['no-such-cell'])), referencesPage), []);
});

// テーマの宣言（drawio.markerLayouts）が値の出どころであることを、テスト用テーマの値で固定する

test('no-missing-marker-cell: 宣言した印のレイアウトで確認する', () => {
  const lines = diagramPage(['no-such-cell']).map((line) => (line === 'layout: annotated-diagram' ? 'layout: marked' : line));
  const reports = run(page(lines), pageFile, fixtureMarkerLayouts);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'invalidCell');
  assert.strictEqual(reports[0].data?.cell, 'no-such-cell');
});

test('no-missing-marker-cell: 宣言に無いレイアウトは、annotated-diagram でも確認しない', () => {
  assert.deepStrictEqual(run(page(diagramPage(['no-such-cell'])), pageFile, fixtureMarkerLayouts), []);
});

test('no-missing-marker-cell: 宣言が空なら何も確認しない', () => {
  assert.deepStrictEqual(run(page(diagramPage(['no-such-cell'])), pageFile, []), []);
});

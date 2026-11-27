import { test } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import noMissingMarkerCellRule from '../lib/rules/no-missing-marker-cell.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

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

test('meta.type を読むと、problem を返す', async () => {
  await explains('`no-missing-marker-cell` ルールの種類のテストです。ルールの `meta.type` を参照した場合に、`problem` であることを確認します。');
  assert.strictEqual(noMissingMarkerCellRule.meta?.type, 'problem');
});

test('fixture deck の見本頁を渡すと、報告しない', async () => {
  await explains('`no-missing-marker-cell` ルールが fixture deck の見本頁を検証するテストです。見本頁を渡した場合に、報告が 0 件であることを確認します。');
  const reports = run(fs.readFileSync(pageFile, 'utf-8'));
  assert.deepStrictEqual(reports, []);
});

test('存在しない ID を渡すと、そのセルの行で invalidCell を報告する（陰性対照 1）', async () => {
  await explains('`no-missing-marker-cell` ルールが図に存在しないセルの ID を検出するテストです。存在しない ID を指定した場合に、該当セルの行で `invalidCell` が 1 件報告されることを確認します。');
  const reports = run(page(diagramPage(['api-gateway', 'no-such-cell'])));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'invalidCell');
  assert.strictEqual(reports[0].data?.index, '1');
  assert.strictEqual(reports[0].data?.cell, 'no-such-cell');
  assert.match(reports[0].data?.reason ?? '', /not found in the diagram/);
  // 指摘行は該当セルの行（frontmatter の 1 行目は '---'）
  assert.strictEqual(reports[0].loc?.line, 9);
});

test('edge の ID を渡すと、edge だと伝えて invalidCell を報告する（陰性対照 2）', async () => {
  await explains('`no-missing-marker-cell` ルールが辺の ID を指定した場合のテストです。セルではなく辺の ID を指定した場合に、辺であることを示す `invalidCell` が報告されることを確認します。');
  const reports = run(page(diagramPage(['e-gw-auth'])));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'invalidCell');
  assert.match(reports[0].data?.reason ?? '', /is an edge/);
});

test('xmlSrc の図が無いと、図ごとに 1 回だけ missingDiagram を報告する（陰性対照 3）', async () => {
  await explains('`no-missing-marker-cell` ルールが存在しない図を参照した場合のテストです。`xmlSrc` の図が存在しない場合に、図ごとに 1 回だけ `missingDiagram` が報告されることを確認します。');
  const reports = run(page(diagramPage(['api-gateway', 'order-db'], '/assets/diagrams/missing.drawio')));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'missingDiagram');
  assert.strictEqual(reports[0].data?.xmlSrc, '/assets/diagrams/missing.drawio');
  assert.strictEqual(reports[0].data?.filePath, path.join(templatesDir, 'public', 'assets', 'diagrams', 'missing.drawio'));
});

test('steps[].diagram の図があると、その図でセルを解決する', async () => {
  await explains('`no-missing-marker-cell` ルールがステップごとの図を使う場合のテストです。`steps[].diagram` で図を指定した場合に、その図でセルが解決され、報告が 0 件であることを確認します。');
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

test('図の指定が無い marker.cell を渡すと、noDiagram を報告する', async () => {
  await explains('`no-missing-marker-cell` ルールが図の指定のない `marker.cell` を検出するテストです。図を指定せずにセルを指定した場合に、`noDiagram` が報告されることを確認します。');
  const reports = run(page(['layout: annotated-diagram', 'steps:', '  - marker: { cell: api-gateway }']));
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'noDiagram');
  assert.strictEqual(reports[0].data?.index, '0');
});

test('圧縮形式の図を指すと、invalidDiagram を報告する', async () => {
  await explains('`no-missing-marker-cell` ルールが圧縮形式の図を指定した場合のテストです。圧縮形式の `.drawio` を指す場合に、`invalidDiagram` が報告され、理由に圧縮形式であることが含まれることを確認します。');
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

test('annotated-diagram 以外のレイアウトだと、確認しない', async () => {
  await explains('`no-missing-marker-cell` ルールの対象外のレイアウトのテストです。`annotated-diagram` 以外のレイアウトの場合に、存在しないセルを指定しても報告が 0 件であることを確認します。');
  const lines = diagramPage(['no-such-cell']);
  lines[0] = 'layout: annotated-image';
  assert.deepStrictEqual(run(page(lines)), []);
});

test('_references 配下の頁だと、確認しない', async () => {
  await explains('`no-missing-marker-cell` ルールの対象外の頁のテストです。`_references` 配下の頁の場合に、存在しないセルを指定しても報告が 0 件であることを確認します。');
  const referencesPage = path.join(templatesDir, 'pages', '_references', 'annotated-diagram.md');
  assert.deepStrictEqual(run(page(diagramPage(['no-such-cell'])), referencesPage), []);
});

// テーマの宣言（drawio.markerLayouts）が値の出どころであることを、テスト用テーマの値で固定する

test('宣言した印のレイアウトだと、そのレイアウトで確認する', async () => {
  await explains('`no-missing-marker-cell` ルールがテーマの宣言したレイアウトを対象にするテストです。テーマが `markerLayouts` に宣言したレイアウトの場合に、そのレイアウトで検証され、`invalidCell` が報告されることを確認します。');
  const lines = diagramPage(['no-such-cell']).map((line) => (line === 'layout: annotated-diagram' ? 'layout: marked' : line));
  const reports = run(page(lines), pageFile, fixtureMarkerLayouts);
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'invalidCell');
  assert.strictEqual(reports[0].data?.cell, 'no-such-cell');
});

test('宣言に無いレイアウトだと、annotated-diagram でも確認しない', async () => {
  await explains('`no-missing-marker-cell` ルールがテーマの宣言にないレイアウトを対象外にするテストです。宣言に存在しないレイアウトの場合に、`annotated-diagram` でも検証されず、報告が 0 件であることを確認します。');
  assert.deepStrictEqual(run(page(diagramPage(['no-such-cell'])), pageFile, fixtureMarkerLayouts), []);
});

test('宣言が空だと、何も確認しない', async () => {
  await explains('`no-missing-marker-cell` ルールがテーマの宣言が空の場合のテストです。`markerLayouts` が空の場合に、どのレイアウトも検証されず、報告が 0 件であることを確認します。');
  assert.deepStrictEqual(run(page(diagramPage(['no-such-cell'])), pageFile, []), []);
});

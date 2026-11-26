import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DrawioGeometryError,
  cellCenterPercent,
  fitDiagram,
  parseDrawio,
  resolveCellRect,
  staticImageOrigin,
  toPanelPoint,
} from '../lib/drawio-geometry.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

// drawio-geometry.ts は、annotated-diagram のマーカー位置を XML だけから求める。
// 期待値は、diagrams.net viewer（LDrawioDiagramBare と同じ srcdoc 設定）の描画を Playwright で計測した値。
// 計測したのは、キャンバス寸法・原点の平行移動・図形の画面座標。

const DIAGRAMS_DIR = join(import.meta.dirname, 'fixtures');

function readDiagram(name: string): string {
  return readFileSync(join(DIAGRAMS_DIR, `${name}.drawio`), 'utf-8');
}

function wrap(cells: string): string {
  return (
    '<mxfile><diagram name="p"><mxGraphModel><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    cells +
    '</root></mxGraphModel></diagram></mxfile>'
  );
}

function vertex(id: string, x: number, y: number, w: number, h: number, extra = ''): string {
  const style = extra.includes('style=') ? '' : ' style="strokeColor=none;"';
  return (
    `<mxCell id="${id}" value=""${style} vertex="1" parent="1" ${extra}>` +
    `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`
  );
}

function assertClose(actual: number, expected: number, tolerance = 0.01, label = ''): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label} 期待 ${expected} に対して ${actual}（許容 ${tolerance}）`,
  );
}

function assertGeometryError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof DrawioGeometryError, `DrawioGeometryError ではない: ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

const PANEL_560x400 = { width: 560, height: 400 };
const PANEL = { width: 560, height: 390 };

describe('drawioGeometry: 実図の viewer の計測値', () => {
  // [図名, viewer のキャンバス幅, 高さ]（いずれも外接矩形 W+60 / H+60）
  const cases: Array<[string, number, number]> = [
    ['pecotv-skills', 780, 480],
    ['plugin-mechanism', 855, 460],
    ['workflow-cycle', 910, 450],
  ];
  for (const [name, canvasWidth, canvasHeight] of cases) {
    it(`${name} の図を読むと、キャンバスを W+60 / H+60、原点を (20, 20) にする`, async () => {
      await explains(`annotated-image のマーカー位置を求める、\`drawio-geometry\` のテストです。実際の図（\`${name}\`）の場合に、キャンバスの寸法と原点の平行移動が、viewer での計測値と一致することを確認します。`);
      const model = parseDrawio(readDiagram(name));
      assert.ok(model.bounds && model.visualBounds);
      assert.equal(model.bounds.width + 60, canvasWidth);
      assert.equal(model.bounds.height + 60, canvasHeight);
      const fit = fitDiagram(model.visualBounds, PANEL_560x400);
      assert.equal(fit.canvasWidth, canvasWidth);
      assert.equal(fit.canvasHeight, canvasHeight);
      // 外接矩形の左上 (30, 10) がキャンバスの (20, 20) に来る
      assert.equal(fit.tx, 20 - model.bounds.x);
      assert.equal(fit.ty, 20 - model.bounds.y);
    });
  }

  it('pecotv-skills を 560×400 の枠に収めると、badge の左上を (402.41, 45.28) に描く', async () => {
    await explains('図形の位置を求める、`drawio-geometry` のテストです。`pecotv-skills` を 560×400 の枠へ収める場合に、`badge` の左上が viewer の計測値 (402.41, 45.28) と一致することを確認します。');
    const model = parseDrawio(readDiagram('pecotv-skills'));
    const badge = resolveCellRect(model, 'badge');
    assert.deepEqual(badge, { x: 570, y: 14, width: 180, height: 36, crisp: 0.5 });
    const fit = fitDiagram(model.visualBounds!, PANEL_560x400);
    assertClose(fit.scale, 560 / 780, 1e-9, 'scale');
    const p = toPanelPoint(fit, badge.x, badge.y, badge.crisp);
    assertClose(p.x, 402.41, 0.01, 'x');
    assertClose(p.y, 45.28, 0.01, 'y');
  });

  it('badge の中心を求めると、パネル比の百分率で返す', async () => {
    await explains('図形の中心を求める、`cellCenterPercent` のテストです。`pecotv-skills` の `badge` の場合に、中心の位置がパネルの幅と高さに対する百分率で返ることを確認します。');
    const model = parseDrawio(readDiagram('pecotv-skills'));
    const s = 560 / 780;
    const { px, py } = cellCenterPercent(model, 'badge', PANEL_560x400);
    assertClose(px, ((402.41 + 90 * s) / 560) * 100, 0.01, 'px');
    assertClose(py, ((45.28 + 18 * s) / 400) * 100, 0.01, 'py');
  });
});

describe('drawioGeometry: フィットモデル', () => {
  it('横長の図だと、幅に合わせて縮小し、縦方向の中央に置く', async () => {
    await explains('図をパネルに収める、`fitDiagram` のテストです。図がパネルより横長の場合に、幅に合わせて縮小し、縦方向の中央に置くことを確認します。');
    const model = parseDrawio(wrap(vertex('a', 0, 0, 1000, 100)));
    const fit = fitDiagram(model.visualBounds!, PANEL);
    const s = 560 / 1060;
    assertClose(fit.scale, s, 1e-9);
    assertClose(fit.offsetX, 0, 1e-9);
    assertClose(fit.offsetY, (390 - 160 * s) / 2, 1e-9);
    const c = cellCenterPercent(model, 'a', PANEL);
    assertClose((c.px / 100) * 560, (500 + 20 + 0.5) * s, 1e-6);
    assertClose((c.py / 100) * 390, (390 - 160 * s) / 2 + (50 + 20 + 0.5) * s, 1e-6);
  });

  it('縦長の図だと、高さに合わせて縮小し、横方向の中央に置く', async () => {
    await explains('図をパネルに収める、`fitDiagram` のテストです。図がパネルより縦長の場合に、高さに合わせて縮小し、横方向の中央に置くことを確認します。');
    const model = parseDrawio(wrap(vertex('a', 0, 0, 100, 1000)));
    const fit = fitDiagram(model.visualBounds!, PANEL);
    const s = 390 / 1060;
    assertClose(fit.scale, s, 1e-9);
    assertClose(fit.offsetX, (560 - 160 * s) / 2, 1e-9);
    assertClose(fit.offsetY, 0, 1e-9);
  });

  it('パネルより小さい図だと、拡大せず (s = 1) 中央に置く', async () => {
    await explains('図をパネルに収める、`fitDiagram` のテストです。図がパネルより小さい場合に、拡大せず等倍のまま中央に置くことを確認します。');
    const model = parseDrawio(wrap(vertex('a', 0, 0, 200, 100)));
    const fit = fitDiagram(model.visualBounds!, PANEL);
    assert.equal(fit.scale, 1);
    assert.equal(fit.offsetX, (560 - 260) / 2);
    assert.equal(fit.offsetY, (390 - 160) / 2);
    const c = cellCenterPercent(model, 'a', PANEL);
    assertClose((c.px / 100) * 560, 150 + 100 + 20.5, 1e-9);
    assertClose((c.py / 100) * 390, 115 + 50 + 20.5, 1e-9);
  });

  it('幅がパネルちょうどの図だと、右端の図形を右から 40px（= 60 - 20）の位置に置く', async () => {
    await explains('図をパネルに収める、`fitDiagram` のテストです。図の幅がパネルの幅にちょうど収まる場合は、右端の図形が右から 40px の位置に来ることを確認します。');
    // W + 60 = 560 で s = 1、左右の余白は 20 / 40
    const model = parseDrawio(wrap(vertex('left', 0, 0, 10, 10) + vertex('right', 490, 0, 10, 10)));
    const fit = fitDiagram(model.visualBounds!, PANEL);
    assert.equal(fit.canvasWidth, 560);
    assert.equal(fit.scale, 1);
    assert.equal(fit.offsetX, 0);
    assert.equal(toPanelPoint(fit, 0, 0).x, 20);
    assert.equal(toPanelPoint(fit, 500, 0).x, 520);
  });

  it('外接矩形に端数があると、原点の平行移動を切り捨て、キャンバスの寸法を切り上げる', async () => {
    await explains('図をパネルに収める、`fitDiagram` のテストです。外接矩形に端数がある場合に、原点の平行移動を切り捨て、キャンバスの寸法を切り上げることを確認します。');
    const model = parseDrawio(wrap(vertex('a', 100.3, 100, 100, 50) + vertex('b', 400.4, 300, 100, 50)));
    const fit = fitDiagram(model.visualBounds!, PANEL);
    assert.equal(fit.tx, -81);
    assert.equal(fit.ty, -80);
    assert.equal(fit.canvasWidth, 460);
    assert.equal(fit.canvasHeight, 310);
  });

  it('枠線のある図形だと、線幅の半分だけ外接矩形を広げる', async () => {
    await explains('図をパネルに収める、`fitDiagram` のテストです。枠線のある図形の場合に、線幅の半分だけ外接矩形を広げ、線幅が偶数の図形には格子合わせ（0.5）を掛けないことを確認します。');
    const model = parseDrawio(
      wrap(
        vertex('a', 100, 100, 100, 50, 'style="strokeWidth=4;"') +
          vertex('b', 400, 300, 100, 50, 'style="strokeWidth=3;"'),
      ),
    );
    const fit = fitDiagram(model.visualBounds!, PANEL);
    assert.equal(fit.tx, -78);
    assert.equal(fit.canvasWidth, 464);
    assert.equal(fit.canvasHeight, 314);
    // 線幅が偶数の図形は格子合わせ (0.5) が掛からない
    assert.equal(resolveCellRect(model, 'a').crisp, 0);
    assert.equal(resolveCellRect(model, 'b').crisp, 0.5);
  });

  it('text か image のスタイルの図形だと、枠線を持たないものとして扱う', async () => {
    await explains('図をパネルに収める、`fitDiagram` のテストです。スタイルが `text` や `image` の図形の場合に、枠線を持たないものとして扱い、外接矩形を広げないことを確認します。');
    const model = parseDrawio(
      wrap(vertex('a', 100, 100, 100, 50) + vertex('b', 400, 300, 100, 50, 'style="text;html=1;"')),
    );
    const fit = fitDiagram(model.visualBounds!, PANEL);
    assert.equal(fit.canvasWidth, 460);
    assert.equal(fit.canvasHeight, 310);
  });

  it('export した SVG の原点を求めると、viewer の線幅 1 の図形と同じ位置に置く', async () => {
    await explains('export した SVG の原点を求める、`staticImageOrigin` のテストです。線幅 1 の図形の場合に、viewer と同じ位置を原点にし、倍率が 1 になることを確認します。');
    const model = parseDrawio(wrap(vertex('a', 0, 0, 200, 100)));
    const fit = fitDiagram(model.visualBounds!, PANEL);
    const origin = staticImageOrigin(fit, model.visualBounds!);
    const viewerTopLeft = toPanelPoint(fit, 0, 0, resolveCellRect(model, 'a').crisp);
    assert.deepEqual(origin, { x: viewerTopLeft.x, y: viewerTopLeft.y, scale: 1 });
  });
});

describe('drawioGeometry: セル解決', () => {
  it('parent が入れ子になっていると、2 段分の offset を加算する', async () => {
    await explains('セルの位置を求める、`resolveCellRect` のテストです。`parent` が入れ子になっている場合に、2 段分のオフセットを加算した位置を返すことを確認します。');
    const xml = wrap(
      '<mxCell id="g" value="" style="group" vertex="1" connectable="0" parent="1">' +
        '<mxGeometry x="600" y="300" width="100" height="100" as="geometry"/></mxCell>' +
        '<mxCell id="c" value="" style="swimlane;" vertex="1" parent="g">' +
        '<mxGeometry x="50" y="50" width="100" height="50" as="geometry"/></mxCell>' +
        '<mxCell id="d" value="" vertex="1" parent="c">' +
        '<mxGeometry x="10" y="20" width="30" height="10" as="geometry"/></mxCell>',
    );
    const model = parseDrawio(xml);
    assert.deepEqual(resolveCellRect(model, 'c'), { x: 650, y: 350, width: 100, height: 50, crisp: 0.5 });
    assert.deepEqual(resolveCellRect(model, 'd'), { x: 660, y: 370, width: 30, height: 10, crisp: 0.5 });
    assert.deepEqual(model.bounds, { x: 600, y: 300, width: 150, height: 100 });
  });

  it('複数のレイヤに図形があると、すべて解決して外接矩形に含める', async () => {
    await explains('セルの位置を求める、`resolveCellRect` のテストです。複数のレイヤに図形がある場合に、すべてを外接矩形に含め、レイヤ自体の ID には `not-vertex` のエラーを投げることを確認します。');
    const xml = wrap(
      vertex('a', 0, 0, 10, 10) +
        '<mxCell id="layer2" parent="0"/>' +
        '<mxCell id="b" value="" style="strokeColor=none;" vertex="1" parent="layer2">' +
        '<mxGeometry x="200" y="100" width="20" height="20" as="geometry"/></mxCell>',
    );
    const model = parseDrawio(xml);
    assert.deepEqual(resolveCellRect(model, 'b'), { x: 200, y: 100, width: 20, height: 20, crisp: 0.5 });
    assert.deepEqual(model.bounds, { x: 0, y: 0, width: 220, height: 120 });
    assertGeometryError(() => resolveCellRect(model, 'layer2'), 'not-vertex');
  });

  it('visible="0" の図形と非表示のレイヤの子があると、除外する', async () => {
    await explains('セルの位置を求める、`resolveCellRect` のテストです。`visible="0"` の図形と非表示のレイヤの子がある場合に、外接矩形から除き、ID を指定すると `hidden-cell` のエラーを投げることを確認します。');
    const xml = wrap(
      vertex('a', 0, 0, 10, 10) +
        vertex('hidden', 500, 500, 10, 10, 'visible="0"') +
        '<mxCell id="layer2" parent="0" visible="0"/>' +
        '<mxCell id="b" value="" vertex="1" parent="layer2">' +
        '<mxGeometry x="900" y="900" width="20" height="20" as="geometry"/></mxCell>',
    );
    const model = parseDrawio(xml);
    assert.deepEqual(model.bounds, { x: 0, y: 0, width: 10, height: 10 });
    assertGeometryError(() => resolveCellRect(model, 'hidden'), 'hidden-cell');
    assertGeometryError(() => resolveCellRect(model, 'b'), 'hidden-cell');
  });

  it('relative="1" の子があると、外接矩形に含めず、解決もしない', async () => {
    await explains('セルの位置を求める、`resolveCellRect` のテストです。`relative="1"` の子がある場合に、外接矩形に含めず、ID を指定すると `relative-cell` のエラーを投げることを確認します。');
    const xml = wrap(
      vertex('a', 0, 0, 100, 100) +
        '<mxCell id="port" value="" vertex="1" parent="a">' +
        '<mxGeometry x="1" y="0.5" width="400" height="400" relative="1" as="geometry"/></mxCell>',
    );
    const model = parseDrawio(xml);
    assert.deepEqual(model.bounds, { x: 0, y: 0, width: 100, height: 100 });
    assertGeometryError(() => resolveCellRect(model, 'port'), 'relative-cell');
  });

  it('edge があると、経由点と未接続の端点を外接矩形に入れ、接続済みの端点は入れない', async () => {
    await explains('外接矩形の求め方のテストです。edge（線）がある場合に、経由点と未接続の端点を外接矩形に含め、接続済みの端点は含めないことを確認します。');
    // viewer の計測時と同じ枠線あり（線幅 1）の図形
    const base =
      vertex('a', 100, 100, 100, 50, 'style="rounded=0;"') +
      vertex('b', 400, 100, 100, 50, 'style="rounded=0;"');
    const waypoint = parseDrawio(
      wrap(
        base +
          '<mxCell id="e" style="endArrow=none;" edge="1" parent="1" source="a" target="b">' +
          '<mxGeometry relative="1" as="geometry"><mxPoint x="0" y="999" as="sourcePoint"/>' +
          '<Array as="points"><mxPoint x="300" y="400"/></Array></mxGeometry></mxCell>',
      ),
    );
    assert.deepEqual(waypoint.bounds, { x: 100, y: 100, width: 400, height: 300 });
    // 計測 461×362（線幅 1 の線は ±1 と格子合わせ 0.5 だけ広がる）
    const fit = fitDiagram(waypoint.visualBounds!, PANEL);
    assert.equal(fit.canvasWidth, 461);
    assert.equal(fit.canvasHeight, 362);

    const free = parseDrawio(
      wrap(
        base +
          '<mxCell id="e" style="endArrow=none;" edge="1" parent="1">' +
          '<mxGeometry relative="1" as="geometry"><mxPoint x="0" y="400" as="sourcePoint"/>' +
          '<mxPoint x="150" y="400" as="targetPoint"/></mxGeometry></mxCell>',
      ),
    );
    assert.deepEqual(free.bounds, { x: 0, y: 100, width: 500, height: 300 });
    const freeFit = fitDiagram(free.visualBounds!, PANEL);
    // 計測 561×362 / tx 20
    assert.deepEqual([freeFit.canvasWidth, freeFit.canvasHeight, freeFit.tx], [561, 362, 20]);
  });

  it('属性値に実体参照があると、解いた値で ID を探す', async () => {
    await explains('セルの ID の解決のテストです。属性値に実体参照（`&amp;`）がある場合に、解いた後の値（`api&gw`）で ID を検索できることを確認します。');
    const model = parseDrawio(wrap(vertex('api&amp;gw', 0, 0, 10, 10)));
    assert.equal(resolveCellRect(model, 'api&gw').width, 10);
  });

  it('未知の ID か edge の ID を渡すと、unknown-cell か edge-cell のエラーを投げる', async () => {
    await explains('セルの位置を求める、`resolveCellRect` のテストです。存在しない ID と edge の ID を指定した場合に、それぞれ `unknown-cell` と `edge-cell` のエラーを投げることを確認します。');
    const model = parseDrawio(
      wrap(
        vertex('a', 0, 0, 10, 10) +
          '<mxCell id="e" edge="1" parent="1" source="a"><mxGeometry relative="1" as="geometry"/></mxCell>',
      ),
    );
    assertGeometryError(() => resolveCellRect(model, 'nope'), 'unknown-cell');
    assertGeometryError(() => resolveCellRect(model, 'e'), 'edge-cell');
  });
});

describe('drawioGeometry: 非対応形式', () => {
  it('<diagram> が圧縮されていると、compressed のエラーを投げる', async () => {
    await explains('非対応の形式を読み込む、`parseDrawio` のテストです。`<diagram>` が圧縮されている場合に、`compressed` のエラーを投げることを確認します。');
    assertGeometryError(
      () => parseDrawio('<mxfile><diagram id="x" name="p">7VhNb9swDP01PnaIP+Kkx6RNhwEbUKCHbadBtRlbqyx5Mt0k+/WjbDmxa6fNsKbYgB0Ci0+kRPI9MbIdPym3HzWv8i8qBeH4s3Tr+Ld3vn8/C+jRALsWiL1ZC2Saw6oIB+CB/wJr2sCs5inUA0dUSiCvhmCipIQEBxjXWm2GbmslhrtWPIMR8JBwMUa/8hTzFl1Gs</diagram></mxfile>'),
      'compressed',
    );
  });

  it('セルを <object> や <UserObject> で包んでいると、wrapped-cell のエラーを投げる', async () => {
    await explains('非対応の形式を読み込む、`parseDrawio` のテストです。セルを `<object>` または `<UserObject>` で包んでいる場合に、`wrapped-cell` のエラーを投げることを確認します。');
    for (const tag of ['object', 'UserObject']) {
      const xml = wrap(
        `<${tag} label="API" id="api"><mxCell style="" vertex="1" parent="1">` +
          `<mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell></${tag}>`,
      );
      assertGeometryError(() => parseDrawio(xml), 'wrapped-cell');
    }
  });

  it('ページが複数あると、multi-page のエラーを投げる', async () => {
    await explains('非対応の形式を読み込む、`parseDrawio` のテストです。ページが複数ある場合に、`multi-page` のエラーを投げることを確認します。');
    const page = '<diagram name="p"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram>';
    assertGeometryError(() => parseDrawio(`<mxfile>${page}${page}</mxfile>`), 'multi-page');
  });

  it('空文字列か mxGraphModel の無い XML だと、empty-xml か no-model のエラーを投げる', async () => {
    await explains('非対応の形式を読み込む、`parseDrawio` のテストです。空文字列の場合は `empty-xml`、`mxGraphModel` を含まない XML の場合は `no-model` のエラーを投げることを確認します。');
    assertGeometryError(() => parseDrawio(''), 'empty-xml');
    assertGeometryError(() => parseDrawio('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'no-model');
  });
});

describe('drawioGeometry: XML コメント', () => {
  it('コメントの中にセルがあると、無視し、外のセルを読む', async () => {
    await explains('XML コメントの扱いのテストです。コメントの中にセルがある場合に、そのセルを無視して外側のセルだけを読むことを確認します。');
    const xml = wrap(
      '<!-- ' + vertex('hidden', 0, 0, 10, 10) + ' -->' + vertex('a', 100, 100, 50, 40),
    );
    const model = parseDrawio(xml);
    assert.equal(resolveCellRect(model, 'a').width, 50);
    assert.throws(() => resolveCellRect(model, 'hidden'));
  });

  it('コメントが連続していると、すべて除く', async () => {
    await explains('XML コメントの扱いのテストです。コメントが連続している場合に、すべてのコメントを除くことを確認します。');
    const xml = wrap('<!--a--><!--b-->' + vertex('a', 0, 0, 30, 20) + '<!-- c -->');
    const model = parseDrawio(xml);
    assert.equal(resolveCellRect(model, 'a').width, 30);
  });

  it('コメントが閉じていないと、除かずに後続をそのまま残す', async () => {
    await explains('XML コメントの扱いのテストです。コメントが閉じていない場合に、除かず後続をそのまま残すことを確認します。');
    const xml = wrap(vertex('a', 0, 0, 30, 20) + '<!-- 閉じない');
    const model = parseDrawio(xml);
    assert.equal(resolveCellRect(model, 'a').width, 30);
  });

  it('`<!-->` で始まるコメントだと、閉じ記号を共有せず、直後の 4 文字より後ろから閉じ記号を探す', async () => {
    await explains('XML コメントの扱いのテストです。`<!-->` で始まるコメントの場合に、閉じ記号を共有せず、直後の 4 文字より後ろから閉じ記号を探すことを確認します。');
    const xml = wrap('<!-->' + vertex('hidden', 0, 0, 10, 10) + '-->' + vertex('a', 0, 0, 30, 20));
    const model = parseDrawio(xml);
    assert.equal(resolveCellRect(model, 'a').width, 30);
    assert.throws(() => resolveCellRect(model, 'hidden'));
  });
});

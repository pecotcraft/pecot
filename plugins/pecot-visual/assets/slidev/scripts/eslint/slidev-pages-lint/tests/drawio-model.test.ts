import { test, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DrawioGeometryError } from '@v-slidev/eslint-shared';
import { loadModel } from '../lib/utils/drawio-model.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

// 図の解析は _shared の drawio-geometry を使う。テーマの utils を上方に探さないので、テーマの外の dir でも動く。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-model-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const diagram = (width: number): string =>
  '<mxfile><diagram name="p"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  `<mxCell id="a" value="a" style="strokeColor=none;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="${width}" height="50" as="geometry"/></mxCell>` +
  '</root></mxGraphModel></diagram></mxfile>';

test('テーマの外の dir にある図を渡すと、解析した結果を返す', async () => {
  await explains('テーマの外のディレクトリに置いた drawio の図を解析するテストです。その図を `loadModel` へ渡した場合に、図形の外接範囲（`visualBounds`）を解析して返すことを確認します。');
  const file = path.join(dir, 'a.drawio');
  fs.writeFileSync(file, diagram(120));
  assert.deepStrictEqual(loadModel(file).visualBounds, { x: 0, y: 0, width: 120, height: 50 });
});

test('mtime が変わらない図を 2 回読むと、解析結果を使い回す', async () => {
  await explains('図の解析結果のキャッシュのテストです。更新時刻（mtime）が変わらない図を 2 回読み込んだ場合に、解析し直さず同じ結果を再利用することを確認します。');
  const file = path.join(dir, 'cache.drawio');
  fs.writeFileSync(file, diagram(100));
  assert.strictEqual(loadModel(file), loadModel(file));
});

test('mtime が変わった図を読むと、解析し直す', async () => {
  await explains('図を更新したときの、キャッシュの無効化のテストです。更新時刻（mtime）が新しくなった図を読み込んだ場合に、解析し直して更新後の幅を返すことを確認します。');
  const file = path.join(dir, 'changed.drawio');
  fs.writeFileSync(file, diagram(100));
  const before = loadModel(file);
  fs.writeFileSync(file, diagram(200));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  const reloaded = loadModel(file);
  assert.notStrictEqual(reloaded, before);
  assert.strictEqual(reloaded.visualBounds?.width, 200);
});

test('圧縮形式の図を読むと、DrawioGeometryError（compressed）を投げる', async () => {
  await explains('圧縮形式の drawio の図を読み込むテストです。圧縮された図を `loadModel` へ渡した場合に、コードが `compressed` の `DrawioGeometryError` が発生することを確認します。');
  const file = path.join(dir, 'compressed.drawio');
  fs.writeFileSync(file, '<mxfile><diagram name="p">AAAA</diagram></mxfile>');
  assert.throws(
    () => loadModel(file),
    (error: unknown) => error instanceof DrawioGeometryError && error.code === 'compressed',
  );
});

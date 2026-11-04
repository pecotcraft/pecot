import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DrawioGeometryError } from '@v-slidev/eslint-shared';
import { loadModel } from '../lib/utils/drawio-model.ts';

// 図の解析は _shared の drawio-geometry を使う。テーマの utils を上方に探さないので、テーマの外の dir でも動く。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-model-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const diagram = (width: number): string =>
  '<mxfile><diagram name="p"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  `<mxCell id="a" value="a" style="strokeColor=none;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="${width}" height="50" as="geometry"/></mxCell>` +
  '</root></mxGraphModel></diagram></mxfile>';

test('loadModel: テーマの外の dir にある図を解析する', () => {
  const file = path.join(dir, 'a.drawio');
  fs.writeFileSync(file, diagram(120));
  assert.deepStrictEqual(loadModel(file).visualBounds, { x: 0, y: 0, width: 120, height: 50 });
});

test('loadModel: mtime が変わらない図の解析を使い回す', () => {
  const file = path.join(dir, 'cache.drawio');
  fs.writeFileSync(file, diagram(100));
  assert.strictEqual(loadModel(file), loadModel(file));
});

test('loadModel: mtime が変わったら解析し直す', () => {
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

test('loadModel: 圧縮形式の図は DrawioGeometryError（compressed）を投げる', () => {
  const file = path.join(dir, 'compressed.drawio');
  fs.writeFileSync(file, '<mxfile><diagram name="p">AAAA</diagram></mxfile>');
  assert.throws(
    () => loadModel(file),
    (error: unknown) => error instanceof DrawioGeometryError && error.code === 'compressed',
  );
});

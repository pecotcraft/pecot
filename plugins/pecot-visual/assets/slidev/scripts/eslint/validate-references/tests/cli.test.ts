import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 自己実行の判定は argv[1] の実体とモジュールの URL を比べる。ソースをそのまま起動して確かめる。
const ENTRY = join(import.meta.dirname, '../index.ts');
const REFS_DIR = join(import.meta.dirname, '../../_shared/tests/fixtures/deck/pages/_references');

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', ENTRY, ...args], {
    encoding: 'utf-8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('validate-references の起動', () => {
  it('--dir が無ければ usage を出して exit 1 で終わる', () => {
    const result = run([]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: validate-references --dir/);
    assert.equal(result.stdout, '');
  });

  it('--dir に値が無くても usage を出して exit 1 で終わる', () => {
    const result = run(['--dir']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: validate-references --dir/);
  });

  it('--dir に fixture deck の references を渡すと、違反 0 件の exit 0 になる', () => {
    const result = run(['--dir', REFS_DIR]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /0 error\(s\) found\./);
  });
});

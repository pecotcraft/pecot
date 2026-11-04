/**
 * scripts/design-lint/lint-design.mjs（公式 linter のラッパー）を子プロセスで実行し、終了コードを見る。
 * 公式 CLI は warning だけでは exit 0 になる。
 * そのためこのラッパーが、warning でも exit 1 にすることを退行から守る。
 * フィクスチャは tests/fixtures/DESIGN.md のコピーを 1 箇所だけ壊したもので、一時ディレクトリに置く。
 */

import { after, before, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SLIDEV_ROOT = new URL('../../../', import.meta.url);
/** 退行テストで壊す元にする、汎用の最小の DESIGN.md（lint が通る） */
const DESIGN_MD = new URL('fixtures/DESIGN.md', import.meta.url);

const SCRIPT = fileURLToPath(new URL('scripts/design-lint/lint-design.mjs', SLIDEV_ROOT));

/** 引数なしの既定対象: v-drawio の references 配下を再帰列挙した DESIGN.md（assets/slidev からの相対パス） */
function defaultTargets(): string[] {
  const root = fileURLToPath(SLIDEV_ROOT);
  const references = fileURLToPath(new URL('../../skills/v-drawio/references/', SLIDEV_ROOT));
  return readdirSync(references, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === 'DESIGN.md')
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'));
}

/** 配布する定義の既知の 6 パス。走査と同じ実装に頼らず、走査側の取りこぼしを検出する */
const KNOWN_TARGETS = [
  '../../skills/v-drawio/references/architecture/aws/DESIGN.md',
  '../../skills/v-drawio/references/architecture/azure/DESIGN.md',
  '../../skills/v-drawio/references/infographic/en/DESIGN.md',
  '../../skills/v-drawio/references/infographic/ja/DESIGN.md',
  '../../skills/v-drawio/references/poster/general/DESIGN.md',
  '../../skills/v-drawio/references/poster/swimlane-flow/DESIGN.md',
];

function runLint(...files: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...files], { cwd: fileURLToPath(SLIDEV_ROOT), encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout };
}

/** 文字列を 1 箇所だけ置き換える。見つからなければ例外にする。置換されないままのフィクスチャを防ぐため */
function replaceOnce(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `フィクスチャの置換元がありません: ${from}`);
  return text.replace(from, to);
}

describe('lint-design.mjs', () => {
  const original = readFileSync(DESIGN_MD, 'utf-8');
  let dir = '';
  const fixture = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'lint-design-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('引数なしでは v-drawio の references 配下の DESIGN.md をすべて確認し、どれも [OK] で exit 0', () => {
    const targets = defaultTargets();
    assert.ok(targets.length > 1, `v-drawio の DESIGN.md が見つかりません: ${targets.join(', ')}`);
    const r = runLint();
    assert.equal(r.status, 0, r.stdout);
    const okLines = r.stdout.split('\n').filter((line) => /^\[OK\] .*errors 0 \/ warnings 0/.test(line));
    assert.equal(okLines.length, targets.length, r.stdout);
    for (const target of KNOWN_TARGETS) assert.ok(okLines.some((line) => line.startsWith(`[OK] ${target}: `)), `${target}\n${r.stdout}`);
    for (const target of targets) assert.ok(okLines.some((line) => line.startsWith(`[OK] ${target}: `)), `${target}\n${r.stdout}`);
  });

  it('warning だけの定義でも exit 1 にする', () => {
    // どのコンポーネントも参照しない色を 1 つ足す（orphaned-tokens の warning 1 件）
    const path = fixture('warning.md', replaceOnce(original, 'colors:\n', 'colors:\n  ghost: "#123456"\n'));
    const r = runLint(path);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /errors 0 \/ warnings 1 /);
    assert.match(r.stdout, /warning orphaned-tokens colors\.ghost/);
  });

  it('error のある定義は exit 1 にする', () => {
    const path = fixture('error.md', replaceOnce(original, 'textColor: "{colors.text-primary}"', 'textColor: "{colors.missing}"'));
    const r = runLint(path);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /error broken-ref components\.title:/);
  });

  it('本文の参照が front matter に解決しない定義は、公式 linter が通っても exit 1 にして未解決の参照を出す', () => {
    const path = fixture('body-ref.md', replaceOnce(original, '一色のインクと一点の差し色で組む。', '一色のインク `{colors.missing-ref}` と一点の差し色で組む。'));
    const r = runLint(path);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^\[OK\] /m);
    assert.match(r.stdout, /\[NG\] .*: 未解決の参照 1 件/);
    assert.ok(r.stdout.includes('{colors.missing-ref}'), r.stdout);
  });

  it('読めないファイルは [NG] と「読めません」を出して exit 1 にし、残りのファイルも確認する', () => {
    const missing = join(dir, 'missing.md');
    const r = runLint(missing, fileURLToPath(DESIGN_MD));
    assert.equal(r.status, 1, r.stdout);
    assert.ok(r.stdout.includes(`[NG] ${missing}: 読めません`), r.stdout);
    assert.match(r.stdout, /^\[OK\] /m);
  });
});

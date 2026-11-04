/**
 * 体裁の定義（DESIGN.md）を Google DESIGN.md 仕様の公式 linter（@google/design.md）に掛ける。
 * error か warning が 1 件でもあれば exit 1 にする。
 * 公式 CLI は warning だけでは exit 0 を返すため、programmatic API（`lint`）の結果を見て判定する。
 *
 * 使い方:
 *   node scripts/design-lint/lint-design.mjs [<DESIGN.md のパス>...]
 *   相対パスは assets/slidev から解決する。絶対パスも受ける（テーマのリポジトリが自身の DESIGN.md を渡す）。
 *   パスを省くと、../../skills/v-drawio/references/ 配下を再帰走査した DESIGN.md を確認する
 *   （表示は assets/slidev からの相対パス）。パスでソートする。新しいスタイルも自動で対象になる。
 *   走査で 1 本も見つからなければ exit 1 にする。
 *   走査の起点が失われたとき、何も報告せずに通すことはしない。
 *   走査が数えるのは通常ファイルの DESIGN.md だけで、シンボリックリンクの DESIGN.md は対象にしない（仕様）。
 *
 * 公式 linter は components の参照しか解決しない。
 * そこで linter の後に、ファイル全体（front matter と本文、`$extensions` 配下を含む）の参照を解決する。
 * 対象は `{colors|typography|spacing|rounded|components.…}` の形の参照で、front matter の YAML で解決する。
 * 未解決があれば [NG] にして exit 1 にする。
 * 説明用の伏せ字 `{colors.x}`（末尾が 1 文字のキー）は解決対象から外す。
 * バッククォート内の参照には、実在のキーを指すものが多い。
 * 囲みで一律に除外すると確認が空になるため、囲みでなく伏せ字の形で除く。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lint } from '@google/design.md/linter';
import { parse as parseYaml } from 'yaml';

const SLIDEV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DRAWIO_REFERENCES = '../../skills/v-drawio/references';

/** v-drawio の references 配下の DESIGN.md を assets/slidev からの相対パスで列挙する。起点が読めなければ空 */
function drawioDesignFiles() {
  let entries;
  try {
    entries = readdirSync(resolve(SLIDEV_ROOT, DRAWIO_REFERENCES), { recursive: true, withFileTypes: true });
  } catch (e) {
    console.log(`[NG] ${DRAWIO_REFERENCES}: 走査できません (${e.code ?? e.name})`);
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name === 'DESIGN.md')
    .map((e) => relative(SLIDEV_ROOT, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

const REF_PATTERN = /\{((?:colors|typography|spacing|rounded|components)\.[\w.$-]+)\}/g;

/** 先頭の `---` 行から次の `---` 行までを YAML として読む。無ければ null */
function readFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''));
  if (!m) return null;
  try {
    return parseYaml(m[1]);
  } catch {
    return null;
  }
}

/** ファイル全体の `{…}` 参照のうち、front matter で解決できないものを返す（伏せ字 `x` は除く） */
function unresolvedRefs(text) {
  const tree = readFrontMatter(text);
  if (tree === null || typeof tree !== 'object') return [];
  const bad = [];
  for (const m of text.matchAll(REF_PATTERN)) {
    const segments = m[1].split('.');
    if (segments.at(-1).length === 1) continue;
    let cur = tree;
    for (const seg of segments) {
      cur = cur !== null && typeof cur === 'object' ? cur[seg] : undefined;
      if (cur === undefined) break;
    }
    if (cur === undefined) bad.push(m[0]);
  }
  return [...new Set(bad)];
}

function defaultFiles() {
  const drawio = drawioDesignFiles();
  if (drawio.length === 0) {
    console.log(`[NG] ${DRAWIO_REFERENCES}: DESIGN.md が見つかりません`);
    return null;
  }
  return drawio;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : defaultFiles();
if (files === null) process.exit(1);
let failed = false;

for (const file of files) {
  let text;
  try {
    text = readFileSync(resolve(SLIDEV_ROOT, file), 'utf-8');
  } catch {
    console.log(`[NG] ${file}: 読めません`);
    failed = true;
    continue;
  }
  const { findings, summary } = lint(text);
  const problems = findings.filter((f) => f.severity === 'error' || f.severity === 'warning');
  const status = problems.length === 0 ? 'OK' : 'NG';
  console.log(`[${status}] ${file}: errors ${summary.errors} / warnings ${summary.warnings} / infos ${summary.infos}`);
  for (const f of problems) console.log(`  ${f.severity} ${f.rule ?? '-'} ${f.path ?? '-'}: ${f.message}`);
  if (problems.length > 0) failed = true;
  const unresolved = unresolvedRefs(text);
  if (unresolved.length > 0) {
    console.log(`[NG] ${file}: 未解決の参照 ${unresolved.length} 件`);
    for (const ref of unresolved) console.log(`  ${ref}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);

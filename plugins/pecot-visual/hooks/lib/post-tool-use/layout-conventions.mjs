#!/usr/bin/env node
// layout-conventions.sh のヘルパー。
// 編集された MD の layout に対応する参照 YAML から、
// status / best_practices / anti_patterns の原文行を抜き出して stdout に出す。
//
// frontmatter と YAML の解釈は、lint 側の実装に委ねる。
// 使う関数: _shared/dist の extractFrontmatterText / parseFrontmatter / loadLayoutReference。
// ここで再実装すると、提示内容と lint の適用対象が食い違う。
//
// argv: <_shared/dist/index.js> <編集された MD の絶対パス> <参照 YAML の dir>...
// 参照 YAML の dir は先頭が優先（talk-dir の references/ が先、次にテーマの references/）。
// stdout: 提示本文（出典パス 1 行 + YAML の原文抜粋）。それ以外は出さない。
//
// exit:
//   0  提示本文を出力した。
//   10 frontmatter か layout が無い。
//   11 layout の値が、参照 YAML のファイル名として不正。
//   12 対応する参照 YAML が存在しない。
//   13 status / best_practices / anti_patterns のいずれも無い。
//   14 参照 YAML は存在するが読めない（パース不能・読み取り不可）。
//   1  実行エラー（stderr に node の例外）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 抜粋対象のトップレベルキー。出力順は原文の出現順に従う（本配列の順ではない）。
const SECTION_KEYS = ['status', 'best_practices', 'anti_patterns'];

const [distIndex, mdPath, ...refDirs] = process.argv.slice(2);
const { extractFrontmatterText, parseFrontmatter, loadLayoutReference } = await import(
  pathToFileURL(distIndex).href
);

const source = fs.readFileSync(mdPath, 'utf-8');
if (extractFrontmatterText(source) === null) {
  process.exit(10);
}
const layout = parseFrontmatter(source)?.layout;
if (typeof layout !== 'string' || layout === '') {
  process.exit(10);
}
// パストラバーサル（`../`）を弾く。
// 内部ファイル（`_template` 等）も弾く。これらは layout として指定されない。
// どちらも、参照 YAML のファイル名として使う前に弾く。
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(layout)) {
  process.exit(11);
}

// 不在と「あるが読めない」を分ける。前者は layout 名の綴り違いや未 sync の talk-dir、
// 後者は YAML の破損で、hook の trace から見分けられるようにする。
const yamlPath = refDirs
  .map((directory) => path.join(directory, `${layout}.yaml`))
  .find((candidate) => fs.existsSync(candidate));
if (yamlPath === undefined) {
  process.exit(12);
}
const reference = loadLayoutReference(refDirs, layout);
if (reference === null) {
  process.exit(14);
}

// 原文の行をそのまま出す（js-yaml で dump し直すと引用符や折り返しが原本と変わる）。
// トップレベルキーの行から、次のトップレベル要素（行頭が非空白）の直前までを 1 ブロックとする。
const lines = fs.readFileSync(yamlPath, 'utf-8').split('\n');
const blockAt = (start) => {
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) {
    end += 1;
  }
  const picked = lines.slice(start, end);
  while (picked.length > 0 && picked[picked.length - 1].trim() === '') {
    picked.pop();
  }
  return picked.join('\n');
};

const sections = SECTION_KEYS.filter((key) => reference[key] !== undefined)
  .map((key) => ({ key, start: lines.findIndex((line) => line.startsWith(`${key}:`)) }))
  .filter(({ start }) => start !== -1)
  .sort((a, b) => a.start - b.start)
  .map(({ start }) => blockAt(start));
if (sections.length === 0) {
  process.exit(13);
}

process.stdout.write(`${yamlPath}:\n\n${sections.join('\n\n')}\n`);

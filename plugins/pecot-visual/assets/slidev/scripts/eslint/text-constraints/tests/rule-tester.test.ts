// max-chars / textlint を実 ESLint（RuleTester）で通すテスト。
// mock context では、ESLint が渡す sourceCode / filename の形と markdown の root ノードの位置を通らない。
// そのため `language: 'markdown/commonmark'` で実際に起動して、報告の messageId と行を固定する。
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuleTester } from 'eslint';
import markdown from '@eslint/markdown';
import maxChars from '../lib/rules/max-chars.ts';
import textlint from '../lib/rules/textlint.ts';
import { redundantExpression } from './redundant-expression.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const templateRoot = path.resolve(import.meta.dirname, '../../_shared/tests/fixtures/deck');

// 規則が `pages/_references` を実ファイルで探す。
// そのため、fixture deck の references を写した talk-dir を同期で組む。
// （RuleTester の case は定義時に filename が要る）。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-constraints-rt-'));
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
fs.cpSync(path.join(templateRoot, 'pages', '_references'), path.join(root, 'pages', '_references'), {
  recursive: true,
});
const filename = path.join(root, 'pages', 'cover.md');

const REDUNDANT = await redundantExpression();

const ruleTester = new RuleTester({
  plugins: { markdown },
  language: 'markdown/commonmark',
  settings: { 'slidev-theme': { referencesDirectories: [path.join(root, 'pages', '_references')] } },
});

const cover = (coverTitle1: string, coverTitle2: string): string =>
  [
    '---',
    'layout: cover',
    "title: 'Sample'",
    `coverTitle1: '${coverTitle1}'`,
    `coverTitle2: '${coverTitle2}'`,
    "eyebrow: 'LAYOUT CATALOG BY CATEGORY'",
    "date: 'OCTOBER 2026'",
    '---',
    '',
  ].join('\n');

ruleTester.run('max-chars', maxChars, {
  valid: [{ code: cover('SampleDeck', 'レイアウトカタログ'), filename }],
  invalid: [
    // 値が null の項目は空として報告する
    {
      code: cover('', 'レイアウトカタログ').replace("coverTitle1: ''", 'coverTitle1:'),
      filename,
      errors: [{ messageId: 'emptyText', line: 1 }],
    },
    {
      code: cover('これは十八文字を大きく超える長い表題の文字列です', 'レイアウトカタログ'),
      filename,
      errors: [{ messageId: 'maxChars', line: 1 }],
    },
  ],
});

ruleTester.run('textlint', textlint, {
  valid: [
    { code: cover('SampleDeck', 'レイアウトカタログ'), filename },
    // HTML タグを除くと空になる項目は max-chars の担当なので、textlint は対象にしない
    { code: cover('SampleDeck', '<br>'), filename },
  ],
  invalid: [
    {
      code: cover('SampleDeck', REDUNDANT + '。'),
      filename,
      errors: [
        { messageId: 'textlint', line: 1 },
        { messageId: 'textlint', line: 1 },
      ],
    },
  ],
});

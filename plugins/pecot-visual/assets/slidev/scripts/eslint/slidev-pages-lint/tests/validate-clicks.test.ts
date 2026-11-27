import { afterAll, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { RuleTester } from 'eslint';
import markdown from '@eslint/markdown';
import { extractFrontmatterText, parseFrontmatter, getClicksValidation } from '@v-slidev/eslint-shared';
import {
  calculateExpectedClicks,
  validateClicks,
  validateClicksCount,
  validateClicksRequired,
} from '../lib/utils/clicks-validator.ts';
import validateClicksRule from '../lib/rules/validate-clicks.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

test('frontmatter があるテキストを渡すと、その本文を取り出す', async () => {
  await explains('`extractFrontmatterText` のテストです。frontmatter を持つテキストの場合に、前後の `---` を除いた frontmatter の本文を取り出すことを確認します。');
  const text = '---\nlayout: agenda\nclicks: 2\n---\n';
  const result = extractFrontmatterText(text);
  assert.strictEqual(result, 'layout: agenda\nclicks: 2');
});

test('frontmatter が無いテキストを渡すと、本文を取り出せず null を返す', async () => {
  await explains('`extractFrontmatterText` のテストです。frontmatter を持たないテキストの場合に、`null` を返すことを確認します。');
  assert.strictEqual(extractFrontmatterText('# Title\nContent'), null);
});

test('空文字列を渡すと、本文を取り出せず null を返す', async () => {
  await explains('`extractFrontmatterText` のテストです。空の文字列を渡した場合に、`null` を返すことを確認します。');
  assert.strictEqual(extractFrontmatterText(''), null);
});

test('閉じの --- が無いテキストを渡すと、本文を取り出せず null を返す', async () => {
  await explains('`extractFrontmatterText` のテストです。終端の `---` が存在しないテキストの場合に、`null` を返すことを確認します。');
  assert.strictEqual(extractFrontmatterText('---\nlayout: default\n'), null);
});

test('layout と clicks を含む frontmatter を渡すと、両方をパースする', async () => {
  await explains('`parseFrontmatter` のテストです。`layout` と `clicks` を含む frontmatter の場合に、両方の値を解析して取得することを確認します。');
  const text = '---\nlayout: agenda\nclicks: 2\n---\n';
  const fm = parseFrontmatter(text) as { layout: string; clicks: number };
  assert.strictEqual(fm.layout, 'agenda');
  assert.strictEqual(fm.clicks, 2);
});

test('items 配列を含む frontmatter を渡すと、配列をパースする', async () => {
  await explains('`parseFrontmatter` のテストです。`items` の配列を含む frontmatter の場合に、配列の要素数と各要素の値を解析して取得することを確認します。');
  const text = `---
layout: agenda
clicks: 2
titleContent:
  type: heading
  title: "AGENDA"
items:
  - section: "プロジェクト概要"
    time: "10 min"
    description: "背景と目的"
  - section: "技術"
    time: "15 min"
    description: "システム構成"
---
`;
  const fm = parseFrontmatter(text) as {
    layout: string;
    clicks: number;
    items: Array<{ section: string }>;
  };
  assert.strictEqual(fm.layout, 'agenda');
  assert.strictEqual(fm.items.length, 2);
  assert.strictEqual(fm.clicks, 2);
  assert.strictEqual(fm.items[0].section, 'プロジェクト概要');
});

test('frontmatter が無いテキストを渡すと、パース結果は null になる', async () => {
  await explains('`parseFrontmatter` のテストです。frontmatter を持たないテキストの場合に、`null` を返すことを確認します。');
  assert.strictEqual(parseFrontmatter('# Title\nContent'), null);
});

test('空文字列を渡すと、パース結果は null になる', async () => {
  await explains('`parseFrontmatter` のテストです。空の文字列を渡した場合に、`null` を返すことを確認します。');
  assert.strictEqual(parseFrontmatter(''), null);
});

test('空の frontmatter を渡すと、パース結果は null になる', async () => {
  await explains('`parseFrontmatter` のテストです。内容を持たない frontmatter の場合に、`null` を返すことを確認します。');
  assert.strictEqual(parseFrontmatter('---\n---\n'), null);
});

test('項目が 0 件だと、期待する clicks は 0 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 0 件の場合に、期待する clicks が 0 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(0, 6), 0);
});

test('項目が 3 件だと、期待する clicks は 0 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 3 件の場合に、期待する clicks が 0 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(3, 6), 0);
});

test('項目が 6 件だと、期待する clicks は 0 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 6 件の場合に、期待する clicks が 0 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(6, 6), 0);
});

test('項目が 7 件だと、期待する clicks は 1 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 7 件の場合に、期待する clicks が 1 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(7, 6), 1);
});

test('項目が 12 件だと、期待する clicks は 1 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 12 件の場合に、期待する clicks が 1 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(12, 6), 1);
});

test('項目が 13 件だと、期待する clicks は 2 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 13 件の場合に、期待する clicks が 2 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(13, 6), 2);
});

test('項目が 16 件だと、期待する clicks は 2 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 16 件の場合に、期待する clicks が 2 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(16, 6), 2);
});

test('項目が 18 件だと、期待する clicks は 2 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 18 件の場合に、期待する clicks が 2 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(18, 6), 2);
});

test('項目が 19 件だと、期待する clicks は 3 になる', async () => {
  await explains('項目数から期待する clicks を求める `calculateExpectedClicks` のテストです。1 ページあたり 6 件で項目が 19 件の場合に、期待する clicks が 3 になることを確認します。');
  assert.strictEqual(calculateExpectedClicks(19, 6), 3);
});

test('items が 3 件で clicks が未設定だと、OK を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。1 ページに収まる 3 件の場合に、clicks が未設定でも妥当と判定することを確認します。');
  const result = validateClicks({
    actualClicks: undefined, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 6 件で clicks が未設定だと、OK を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。1 ページにちょうど収まる 6 件の場合に、clicks が未設定でも妥当と判定することを確認します。');
  const result = validateClicks({
    actualClicks: undefined, itemCount: 6, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 3 件で clicks が 0 だと、OK を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。1 ページに収まる 3 件で clicks が 0 の場合に、妥当と判定することを確認します。');
  const result = validateClicks({
    actualClicks: 0, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 3 件で clicks が 1 だと、unnecessaryClicks を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。1 ページに収まる 3 件で clicks が 1 の場合に、不要な clicks として `unnecessaryClicks` を返し、実際の値を含めることを確認します。');
  const result = validateClicks({
    actualClicks: 1, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'unnecessaryClicks');
  assert.strictEqual(result.data.actual, 1);
});

test('items が 16 件で clicks が未設定だと、missingClicks を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。3 ページに分かれる 16 件で clicks が未設定の場合に、`missingClicks` を返し、期待値の 2 を含めることを確認します。');
  const result = validateClicks({
    actualClicks: undefined, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicks');
  assert.strictEqual(result.data.expected, 2);
});

test('items が 16 件で clicks が 2 だと、OK を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。16 件で clicks が期待値の 2 と一致する場合に、妥当と判定することを確認します。');
  const result = validateClicks({
    actualClicks: 2, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 16 件で clicks が 1 だと、incorrectClicks を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。16 件で clicks が期待値より少ない 1 の場合に、`incorrectClicks` を返し、期待値と実際の値を含めることを確認します。');
  const result = validateClicks({
    actualClicks: 1, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicks');
  assert.strictEqual(result.data.expected, 2);
  assert.strictEqual(result.data.actual, 1);
});

test('items が 16 件で clicks が 3 だと、incorrectClicks を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。16 件で clicks が期待値より多い 3 の場合に、`incorrectClicks` を返し、期待値と実際の値を含めることを確認します。');
  const result = validateClicks({
    actualClicks: 3, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicks');
  assert.strictEqual(result.data.expected, 2);
  assert.strictEqual(result.data.actual, 3);
});

test('items が 7 件で clicks が 1 だと、OK を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。2 ページに分かれる最小の 7 件で clicks が 1 の場合に、妥当と判定することを確認します。');
  const result = validateClicks({
    actualClicks: 1, itemCount: 7, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 12 件で clicks が 1 だと、OK を返す', async () => {
  await explains('ページ分割の clicks を検証する `validateClicks` のテストです。2 ページにちょうど収まる 12 件で clicks が 1 の場合に、妥当と判定することを確認します。');
  const result = validateClicks({
    actualClicks: 1, itemCount: 12, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('cards が 3 件で clicks が 3 だと、OK を返す', async () => {
  await explains('項目数と clicks を一致させる `validateClicksCount` のテストです。cards が 3 件で clicks も 3 の場合に、妥当と判定することを確認します。');
  const result = validateClicksCount({
    actualClicks: 3, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, true);
});

test('cards が 1 件で clicks が 1 だと、OK を返す', async () => {
  await explains('項目数と clicks を一致させる `validateClicksCount` のテストです。cards が 1 件で clicks も 1 の場合に、妥当と判定することを確認します。');
  const result = validateClicksCount({
    actualClicks: 1, itemCount: 1, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, true);
});

test('cards が 3 件で clicks が未設定だと、missingClicksCount を返す', async () => {
  await explains('項目数と clicks を一致させる `validateClicksCount` のテストです。cards が 3 件で clicks が未設定の場合に、`missingClicksCount` を返し、期待値の 3 を含めることを確認します。');
  const result = validateClicksCount({
    actualClicks: undefined, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicksCount');
  assert.strictEqual(result.data.expected, 3);
});

test('cards が 3 件で clicks が 2 だと、incorrectClicksCount を返す', async () => {
  await explains('項目数と clicks を一致させる `validateClicksCount` のテストです。cards が 3 件で clicks が 2 の場合に、`incorrectClicksCount` を返し、期待値と実際の値を含めることを確認します。');
  const result = validateClicksCount({
    actualClicks: 2, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicksCount');
  assert.strictEqual(result.data.expected, 3);
  assert.strictEqual(result.data.actual, 2);
});

test('cards が 3 件で clicks が 4 だと、incorrectClicksCount を返す', async () => {
  await explains('項目数と clicks を一致させる `validateClicksCount` のテストです。cards が 3 件で clicks が 4 の場合に、`incorrectClicksCount` を返し、期待値と実際の値を含めることを確認します。');
  const result = validateClicksCount({
    actualClicks: 4, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicksCount');
  assert.strictEqual(result.data.expected, 3);
  assert.strictEqual(result.data.actual, 4);
});

test('正しい validation 設定を渡すと、設定を返す', async () => {
  await explains('`getClicksValidation` のテストです。ページ分割（`pagination`）の検証設定を持つ reference の場合に、種類・`source_prop`・`per_page` を設定として返すことを確認します。');
  const reference = {
    clicks: {
      supported: true,
      validation: {
        type: 'pagination',
        source_prop: 'items',
        per_page: 6,
        formula: 'ceil(count / per_page) - 1',
      },
    },
  };
  const result = getClicksValidation(reference);
  assert.strictEqual(result?.type, 'pagination');
  assert.strictEqual(result?.source_prop, 'items');
  assert.strictEqual(result?.per_page, 6);
});

test('clicks.validation が無いと、null を返す', async () => {
  await explains('`getClicksValidation` のテストです。reference の `clicks` が `validation` を持たない場合に、`null` を返すことを確認します。');
  assert.strictEqual(getClicksValidation({ clicks: { supported: true } }), null);
});

test('clicks が無いと、null を返す', async () => {
  await explains('`getClicksValidation` のテストです。reference が `clicks` を持たない場合に、`null` を返すことを確認します。');
  assert.strictEqual(getClicksValidation({}), null);
});

test('必須フィールドが欠けていると、null を返す', async () => {
  await explains('`getClicksValidation` のテストです。`pagination` の検証設定で必須の項目が欠けている場合に、`null` を返すことを確認します。');
  const reference = { clicks: { validation: { type: 'pagination' } } };
  assert.strictEqual(getClicksValidation(reference), null);
});

test('count タイプだと、per_page が無くても設定を返す', async () => {
  await explains('`getClicksValidation` のテストです。種類が `count` の検証設定の場合に、`per_page` が存在しなくても設定を返すことを確認します。');
  const reference = {
    clicks: {
      supported: true,
      validation: { type: 'count', source_prop: 'cards' },
    },
  };
  const result = getClicksValidation(reference);
  assert.strictEqual(result?.type, 'count');
  assert.strictEqual(result?.source_prop, 'cards');
});

test('count タイプで source_prop が欠けていると、null を返す', async () => {
  await explains('`getClicksValidation` のテストです。種類が `count` の検証設定で `source_prop` が欠けている場合に、`null` を返すことを確認します。');
  const reference = { clicks: { validation: { type: 'count' } } };
  assert.strictEqual(getClicksValidation(reference), null);
});

test('clicks が 1 だと、OK を返す', async () => {
  await explains('最小の clicks を求める `validateClicksRequired` のテストです。最小値を指定せず clicks が 1 の場合に、妥当と判定することを確認します。');
  const result = validateClicksRequired({
    actualClicks: 1, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, true);
});

test('clicks が 3 だと、OK を返す', async () => {
  await explains('最小の clicks を求める `validateClicksRequired` のテストです。最小値を指定せず clicks が 3 の場合に、妥当と判定することを確認します。');
  const result = validateClicksRequired({
    actualClicks: 3, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, true);
});

test('clicks が未設定だと、missingClicksRequired を返す', async () => {
  await explains('最小の clicks を求める `validateClicksRequired` のテストです。clicks が未設定の場合に、`missingClicksRequired` を返すことを確認します。');
  const result = validateClicksRequired({
    actualClicks: undefined, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicksRequired');
});

test('clicks が 0 だと、insufficientClicks を返す', async () => {
  await explains('最小の clicks を求める `validateClicksRequired` のテストです。clicks が 0 の場合に、`insufficientClicks` を返し、実際の値と既定の最小値 1 を含めることを確認します。');
  const result = validateClicksRequired({
    actualClicks: 0, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'insufficientClicks');
  assert.strictEqual(result.data.actual, 0);
  assert.strictEqual(result.data.minClicks, 1);
});

test('minClicks が 3 で clicks が 2 だと、insufficientClicks を返す', async () => {
  await explains('最小の clicks を求める `validateClicksRequired` のテストです。`minClicks` が 3 で clicks が 2 の場合に、`insufficientClicks` を返し、最小値の 3 を含めることを確認します。');
  const result = validateClicksRequired({
    actualClicks: 2, matchedProps: 'gen-artifact', minClicks: 3,
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'insufficientClicks');
  assert.strictEqual(result.data.minClicks, 3);
});

test('minClicks が 3 で clicks が 3 だと、OK を返す', async () => {
  await explains('最小の clicks を求める `validateClicksRequired` のテストです。`minClicks` が 3 で clicks も 3 の場合に、妥当と判定することを確認します。');
  const result = validateClicksRequired({
    actualClicks: 3, matchedProps: 'gen-artifact', minClicks: 3,
  });
  assert.strictEqual(result.valid, true);
});

test('required タイプだと、source_prop が無くても設定を返す', async () => {
  await explains('`getClicksValidation` のテストです。種類が `required` の検証設定の場合に、`source_prop` が存在しなくても、`min_clicks` を含む設定を返すことを確認します。');
  const reference = {
    clicks: {
      supported: true,
      validation: { type: 'required', min_clicks: 1 },
    },
  };
  const result = getClicksValidation(reference);
  assert.strictEqual(result?.type, 'required');
  assert.strictEqual(result?.min_clicks, 1);
});

test('ルールオブジェクトを読むと、問題の種類・メッセージ・create 関数を持つ', async () => {
  await explains('`validate-clicks` ルールの定義のテストです。ルールオブジェクトが、種類 `problem`、clicks に関するメッセージ、`create` 関数を持つことを確認します。');
  const meta = validateClicksRule.meta as { type: string; messages: Record<string, string> };
  assert.strictEqual(meta.type, 'problem');
  assert.ok(meta.messages.missingClicks);
  assert.ok(meta.messages.incorrectClicks);
  assert.ok(meta.messages.unnecessaryClicks);
  assert.strictEqual(typeof validateClicksRule.create, 'function');
});

// 規則を実 ESLint（RuleTester）で通す。references は layout ごとの yaml を一時ディレクトリに置く。
const referencesDirectory = mkdtempSync(join(tmpdir(), 'clicks-rule-'));
afterAll(() => {
  rmSync(referencesDirectory, { recursive: true, force: true });
});
const references: Record<string, string> = {
  list: 'layout: list\nclicks:\n  supported: true\n  validation:\n    type: pagination\n    source_prop: items\n    per_page: 2\n',
  cards: 'layout: cards\nclicks:\n  supported: true\n  validation:\n    type: count\n    source_prop: cards\n    offset: 1\n',
  'cards-no-offset': 'layout: cards-no-offset\nclicks:\n  validation:\n    type: count\n    source_prop: cards\n',
  scroll:
    'layout: scroll\nclicks:\n  supported: true\n  validation:\n    type: required\n    min_clicks: 2\n    scroll_prop: rows\n',
  plain: 'layout: plain\n',
};
for (const [name, body] of Object.entries(references)) {
  writeFileSync(join(referencesDirectory, `${name}.yaml`), body);
}

const page = (...lines: string[]): string => `${['---', ...lines, '---'].join('\n')}\n`;

const ruleTester = new RuleTester({
  plugins: { markdown },
  language: 'markdown/commonmark',
  settings: { 'slidev-theme': { referencesDirectories: [referencesDirectory] } },
});

ruleTester.run('validate-clicks', validateClicksRule, {
  valid: [
    { name: 'frontmatter が無いと、報告しない', code: '# 本文のみ\n' },
    { name: 'frontmatter に layout が無いと、報告しない', code: page('clicks: 3') },
    {
      name: 'settings の references のディレクトリが空だと、報告しない',
      code: page('layout: list', 'items: [a, b, c]'),
      settings: { 'slidev-theme': { referencesDirectories: [] } },
    },
    { name: 'layout の reference が無いと、報告しない', code: page('layout: unknown', 'clicks: 3') },
    { name: 'reference に clicks の検証が無いと、報告しない', code: page('layout: plain', 'clicks: 3') },
    {
      name: 'pagination で clicks が期待値どおりだと、報告しない',
      code: page('layout: list', 'clicks: 2', 'items: [a, b, c, d, e]'),
    },
    {
      name: 'pagination の source_prop が配列でないと、報告しない',
      code: page('layout: list', 'clicks: 5', 'items: text'),
    },
    {
      name: 'required で scroll_prop が配列でないと、min_clicks だけで判定する',
      code: page('layout: scroll', 'clicks: 2', 'rows: text'),
    },
  ],
  invalid: [
    {
      name: 'pagination で項目がページ数を超えるのに clicks が無いと、missingClicks を期待値つきで報告する',
      code: page('layout: list', 'items: [a, b, c, d, e]'),
      errors: [{ messageId: 'missingClicks', data: { count: 5, sourceProp: 'items', perPage: 2, expected: 2 } }],
    },
    {
      name: 'pagination で clicks が期待値と違うと、incorrectClicks を報告する',
      code: page('layout: list', 'clicks: 1', 'items: [a, b, c, d, e]'),
      errors: [
        {
          messageId: 'incorrectClicks',
          data: { actual: 1, count: 5, sourceProp: 'items', perPage: 2, expected: 2 },
        },
      ],
    },
    {
      name: 'count で clicks が項目数と offset に合わないと、incorrectClicksCount を報告する',
      code: page('layout: cards', 'clicks: 9', 'cards: [a, b]'),
      errors: [
        { messageId: 'incorrectClicksCount', data: { actual: 9, count: 2, sourceProp: 'cards', expected: 3 } },
      ],
    },
    {
      name: 'count で clicks が無いと、missingClicksCount を報告する',
      code: page('layout: cards', 'cards: [a, b]'),
      errors: [{ messageId: 'missingClicksCount', data: { count: 2, sourceProp: 'cards', expected: 3 } }],
    },
    {
      name: 'count で offset が無いと、offset を 0 として数える',
      code: page('layout: cards-no-offset', 'cards: [a, b]'),
      errors: [{ messageId: 'missingClicksCount', data: { count: 2, sourceProp: 'cards', expected: 2 } }],
    },
    {
      name: 'required で clicks が無いと、missingClicksRequired を最小値つきで報告する',
      code: page('layout: scroll'),
      errors: [{ messageId: 'missingClicksRequired', data: { matchedProps: 'scroll', minClicks: 2 } }],
    },
    {
      name: 'required で scroll_prop の配列が min_clicks より長いと、その長さを最小値にする',
      code: page('layout: scroll', 'clicks: 3', 'rows: [a, b, c, d]'),
      errors: [
        { messageId: 'insufficientClicks', data: { actual: 3, matchedProps: 'scroll', minClicks: 4 } },
      ],
    },
    {
      name: 'required で scroll_prop が空の配列だと、min_clicks だけで判定する',
      code: page('layout: scroll', 'clicks: 1', 'rows: []'),
      errors: [
        { messageId: 'insufficientClicks', data: { actual: 1, matchedProps: 'scroll', minClicks: 2 } },
      ],
    },
  ],
});

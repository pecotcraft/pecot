import { test } from 'node:test';
import assert from 'node:assert';
import { extractFrontmatterText, parseFrontmatter, getClicksValidation } from '@v-slidev/eslint-shared';
import {
  calculateExpectedClicks,
  validateClicks,
  validateClicksCount,
  validateClicksRequired,
} from '../lib/utils/clicks-validator.ts';
import validateClicksRule from '../lib/rules/validate-clicks.ts';

test('extractFrontmatterText: 正常なfrontmatter', () => {
  const text = '---\nlayout: agenda\nclicks: 2\n---\n';
  const result = extractFrontmatterText(text);
  assert.strictEqual(result, 'layout: agenda\nclicks: 2');
});

test('extractFrontmatterText: frontmatterなし → null', () => {
  assert.strictEqual(extractFrontmatterText('# Title\nContent'), null);
});

test('extractFrontmatterText: 空文字列 → null', () => {
  assert.strictEqual(extractFrontmatterText(''), null);
});

test('extractFrontmatterText: 閉じ --- なし → null', () => {
  assert.strictEqual(extractFrontmatterText('---\nlayout: default\n'), null);
});

test('parseFrontmatter: layout と clicks をパース', () => {
  const text = '---\nlayout: agenda\nclicks: 2\n---\n';
  const fm = parseFrontmatter(text) as { layout: string; clicks: number };
  assert.strictEqual(fm.layout, 'agenda');
  assert.strictEqual(fm.clicks, 2);
});

test('parseFrontmatter: items配列を正しくパース', () => {
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

test('parseFrontmatter: frontmatterなし → null', () => {
  assert.strictEqual(parseFrontmatter('# Title\nContent'), null);
});

test('parseFrontmatter: 空文字列 → null', () => {
  assert.strictEqual(parseFrontmatter(''), null);
});

test('parseFrontmatter: 空のfrontmatter → null', () => {
  assert.strictEqual(parseFrontmatter('---\n---\n'), null);
});

test('calculateExpectedClicks: 0件 → 0', () => {
  assert.strictEqual(calculateExpectedClicks(0, 6), 0);
});

test('calculateExpectedClicks: 3件 → 0', () => {
  assert.strictEqual(calculateExpectedClicks(3, 6), 0);
});

test('calculateExpectedClicks: 6件 → 0', () => {
  assert.strictEqual(calculateExpectedClicks(6, 6), 0);
});

test('calculateExpectedClicks: 7件 → 1', () => {
  assert.strictEqual(calculateExpectedClicks(7, 6), 1);
});

test('calculateExpectedClicks: 12件 → 1', () => {
  assert.strictEqual(calculateExpectedClicks(12, 6), 1);
});

test('calculateExpectedClicks: 13件 → 2', () => {
  assert.strictEqual(calculateExpectedClicks(13, 6), 2);
});

test('calculateExpectedClicks: 16件 → 2', () => {
  assert.strictEqual(calculateExpectedClicks(16, 6), 2);
});

test('calculateExpectedClicks: 18件 → 2', () => {
  assert.strictEqual(calculateExpectedClicks(18, 6), 2);
});

test('calculateExpectedClicks: 19件 → 3', () => {
  assert.strictEqual(calculateExpectedClicks(19, 6), 3);
});

test('validateClicks: items 3件、clicks未設定 → OK', () => {
  const result = validateClicks({
    actualClicks: undefined, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicks: items 6件、clicks未設定 → OK', () => {
  const result = validateClicks({
    actualClicks: undefined, itemCount: 6, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicks: items 3件、clicks: 0 → OK', () => {
  const result = validateClicks({
    actualClicks: 0, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicks: items 3件、clicks: 1 → unnecessaryClicks', () => {
  const result = validateClicks({
    actualClicks: 1, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'unnecessaryClicks');
  assert.strictEqual(result.data.actual, 1);
});

test('validateClicks: items 16件、clicks未設定 → missingClicks', () => {
  const result = validateClicks({
    actualClicks: undefined, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicks');
  assert.strictEqual(result.data.expected, 2);
});

test('validateClicks: items 16件、clicks: 2 → OK', () => {
  const result = validateClicks({
    actualClicks: 2, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicks: items 16件、clicks: 1 → incorrectClicks', () => {
  const result = validateClicks({
    actualClicks: 1, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicks');
  assert.strictEqual(result.data.expected, 2);
  assert.strictEqual(result.data.actual, 1);
});

test('validateClicks: items 16件、clicks: 3 → incorrectClicks', () => {
  const result = validateClicks({
    actualClicks: 3, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicks');
  assert.strictEqual(result.data.expected, 2);
  assert.strictEqual(result.data.actual, 3);
});

test('validateClicks: items 7件、clicks: 1 → OK', () => {
  const result = validateClicks({
    actualClicks: 1, itemCount: 7, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicks: items 12件、clicks: 1 → OK', () => {
  const result = validateClicks({
    actualClicks: 1, itemCount: 12, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicksCount: cards 3件、clicks: 3 → OK', () => {
  const result = validateClicksCount({
    actualClicks: 3, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicksCount: cards 1件、clicks: 1 → OK', () => {
  const result = validateClicksCount({
    actualClicks: 1, itemCount: 1, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicksCount: cards 3件、clicks未設定 → missingClicksCount', () => {
  const result = validateClicksCount({
    actualClicks: undefined, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicksCount');
  assert.strictEqual(result.data.expected, 3);
});

test('validateClicksCount: cards 3件、clicks: 2 → incorrectClicksCount', () => {
  const result = validateClicksCount({
    actualClicks: 2, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicksCount');
  assert.strictEqual(result.data.expected, 3);
  assert.strictEqual(result.data.actual, 2);
});

test('validateClicksCount: cards 3件、clicks: 4 → incorrectClicksCount', () => {
  const result = validateClicksCount({
    actualClicks: 4, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicksCount');
  assert.strictEqual(result.data.expected, 3);
  assert.strictEqual(result.data.actual, 4);
});

test('getClicksValidation: 正常な validation 設定', () => {
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

test('getClicksValidation: clicks.validation がない → null', () => {
  assert.strictEqual(getClicksValidation({ clicks: { supported: true } }), null);
});

test('getClicksValidation: clicks がない → null', () => {
  assert.strictEqual(getClicksValidation({}), null);
});

test('getClicksValidation: 必須フィールド欠落 → null', () => {
  const reference = { clicks: { validation: { type: 'pagination' } } };
  assert.strictEqual(getClicksValidation(reference), null);
});

test('getClicksValidation: countタイプ（per_page不要）', () => {
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

test('getClicksValidation: countタイプでsource_prop欠落 → null', () => {
  const reference = { clicks: { validation: { type: 'count' } } };
  assert.strictEqual(getClicksValidation(reference), null);
});

test('validateClicksRequired: clicks: 1 → OK', () => {
  const result = validateClicksRequired({
    actualClicks: 1, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicksRequired: clicks: 3 → OK', () => {
  const result = validateClicksRequired({
    actualClicks: 3, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, true);
});

test('validateClicksRequired: clicks未設定 → missingClicksRequired', () => {
  const result = validateClicksRequired({
    actualClicks: undefined, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicksRequired');
});

test('validateClicksRequired: clicks: 0 → insufficientClicks', () => {
  const result = validateClicksRequired({
    actualClicks: 0, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'insufficientClicks');
  assert.strictEqual(result.data.actual, 0);
  assert.strictEqual(result.data.minClicks, 1);
});

test('validateClicksRequired: minClicks: 3、clicks: 2 → insufficientClicks', () => {
  const result = validateClicksRequired({
    actualClicks: 2, matchedProps: 'gen-artifact', minClicks: 3,
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'insufficientClicks');
  assert.strictEqual(result.data.minClicks, 3);
});

test('validateClicksRequired: minClicks: 3、clicks: 3 → OK', () => {
  const result = validateClicksRequired({
    actualClicks: 3, matchedProps: 'gen-artifact', minClicks: 3,
  });
  assert.strictEqual(result.valid, true);
});

test('getClicksValidation: requiredタイプ（source_prop不要）', () => {
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

test('validate-clicks: ルールオブジェクトが正しい構造を持つ', () => {
  const meta = validateClicksRule.meta as { type: string; messages: Record<string, string> };
  assert.strictEqual(meta.type, 'problem');
  assert.ok(meta.messages.missingClicks);
  assert.ok(meta.messages.incorrectClicks);
  assert.ok(meta.messages.unnecessaryClicks);
  assert.strictEqual(typeof validateClicksRule.create, 'function');
});

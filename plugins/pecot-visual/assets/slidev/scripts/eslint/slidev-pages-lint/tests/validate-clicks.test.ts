import { test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { extractFrontmatterText, parseFrontmatter, getClicksValidation } from '@v-slidev/eslint-shared';
import {
  calculateExpectedClicks,
  validateClicks,
  validateClicksCount,
  validateClicksRequired,
} from '../lib/utils/clicks-validator.ts';
import validateClicksRule from '../lib/rules/validate-clicks.ts';

test('frontmatter があるテキストを渡すと、その本文を取り出す', () => {
  const text = '---\nlayout: agenda\nclicks: 2\n---\n';
  const result = extractFrontmatterText(text);
  assert.strictEqual(result, 'layout: agenda\nclicks: 2');
});

test('frontmatter が無いテキストを渡すと、本文を取り出せず null を返す', () => {
  assert.strictEqual(extractFrontmatterText('# Title\nContent'), null);
});

test('空文字列を渡すと、本文を取り出せず null を返す', () => {
  assert.strictEqual(extractFrontmatterText(''), null);
});

test('閉じの --- が無いテキストを渡すと、本文を取り出せず null を返す', () => {
  assert.strictEqual(extractFrontmatterText('---\nlayout: default\n'), null);
});

test('layout と clicks を含む frontmatter を渡すと、両方をパースする', () => {
  const text = '---\nlayout: agenda\nclicks: 2\n---\n';
  const fm = parseFrontmatter(text) as { layout: string; clicks: number };
  assert.strictEqual(fm.layout, 'agenda');
  assert.strictEqual(fm.clicks, 2);
});

test('items 配列を含む frontmatter を渡すと、配列をパースする', () => {
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

test('frontmatter が無いテキストを渡すと、パース結果は null になる', () => {
  assert.strictEqual(parseFrontmatter('# Title\nContent'), null);
});

test('空文字列を渡すと、パース結果は null になる', () => {
  assert.strictEqual(parseFrontmatter(''), null);
});

test('空の frontmatter を渡すと、パース結果は null になる', () => {
  assert.strictEqual(parseFrontmatter('---\n---\n'), null);
});

test('項目が 0 件だと、期待する clicks は 0 になる', () => {
  assert.strictEqual(calculateExpectedClicks(0, 6), 0);
});

test('項目が 3 件だと、期待する clicks は 0 になる', () => {
  assert.strictEqual(calculateExpectedClicks(3, 6), 0);
});

test('項目が 6 件だと、期待する clicks は 0 になる', () => {
  assert.strictEqual(calculateExpectedClicks(6, 6), 0);
});

test('項目が 7 件だと、期待する clicks は 1 になる', () => {
  assert.strictEqual(calculateExpectedClicks(7, 6), 1);
});

test('項目が 12 件だと、期待する clicks は 1 になる', () => {
  assert.strictEqual(calculateExpectedClicks(12, 6), 1);
});

test('項目が 13 件だと、期待する clicks は 2 になる', () => {
  assert.strictEqual(calculateExpectedClicks(13, 6), 2);
});

test('項目が 16 件だと、期待する clicks は 2 になる', () => {
  assert.strictEqual(calculateExpectedClicks(16, 6), 2);
});

test('項目が 18 件だと、期待する clicks は 2 になる', () => {
  assert.strictEqual(calculateExpectedClicks(18, 6), 2);
});

test('項目が 19 件だと、期待する clicks は 3 になる', () => {
  assert.strictEqual(calculateExpectedClicks(19, 6), 3);
});

test('items が 3 件で clicks が未設定だと、OK を返す', () => {
  const result = validateClicks({
    actualClicks: undefined, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 6 件で clicks が未設定だと、OK を返す', () => {
  const result = validateClicks({
    actualClicks: undefined, itemCount: 6, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 3 件で clicks が 0 だと、OK を返す', () => {
  const result = validateClicks({
    actualClicks: 0, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 3 件で clicks が 1 だと、unnecessaryClicks を返す', () => {
  const result = validateClicks({
    actualClicks: 1, itemCount: 3, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'unnecessaryClicks');
  assert.strictEqual(result.data.actual, 1);
});

test('items が 16 件で clicks が未設定だと、missingClicks を返す', () => {
  const result = validateClicks({
    actualClicks: undefined, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicks');
  assert.strictEqual(result.data.expected, 2);
});

test('items が 16 件で clicks が 2 だと、OK を返す', () => {
  const result = validateClicks({
    actualClicks: 2, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 16 件で clicks が 1 だと、incorrectClicks を返す', () => {
  const result = validateClicks({
    actualClicks: 1, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicks');
  assert.strictEqual(result.data.expected, 2);
  assert.strictEqual(result.data.actual, 1);
});

test('items が 16 件で clicks が 3 だと、incorrectClicks を返す', () => {
  const result = validateClicks({
    actualClicks: 3, itemCount: 16, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicks');
  assert.strictEqual(result.data.expected, 2);
  assert.strictEqual(result.data.actual, 3);
});

test('items が 7 件で clicks が 1 だと、OK を返す', () => {
  const result = validateClicks({
    actualClicks: 1, itemCount: 7, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('items が 12 件で clicks が 1 だと、OK を返す', () => {
  const result = validateClicks({
    actualClicks: 1, itemCount: 12, perPage: 6, sourceProp: 'items',
  });
  assert.strictEqual(result.valid, true);
});

test('cards が 3 件で clicks が 3 だと、OK を返す', () => {
  const result = validateClicksCount({
    actualClicks: 3, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, true);
});

test('cards が 1 件で clicks が 1 だと、OK を返す', () => {
  const result = validateClicksCount({
    actualClicks: 1, itemCount: 1, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, true);
});

test('cards が 3 件で clicks が未設定だと、missingClicksCount を返す', () => {
  const result = validateClicksCount({
    actualClicks: undefined, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicksCount');
  assert.strictEqual(result.data.expected, 3);
});

test('cards が 3 件で clicks が 2 だと、incorrectClicksCount を返す', () => {
  const result = validateClicksCount({
    actualClicks: 2, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicksCount');
  assert.strictEqual(result.data.expected, 3);
  assert.strictEqual(result.data.actual, 2);
});

test('cards が 3 件で clicks が 4 だと、incorrectClicksCount を返す', () => {
  const result = validateClicksCount({
    actualClicks: 4, itemCount: 3, sourceProp: 'cards',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'incorrectClicksCount');
  assert.strictEqual(result.data.expected, 3);
  assert.strictEqual(result.data.actual, 4);
});

test('正しい validation 設定を渡すと、設定を返す', () => {
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

test('clicks.validation が無いと、null を返す', () => {
  assert.strictEqual(getClicksValidation({ clicks: { supported: true } }), null);
});

test('clicks が無いと、null を返す', () => {
  assert.strictEqual(getClicksValidation({}), null);
});

test('必須フィールドが欠けていると、null を返す', () => {
  const reference = { clicks: { validation: { type: 'pagination' } } };
  assert.strictEqual(getClicksValidation(reference), null);
});

test('count タイプだと、per_page が無くても設定を返す', () => {
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

test('count タイプで source_prop が欠けていると、null を返す', () => {
  const reference = { clicks: { validation: { type: 'count' } } };
  assert.strictEqual(getClicksValidation(reference), null);
});

test('clicks が 1 だと、OK を返す', () => {
  const result = validateClicksRequired({
    actualClicks: 1, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, true);
});

test('clicks が 3 だと、OK を返す', () => {
  const result = validateClicksRequired({
    actualClicks: 3, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, true);
});

test('clicks が未設定だと、missingClicksRequired を返す', () => {
  const result = validateClicksRequired({
    actualClicks: undefined, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'missingClicksRequired');
});

test('clicks が 0 だと、insufficientClicks を返す', () => {
  const result = validateClicksRequired({
    actualClicks: 0, matchedProps: 'gen-artifact',
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'insufficientClicks');
  assert.strictEqual(result.data.actual, 0);
  assert.strictEqual(result.data.minClicks, 1);
});

test('minClicks が 3 で clicks が 2 だと、insufficientClicks を返す', () => {
  const result = validateClicksRequired({
    actualClicks: 2, matchedProps: 'gen-artifact', minClicks: 3,
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.messageId, 'insufficientClicks');
  assert.strictEqual(result.data.minClicks, 3);
});

test('minClicks が 3 で clicks が 3 だと、OK を返す', () => {
  const result = validateClicksRequired({
    actualClicks: 3, matchedProps: 'gen-artifact', minClicks: 3,
  });
  assert.strictEqual(result.valid, true);
});

test('required タイプだと、source_prop が無くても設定を返す', () => {
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

test('ルールオブジェクトを読むと、問題の種類・メッセージ・create 関数を持つ', () => {
  const meta = validateClicksRule.meta as { type: string; messages: Record<string, string> };
  assert.strictEqual(meta.type, 'problem');
  assert.ok(meta.messages.missingClicks);
  assert.ok(meta.messages.incorrectClicks);
  assert.ok(meta.messages.unnecessaryClicks);
  assert.strictEqual(typeof validateClicksRule.create, 'function');
});

interface RuleReport {
  messageId?: string;
  data?: Record<string, unknown>;
}

// layout 名と reference の yaml 本文から一時ディレクトリを作り、markdown の本文にルールを当てる
function runRule(
  references: Record<string, string>,
  markdown: string,
  options: { settings?: Record<string, unknown>; throwOnGetText?: boolean; visitor?: 'root' | 'Program' } = {},
): RuleReport[] {
  const dir = mkdtempSync(join(tmpdir(), 'clicks-rule-'));
  try {
    for (const [name, body] of Object.entries(references)) {
      writeFileSync(join(dir, `${name}.yaml`), body);
    }
    const reports: RuleReport[] = [];
    const context = {
      settings: options.settings ?? { 'slidev-theme': { referencesDirectories: [dir] } },
      sourceCode: {
        getText: () => {
          if (options.throwOnGetText) throw new Error('no text');
          return markdown;
        },
      },
      report: (descriptor: RuleReport) => reports.push(descriptor),
    };
    const visitors = validateClicksRule.create(context as never) as unknown as Record<
      string,
      (node: unknown) => void
    >;
    visitors[options.visitor ?? 'Program']({});
    return reports;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PAGINATION_YAML =
  'layout: list\nclicks:\n  supported: true\n  validation:\n    type: pagination\n    source_prop: items\n    per_page: 2\n';
const COUNT_YAML =
  'layout: cards\nclicks:\n  supported: true\n  validation:\n    type: count\n    source_prop: cards\n    offset: 1\n';
const REQUIRED_YAML =
  'layout: scroll\nclicks:\n  supported: true\n  validation:\n    type: required\n    min_clicks: 2\n    scroll_prop: rows\n';

test('テキストの取得が失敗すると、報告せずに終える', () => {
  const reports = runRule({}, '', { throwOnGetText: true });
  assert.deepStrictEqual(reports, []);
});

test('frontmatter が無いと、報告しない', () => {
  assert.deepStrictEqual(runRule({ list: PAGINATION_YAML }, '# 本文のみ\n'), []);
});

test('frontmatter に layout が無いと、報告しない', () => {
  assert.deepStrictEqual(runRule({ list: PAGINATION_YAML }, '---\nclicks: 3\n---\n'), []);
});

test('references のディレクトリが settings に無いと、報告しない', () => {
  const reports = runRule({ list: PAGINATION_YAML }, '---\nlayout: list\nitems: [a, b, c]\n---\n', {
    settings: {},
  });
  assert.deepStrictEqual(reports, []);
});

test('layout の reference が無いと、報告しない', () => {
  assert.deepStrictEqual(runRule({}, '---\nlayout: unknown\nclicks: 3\n---\n'), []);
});

test('reference に clicks の検証が無いと、報告しない', () => {
  const reports = runRule({ plain: 'layout: plain\n' }, '---\nlayout: plain\nclicks: 3\n---\n');
  assert.deepStrictEqual(reports, []);
});

test('root のビジターでも、Program と同じ検証をする', () => {
  const reports = runRule({ list: PAGINATION_YAML }, '---\nlayout: list\nitems: [a, b, c]\n---\n', {
    visitor: 'root',
  });
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'missingClicks');
});

test('pagination で項目がページ数を超えるのに clicks が無いと、missingClicks を期待値つきで報告する', () => {
  const reports = runRule({ list: PAGINATION_YAML }, '---\nlayout: list\nitems: [a, b, c, d, e]\n---\n');
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'missingClicks');
  assert.strictEqual(reports[0].data?.expected, 2);
});

test('pagination で clicks が期待値どおりだと、報告しない', () => {
  const reports = runRule(
    { list: PAGINATION_YAML },
    '---\nlayout: list\nclicks: 2\nitems: [a, b, c, d, e]\n---\n',
  );
  assert.deepStrictEqual(reports, []);
});

test('pagination で clicks が期待値と違うと、incorrectClicks を報告する', () => {
  const reports = runRule(
    { list: PAGINATION_YAML },
    '---\nlayout: list\nclicks: 1\nitems: [a, b, c, d, e]\n---\n',
  );
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'incorrectClicks');
});

test('pagination の source_prop が配列でないと、報告しない', () => {
  const reports = runRule({ list: PAGINATION_YAML }, '---\nlayout: list\nclicks: 5\nitems: text\n---\n');
  assert.deepStrictEqual(reports, []);
});

test('count で clicks が項目数と offset に合わないと、incorrectClicksCount を報告する', () => {
  const reports = runRule({ cards: COUNT_YAML }, '---\nlayout: cards\nclicks: 9\ncards: [a, b]\n---\n');
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'incorrectClicksCount');
  assert.strictEqual(reports[0].data?.expected, 3);
});

test('count で clicks が無いと、missingClicksCount を報告する', () => {
  const reports = runRule({ cards: COUNT_YAML }, '---\nlayout: cards\ncards: [a, b]\n---\n');
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'missingClicksCount');
});

test('count で offset が無いと、offset を 0 として数える', () => {
  const yamlNoOffset =
    'layout: cards\nclicks:\n  validation:\n    type: count\n    source_prop: cards\n';
  const reports = runRule({ cards: yamlNoOffset }, '---\nlayout: cards\ncards: [a, b]\n---\n');
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.expected, 2);
});

test('required で clicks が無いと、missingClicksRequired を最小値つきで報告する', () => {
  const reports = runRule({ scroll: REQUIRED_YAML }, '---\nlayout: scroll\n---\n');
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'missingClicksRequired');
  assert.strictEqual(reports[0].data?.minClicks, 2);
});

test('required で scroll_prop の配列が min_clicks より長いと、その長さを最小値にする', () => {
  const reports = runRule(
    { scroll: REQUIRED_YAML },
    '---\nlayout: scroll\nclicks: 3\nrows: [a, b, c, d]\n---\n',
  );
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].messageId, 'insufficientClicks');
  assert.strictEqual(reports[0].data?.minClicks, 4);
});

test('required で scroll_prop が配列でないと、min_clicks だけで判定する', () => {
  const reports = runRule(
    { scroll: REQUIRED_YAML },
    '---\nlayout: scroll\nclicks: 2\nrows: text\n---\n',
  );
  assert.deepStrictEqual(reports, []);
});

test('required で scroll_prop が空の配列だと、min_clicks だけで判定する', () => {
  const reports = runRule(
    { scroll: REQUIRED_YAML },
    '---\nlayout: scroll\nclicks: 1\nrows: []\n---\n',
  );
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.minClicks, 2);
});

test('required で min_clicks が無いと、最小値を 1 にする', () => {
  const yamlNoMin = 'layout: scroll\nclicks:\n  validation:\n    type: required\n';
  const reports = runRule({ scroll: yamlNoMin }, '---\nlayout: scroll\nclicks: 0\n---\n');
  assert.strictEqual(reports.length, 1);
  assert.strictEqual(reports[0].data?.minClicks, 1);
});

test('required で clicks が最小値以上だと、報告しない', () => {
  const reports = runRule({ scroll: REQUIRED_YAML }, '---\nlayout: scroll\nclicks: 2\n---\n');
  assert.deepStrictEqual(reports, []);
});

test('未知の validation の type だと、報告しない', () => {
  const yamlUnknown =
    'layout: odd\nclicks:\n  validation:\n    type: mystery\n    source_prop: items\n';
  const reports = runRule({ odd: yamlUnknown }, '---\nlayout: odd\nitems: [a]\nclicks: 4\n---\n');
  assert.deepStrictEqual(reports, []);
});

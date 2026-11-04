import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFieldPath, resolveFieldValues } from '@v-slidev/eslint-shared';

describe('parseFieldPath', () => {
  it('シンプルなプロパティ', () => {
    const result = parseFieldPath('coverTitle');
    assert.deepStrictEqual(result, [{ type: 'prop', name: 'coverTitle' }]);
  });

  it('ネストしたプロパティ', () => {
    const result = parseFieldPath('titleContent.label');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'titleContent' },
      { type: 'prop', name: 'label' },
    ]);
  });

  it('配列要素のプロパティ', () => {
    const result = parseFieldPath('items[].section');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'items' },
      { type: 'array', name: '' },
      { type: 'prop', name: 'section' },
    ]);
  });

  it('配列直接（文字列配列）', () => {
    const result = parseFieldPath('details[]');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'details' },
      { type: 'array', name: '' },
    ]);
  });

  it('深ネスト＋配列', () => {
    const result = parseFieldPath('leftContent.items[].title');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'leftContent' },
      { type: 'prop', name: 'items' },
      { type: 'array', name: '' },
      { type: 'prop', name: 'title' },
    ]);
  });

  it('空文字列', () => {
    const result = parseFieldPath('');
    assert.deepStrictEqual(result, []);
  });

  it('null入力', () => {
    const result = parseFieldPath(null as unknown as string);
    assert.deepStrictEqual(result, []);
  });
});

describe('resolveFieldValues', () => {
  it('シンプル: coverTitle', () => {
    const fm = { coverTitle: 'Hello' };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: 'Hello', path: 'coverTitle' }]);
  });

  it('ネスト: titleContent.label', () => {
    const fm = { titleContent: { label: 'CONCEPT', title: 'Title' } };
    const result = resolveFieldValues(fm, 'titleContent.label');
    assert.deepStrictEqual(result, [{ value: 'CONCEPT', path: 'titleContent.label' }]);
  });

  it('配列要素: items[].section', () => {
    const fm = {
      items: [
        { section: 'Topic A', time: '10 min' },
        { section: 'Topic B', time: '15 min' },
      ],
    };
    const result = resolveFieldValues(fm, 'items[].section');
    assert.deepStrictEqual(result, [
      { value: 'Topic A', path: 'items[0].section' },
      { value: 'Topic B', path: 'items[1].section' },
    ]);
  });

  it('配列直接: details[] (文字列配列)', () => {
    const fm = {
      descriptionContent: {
        details: ['item1', 'item2', 'item3'],
      },
    };
    const result = resolveFieldValues(fm, 'descriptionContent.details[]');
    assert.deepStrictEqual(result, [
      { value: 'item1', path: 'descriptionContent.details[0]' },
      { value: 'item2', path: 'descriptionContent.details[1]' },
      { value: 'item3', path: 'descriptionContent.details[2]' },
    ]);
  });

  it('深ネスト＋配列: leftContent.items[].title', () => {
    const fm = {
      leftContent: {
        items: [
          { title: 'A', description: 'desc A' },
          { title: 'B', description: 'desc B' },
        ],
      },
    };
    const result = resolveFieldValues(fm, 'leftContent.items[].title');
    assert.deepStrictEqual(result, [
      { value: 'A', path: 'leftContent.items[0].title' },
      { value: 'B', path: 'leftContent.items[1].title' },
    ]);
  });

  it('存在しないプロパティ → 空配列', () => {
    const fm = { coverTitle: 'Hello' };
    const result = resolveFieldValues(fm, 'nonExistent');
    assert.deepStrictEqual(result, []);
  });

  it('ネスト先が存在しない → 空配列', () => {
    const fm = { titleContent: null };
    const result = resolveFieldValues(fm, 'titleContent.label');
    assert.deepStrictEqual(result, []);
  });

  it('配列プロパティが配列でない → 空配列', () => {
    const fm = { items: 'not an array' };
    const result = resolveFieldValues(fm, 'items[].section');
    assert.deepStrictEqual(result, []);
  });

  it('空の配列 → 空配列', () => {
    const fm = { items: [] };
    const result = resolveFieldValues(fm, 'items[].section');
    assert.deepStrictEqual(result, []);
  });

  it('null値のプロパティ → 値としてnullを返す', () => {
    const fm = { coverTitle: null };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: null, path: 'coverTitle' }]);
  });

  it('空文字列のプロパティ → 値として空文字列を返す', () => {
    const fm = { coverTitle: '' };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: '', path: 'coverTitle' }]);
  });
});

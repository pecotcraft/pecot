import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseFieldPath, resolveFieldValues } from '@v-slidev/eslint-shared';

describe('parseFieldPath', () => {
  it('単純なプロパティ名を渡すと、prop 1 件の配列を返す', () => {
    const result = parseFieldPath('coverTitle');
    assert.deepStrictEqual(result, [{ type: 'prop', name: 'coverTitle' }]);
  });

  it('ドットでつないだ名前を渡すと、prop を順に並べた配列を返す', () => {
    const result = parseFieldPath('titleContent.label');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'titleContent' },
      { type: 'prop', name: 'label' },
    ]);
  });

  it('配列の要素のプロパティを渡すと、prop・array・prop の配列を返す', () => {
    const result = parseFieldPath('items[].section');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'items' },
      { type: 'array', name: '' },
      { type: 'prop', name: 'section' },
    ]);
  });

  it('配列そのものを渡すと、prop と array の配列を返す', () => {
    const result = parseFieldPath('details[]');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'details' },
      { type: 'array', name: '' },
    ]);
  });

  it('ネストの途中に配列があると、prop と array を順に並べた配列を返す', () => {
    const result = parseFieldPath('leftContent.items[].title');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'leftContent' },
      { type: 'prop', name: 'items' },
      { type: 'array', name: '' },
      { type: 'prop', name: 'title' },
    ]);
  });

  it('空文字列を渡すと、空の配列を返す', () => {
    const result = parseFieldPath('');
    assert.deepStrictEqual(result, []);
  });

  it('null を渡すと、空の配列を返す', () => {
    const result = parseFieldPath(null as unknown as string);
    assert.deepStrictEqual(result, []);
  });
});

describe('resolveFieldValues', () => {
  it('単純なプロパティを渡すと、その値とパスを返す', () => {
    const fm = { coverTitle: 'Hello' };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: 'Hello', path: 'coverTitle' }]);
  });

  it('ネストしたプロパティを渡すと、その値とパスを返す', () => {
    const fm = { titleContent: { label: 'CONCEPT', title: 'Title' } };
    const result = resolveFieldValues(fm, 'titleContent.label');
    assert.deepStrictEqual(result, [{ value: 'CONCEPT', path: 'titleContent.label' }]);
  });

  it('配列の要素のプロパティを渡すと、要素ごとの値と添字つきのパスを返す', () => {
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

  it('文字列の配列を渡すと、要素ごとの値と添字つきのパスを返す', () => {
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

  it('ネストの途中に配列があると、要素ごとの値と添字つきのパスを返す', () => {
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

  it('存在しないプロパティだと、空の配列を返す', () => {
    const fm = { coverTitle: 'Hello' };
    const result = resolveFieldValues(fm, 'nonExistent');
    assert.deepStrictEqual(result, []);
  });

  it('ネスト先が null だと、空の配列を返す', () => {
    const fm = { titleContent: null };
    const result = resolveFieldValues(fm, 'titleContent.label');
    assert.deepStrictEqual(result, []);
  });

  it('配列のはずのプロパティが配列でないと、空の配列を返す', () => {
    const fm = { items: 'not an array' };
    const result = resolveFieldValues(fm, 'items[].section');
    assert.deepStrictEqual(result, []);
  });

  it('配列が空だと、空の配列を返す', () => {
    const fm = { items: [] };
    const result = resolveFieldValues(fm, 'items[].section');
    assert.deepStrictEqual(result, []);
  });

  it('プロパティの値が null だと、値として null を返す', () => {
    const fm = { coverTitle: null };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: null, path: 'coverTitle' }]);
  });

  it('プロパティの値が空文字列だと、値として空文字列を返す', () => {
    const fm = { coverTitle: '' };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: '', path: 'coverTitle' }]);
  });
});

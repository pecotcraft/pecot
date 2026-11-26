import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseFieldPath, resolveFieldValues } from '@v-slidev/eslint-shared';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

describe('parseFieldPath', () => {
  it('単純なプロパティ名を渡すと、prop 1 件の配列を返す', async () => {
    await explains('`parseFieldPath` が単純なプロパティ名を解析するテストです。区切りのない名前を渡した場合に、`prop` 1 件の配列が返ることを確認します。');
    const result = parseFieldPath('coverTitle');
    assert.deepStrictEqual(result, [{ type: 'prop', name: 'coverTitle' }]);
  });

  it('ドットでつないだ名前を渡すと、prop を順に並べた配列を返す', async () => {
    await explains('`parseFieldPath` がドットでつないだ名前を解析するテストです。`titleContent.label` を渡した場合に、`prop` を順に並べた配列が返ることを確認します。');
    const result = parseFieldPath('titleContent.label');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'titleContent' },
      { type: 'prop', name: 'label' },
    ]);
  });

  it('配列の要素のプロパティを渡すと、prop・array・prop の配列を返す', async () => {
    await explains('`parseFieldPath` が配列の要素のプロパティを解析するテストです。`items[].section` を渡した場合に、`prop`・`array`・`prop` の順の配列が返ることを確認します。');
    const result = parseFieldPath('items[].section');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'items' },
      { type: 'array', name: '' },
      { type: 'prop', name: 'section' },
    ]);
  });

  it('配列そのものを渡すと、prop と array の配列を返す', async () => {
    await explains('`parseFieldPath` が配列そのものを解析するテストです。`details[]` を渡した場合に、`prop` と `array` の配列が返ることを確認します。');
    const result = parseFieldPath('details[]');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'details' },
      { type: 'array', name: '' },
    ]);
  });

  it('ネストの途中に配列があると、prop と array を順に並べた配列を返す', async () => {
    await explains('`parseFieldPath` がネストの途中にある配列を解析するテストです。`leftContent.items[].title` を渡した場合に、`prop` と `array` が順に並んだ配列が返ることを確認します。');
    const result = parseFieldPath('leftContent.items[].title');
    assert.deepStrictEqual(result, [
      { type: 'prop', name: 'leftContent' },
      { type: 'prop', name: 'items' },
      { type: 'array', name: '' },
      { type: 'prop', name: 'title' },
    ]);
  });

  it('空文字列を渡すと、空の配列を返す', async () => {
    await explains('`parseFieldPath` に空文字列を渡すテストです。空文字列を渡した場合に、空の配列が返ることを確認します。');
    const result = parseFieldPath('');
    assert.deepStrictEqual(result, []);
  });

  it('null を渡すと、空の配列を返す', async () => {
    await explains('`parseFieldPath` に `null` を渡すテストです。`null` を渡した場合に、例外を発生させず空の配列が返ることを確認します。');
    const result = parseFieldPath(null as unknown as string);
    assert.deepStrictEqual(result, []);
  });
});

describe('resolveFieldValues', () => {
  it('単純なプロパティを渡すと、その値とパスを返す', async () => {
    await explains('`resolveFieldValues` が単純なプロパティの値を取得するテストです。トップレベルのプロパティを指定した場合に、その値とパスが返ることを確認します。');
    const fm = { coverTitle: 'Hello' };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: 'Hello', path: 'coverTitle' }]);
  });

  it('ネストしたプロパティを渡すと、その値とパスを返す', async () => {
    await explains('`resolveFieldValues` がネストしたプロパティの値を取得するテストです。`titleContent.label` を指定した場合に、その値とパスが返ることを確認します。');
    const fm = { titleContent: { label: 'CONCEPT', title: 'Title' } };
    const result = resolveFieldValues(fm, 'titleContent.label');
    assert.deepStrictEqual(result, [{ value: 'CONCEPT', path: 'titleContent.label' }]);
  });

  it('配列の要素のプロパティを渡すと、要素ごとの値と添字つきのパスを返す', async () => {
    await explains('`resolveFieldValues` が配列の要素のプロパティの値を取得するテストです。`items[].section` を指定した場合に、要素ごとの値と添字付きのパスが返ることを確認します。');
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

  it('文字列の配列を渡すと、要素ごとの値と添字つきのパスを返す', async () => {
    await explains('`resolveFieldValues` が文字列の配列の値を取得するテストです。`details[]` を指定した場合に、要素ごとの値と添字付きのパスが返ることを確認します。');
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

  it('ネストの途中に配列があると、要素ごとの値と添字つきのパスを返す', async () => {
    await explains('`resolveFieldValues` がネストの途中にある配列の値を取得するテストです。`leftContent.items[].title` を指定した場合に、要素ごとの値と添字付きのパスが返ることを確認します。');
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

  it('存在しないプロパティだと、空の配列を返す', async () => {
    await explains('`resolveFieldValues` が存在しないプロパティを指定した場合のテストです。frontmatter に存在しない名前を指定した場合に、空の配列が返ることを確認します。');
    const fm = { coverTitle: 'Hello' };
    const result = resolveFieldValues(fm, 'nonExistent');
    assert.deepStrictEqual(result, []);
  });

  it('ネスト先が null だと、空の配列を返す', async () => {
    await explains('`resolveFieldValues` がネスト先の `null` を扱うテストです。ネスト先の値が `null` の場合に、例外を発生させず空の配列が返ることを確認します。');
    const fm = { titleContent: null };
    const result = resolveFieldValues(fm, 'titleContent.label');
    assert.deepStrictEqual(result, []);
  });

  it('配列のはずのプロパティが配列でないと、空の配列を返す', async () => {
    await explains('`resolveFieldValues` が配列でない値を配列として指定した場合のテストです。`items[]` を指定したプロパティが文字列の場合に、空の配列が返ることを確認します。');
    const fm = { items: 'not an array' };
    const result = resolveFieldValues(fm, 'items[].section');
    assert.deepStrictEqual(result, []);
  });

  it('配列が空だと、空の配列を返す', async () => {
    await explains('`resolveFieldValues` が空の配列を扱うテストです。指定した配列に要素が存在しない場合に、空の配列が返ることを確認します。');
    const fm = { items: [] };
    const result = resolveFieldValues(fm, 'items[].section');
    assert.deepStrictEqual(result, []);
  });

  it('プロパティの値が null だと、値として null を返す', async () => {
    await explains('`resolveFieldValues` がプロパティの値が `null` の場合を扱うテストです。値が `null` のプロパティを指定した場合に、値として `null` を持つ結果が返ることを確認します。');
    const fm = { coverTitle: null };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: null, path: 'coverTitle' }]);
  });

  it('プロパティの値が空文字列だと、値として空文字列を返す', async () => {
    await explains('`resolveFieldValues` がプロパティの値が空文字列の場合を扱うテストです。値が空文字列のプロパティを指定した場合に、値として空文字列を持つ結果が返ることを確認します。');
    const fm = { coverTitle: '' };
    const result = resolveFieldValues(fm, 'coverTitle');
    assert.deepStrictEqual(result, [{ value: '', path: 'coverTitle' }]);
  });
});

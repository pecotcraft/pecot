import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '@v-slidev/eslint-shared';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

describe('parseFrontmatter', () => {
  it('YAML の最上位が文字列だと、null を返す', async () => {
    await explains('`parseFrontmatter` が最上位を文字列とする YAML を扱うテストです。YAML の最上位が文字列の場合に、`null` が返ることを確認します。');
    const result = parseFrontmatter('---\n"hello"\n---\n');
    assert.strictEqual(result, null);
  });

  it('YAML の最上位が配列だと、null を返す', async () => {
    await explains('`parseFrontmatter` が最上位を配列とする YAML を扱うテストです。YAML の最上位が配列の場合に、`null` が返ることを確認します。');
    const result = parseFrontmatter('---\n- a\n- b\n---\n');
    assert.strictEqual(result, null);
  });

  it('YAML が不正だと、null を返す', async () => {
    await explains('`parseFrontmatter` が不正な YAML を扱うテストです。YAML の構文が不正な場合に、例外を発生させず `null` が返ることを確認します。');
    const result = parseFrontmatter('---\n: invalid\n---\n');
    assert.strictEqual(result, null);
  });
});

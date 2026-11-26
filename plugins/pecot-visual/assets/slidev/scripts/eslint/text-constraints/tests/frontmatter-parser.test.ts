import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '@v-slidev/eslint-shared';

describe('parseFrontmatter', () => {
  it('YAML の最上位が文字列だと、null を返す', () => {
    const result = parseFrontmatter('---\n"hello"\n---\n');
    assert.strictEqual(result, null);
  });

  it('YAML の最上位が配列だと、null を返す', () => {
    const result = parseFrontmatter('---\n- a\n- b\n---\n');
    assert.strictEqual(result, null);
  });

  it('YAML が不正だと、null を返す', () => {
    const result = parseFrontmatter('---\n: invalid\n---\n');
    assert.strictEqual(result, null);
  });
});

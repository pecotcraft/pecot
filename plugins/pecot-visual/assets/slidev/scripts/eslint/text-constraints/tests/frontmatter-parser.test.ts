import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '@v-slidev/eslint-shared';

describe('parseFrontmatter', () => {
  it('非 object YAML（string scalar）→ null', () => {
    const result = parseFrontmatter('---\n"hello"\n---\n');
    assert.strictEqual(result, null);
  });

  it('非 object YAML（array）→ null', () => {
    const result = parseFrontmatter('---\n- a\n- b\n---\n');
    assert.strictEqual(result, null);
  });

  it('不正 YAML → null', () => {
    const result = parseFrontmatter('---\n: invalid\n---\n');
    assert.strictEqual(result, null);
  });
});

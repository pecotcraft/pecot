/* eslint-disable unicorn/no-null -- 値が null の入力を再現する */
// 機能の値の検証で止めた理由を、チェックの problem の文にする関数の振る舞い。
import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'

import type { AttributeError } from '@pecot/workflow-core/domain/attributes.js'
import { attributeErrorLine } from '../attribute-writes.js'

describe('attributeErrorLine', () => {
  it.for<{ name: string, error: AttributeError, expected: string }>([
    { name: '名前だけの error', error: { code: 'unknown_attribute', name: 'size' }, expected: 'unknown_attribute: size' },
    { name: 'source を持つ error', error: { code: 'invalid_value', name: 'size', source: 'project' }, expected: 'invalid_value: size (project)' },
    { name: '値が null の error', error: { code: 'invalid_value', name: 'size', value: null }, expected: 'invalid_value: size; value null' },
    { name: '値が文字の error', error: { code: 'invalid_value', name: 'size', value: 'XL' }, expected: 'invalid_value: size; value "XL"' },
    { name: '値が配列の error', error: { code: 'invalid_value', name: 'labels', value: ['a', 'b'] }, expected: 'invalid_value: labels; value ["a","b"]' },
    { name: '取りうる値を持つ error', error: { code: 'invalid_value', name: 'size', expected: 'S, M or L' }, expected: 'invalid_value: size; expected S, M or L' },
    { name: '似た名前を持つ error', error: { code: 'unknown_attribute', name: 'sise', candidates: ['size', 'sort'] }, expected: 'unknown_attribute: sise; did you mean size, sort' },
    { name: '似た名前が空の配列の error', error: { code: 'unknown_attribute', name: 'sise', candidates: [] }, expected: 'unknown_attribute: sise' },
    { name: '複数の source を持つ error', error: { code: 'ambiguous_attribute', name: 'size', sources: ['project', 'issue_field'] }, expected: 'ambiguous_attribute: size; give source: project or issue_field' },
    { name: 'source の一覧が空の error', error: { code: 'ambiguous_attribute', name: 'size', sources: [] }, expected: 'ambiguous_attribute: size' },
    { name: '案内を持つ error', error: { code: 'read_only_attribute', name: 'parent', hint: 'use sub_issue_write' }, expected: 'read_only_attribute: parent; use sub_issue_write' },
    {
      name: 'すべてを持つ error',
      error: { code: 'invalid_value', name: 'size', source: 'issue_field', value: 'XL', expected: 'S or M', candidates: ['Size'], sources: ['project'], hint: 'retry' },
      expected: 'invalid_value: size (issue_field); value "XL"; expected S or M; did you mean Size; give source: project; retry',
    },
  ])('$name を渡すと、項目を「; 」でつないだ 1 行にする', async (row) => {
    await explains(`\`attributeErrorLine\` のテストです。${row.name}から、\`${row.expected}\` の行を作ることを確認します。`)
    expect(attributeErrorLine(row.error)).toBe(row.expected)
  })
})

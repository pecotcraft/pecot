import { describe, expect, it } from 'vitest'

import { JSON_NULL } from '../json-null.js'

describe('JSON_NULL', () => {
  it('JSON にすると null になる（undefined のように落ちない）', () => {
    expect(JSON.stringify({ a: JSON_NULL, b: undefined })).toBe('{"a":null}')
  })
})

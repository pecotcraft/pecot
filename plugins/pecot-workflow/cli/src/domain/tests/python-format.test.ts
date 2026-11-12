import { describe, expect, it } from 'vitest'

import { parseJson } from '../../tests/_helpers/json.js'
import { inputValueOutputs } from '../../tests/_helpers/python-output.js'
import {
  formatHttpStatusError,
  formatOsError,
  compareStrings,
  formatValidationError,
  normalizeNewlines,
  parsePythonInteger,
  pythonFloatRepr,
  pythonRepr,
  pythonStrip,
  pythonStringRepr,
  pythonTypeName,
  splitCodePoints,
  truncateCodePoints,
} from '../python-format.js'
import type { JsonValue } from '../python-format.js'

// 期待値は Python（repr / int / str.strip）の実出力から作った表。JSON の文字列 → repr の文字列。
const REPR_TABLE: readonly (readonly [string, string])[] = [
  ['null', 'None'],
  ['true', 'True'],
  ['false', 'False'],
  ['0', '0'],
  ['5', '5'],
  ['-3', '-3'],
  ['1.5', '1.5'],
  ['0.1', '0.1'],
  ['1e16', '1e+16'],
  ['1.5e300', '1.5e+300'],
  ['1e-5', '1e-05'],
  ['0.0001', '0.0001'],
  ['0.00012345', '0.00012345'],
  ['123456789012345.6', '123456789012345.6'],
  ['2.5e-7', '2.5e-07'],
  ['-0.5', '-0.5'],
  ['12345678901234567890.0', '1.2345678901234567e+19'],
  ['"abc"', '\'abc\''],
  ['"it\'s"', '"it\'s"'],
  ['"say \\"hi\\""', '\'say "hi"\''],
  ['"both \' and \\""', String.raw`'both \' and "'`],
  ['"tab\\there"', String.raw`'tab\there'`],
  ['"nl\\nx"', String.raw`'nl\nx'`],
  ['"back\\\\slash"', String.raw`'back\\slash'`],
  ['"\\u0000\\u001f\\u007f"', String.raw`'\x00\x1f\x7f'`],
  ['"é"', '\'é\''],
  ['"日本語"', '\'日本語\''],
  ['"\\u00a0"', String.raw`'\xa0'`],
  ['"\\u200b"', String.raw`'\u200b'`],
  ['"😀"', '\'😀\''],
  ['[]', '[]'],
  ['[1, "a", null]', '[1, \'a\', None]'],
  ['{}', '{}'],
  ['{"a": 1, "b": [true, null]}', '{\'a\': 1, \'b\': [True, None]}'],
]

describe('pythonRepr', () => {
  it.each(REPR_TABLE)('%s は Python の repr と同じ', (json, expected) => {
    expect(pythonRepr(parseJson(json))).toBe(expected)
  })

  it('NaN と無限大は nan・inf・-inf', () => {
    expect(pythonFloatRepr(NaN)).toBe('nan')
    expect(pythonFloatRepr(Infinity)).toBe('inf')
    expect(pythonFloatRepr(-Infinity)).toBe('-inf')
  })

  it('0.0 と -0.0 は小数点付き', () => {
    expect(pythonFloatRepr(0)).toBe('0.0')
    expect(pythonFloatRepr(-0)).toBe('-0.0')
  })

  it('小数点位置が 16 以内の大きい実数は固定表記、整数値は .0 を付ける', () => {
    expect(pythonFloatRepr(1e15)).toBe('1000000000000000.0')
    expect(pythonFloatRepr(-2.5e15)).toBe('-2500000000000000.0')
  })

  it('文字列の repr は引用符の選び方が Python と同じ', () => {
    expect(pythonStringRepr('')).toBe('\'\'')
    expect(pythonStringRepr('a\'b"c')).toBe(String.raw`'a\'b"c'`)
  })
})

describe('pythonTypeName', () => {
  it.each([
    ['null', 'NoneType'],
    ['true', 'bool'],
    ['3', 'int'],
    ['3.5', 'float'],
    ['"x"', 'str'],
    ['[1]', 'list'],
    ['{"a": 1}', 'dict'],
  ])('%s は %s', (json, expected) => {
    expect(pythonTypeName(parseJson(json))).toBe(expected)
  })

  it('値が無い（undefined）ときは NoneType', () => {
    expect(pythonTypeName(undefined)).toBe('NoneType')
  })
})

const INTEGER_TABLE: readonly (readonly [string, number])[] = [
  ['12', 12],
  [' 12 ', 12],
  ['+5', 5],
  ['-7', -7],
  ['1_000', 1000],
  ['\u{FF11}\u{FF12}\u{FF13}', 123],
  ['\u{663}', 3],
  ['\u{A0}12\u{3000}', 12],
]

describe('parsePythonInteger', () => {
  it.each(INTEGER_TABLE)('%j は int() で %d', (text, expected) => {
    expect(parsePythonInteger(text)).toBe(expected)
  })

  it.each(['1__0', '_1', '1_', '', 'abc', '1.5', '-', '0x10'])('%j は int() で ValueError', (text) => {
    expect(parsePythonInteger(text)).toBeUndefined()
  })
})

describe('pythonStrip', () => {
  it.each([
    ['  a b  ', 'a b'],
    ['\u{1C}x\u{1F}', 'x'],
    ['\u{FEFF}x\u{FEFF}', '\u{FEFF}x\u{FEFF}'],
    ['\u{85}x\u{85}', 'x'],
    ['\u{3000}\u{A0}x\u{2003}', 'x'],
  ])('%j は str.strip() と同じ', (text, expected) => {
    expect(pythonStrip(text)).toBe(expected)
  })
})

describe('splitCodePoints / truncateCodePoints', () => {
  it('絵文字は 1 文字として数え、切る位置もずれない', () => {
    expect(splitCodePoints('a\u{1F600}b')).toEqual(['a', '\u{1F600}', 'b'])
    expect(truncateCodePoints('\u{1F600}\u{1F600}\u{1F600}', 2)).toBe('\u{1F600}\u{1F600}')
  })
})

describe('formatHttpStatusError', () => {
  it('4xx は Client error と MDN の案内', () => {
    expect(formatHttpStatusError({ statusCode: 404, statusText: 'Not Found', url: 'https://api.github.com/repos/o/r', location: undefined }))
      .toBe('Client error \'404 Not Found\' for url \'https://api.github.com/repos/o/r\'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404')
  })

  it('statusText が空なら空のまま出す（Python の HTTP/1.1 の実出力: \'502 \'）', () => {
    expect(formatHttpStatusError({ statusCode: 502, statusText: '', url: 'http://h/x', location: undefined }))
      .toBe('Server error \'502 \' for url \'http://h/x\'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/502')
  })

  it('5xx は Server error', () => {
    expect(formatHttpStatusError({ statusCode: 502, statusText: 'Bad Gateway', url: 'http://h/x', location: undefined }))
      .toMatch(/^Server error '502 Bad Gateway'/u)
  })

  it('リダイレクトは Location の行が入る', () => {
    expect(formatHttpStatusError({ statusCode: 301, statusText: 'Moved Permanently', url: 'http://h/a', location: 'http://h/b' }))
      .toBe('Redirect response \'301 Moved Permanently\' for url \'http://h/a\'\nRedirect location: \'http://h/b\'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/301')
  })

  it('Location が無いリダイレクトは行を出さない', () => {
    expect(formatHttpStatusError({ statusCode: 304, statusText: '', url: 'http://h/a', location: undefined }))
      .toBe('Redirect response \'304 \' for url \'http://h/a\'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/304')
  })

  it('1xx・2xx・6xx 以降は Invalid status code', () => {
    expect(formatHttpStatusError({ statusCode: 299, statusText: '', url: 'http://h/a', location: undefined })).toMatch(/^Invalid status code '299 ' for url/u)
  })
})

describe('formatOsError', () => {
  it('ENOENT は [Errno 2] とパスの repr', () => {
    expect(formatOsError({ code: 'ENOENT', path: '/x/y' })).toBe('[Errno 2] No such file or directory: \'/x/y\'')
  })

  it('2 つのパスは -> でつなぐ', () => {
    expect(formatOsError({ code: 'EEXIST', path: 'a', dest: 'b' })).toBe('[Errno 17] File exists: \'a\' -> \'b\'')
  })

  it('パスが無ければ本文だけ', () => {
    expect(formatOsError({ code: 'EACCES' })).toBe('[Errno 13] Permission denied')
  })

  it('表に無い code は undefined', () => {
    expect(formatOsError({ code: 'EWHATEVER', path: 'a' })).toBeUndefined()
    expect(formatOsError({})).toBeUndefined()
  })
})

describe('formatValidationError', () => {
  it('Python の ValidationError の文と同じ（フィールドの誤り・未指定・入れ子の場所）', () => {
    // Python: ProjectConfig.model_validate({'host': 1, ...}) の str(e)（先頭 2 件）
    const text = formatValidationError('ProjectConfig', [
      { type: 'string_type', location: ['host'], message: 'Input should be a valid string', input: 1 },
      { type: 'missing', location: ['workflow_suffix'], message: 'Field required', input: { host: 1, owner: 'x' } },
      { type: 'string_pattern_mismatch', location: ['repositories', 0, 'packages', 0, 'name'], message: 'String should match pattern \'^[A-Za-z0-9_.-]+$\'', input: 'a b' },
    ])
    expect(text).toBe([
      '3 validation errors for ProjectConfig',
      'host',
      '  Input should be a valid string [type=string_type, input_value=1, input_type=int]',
      '    For further information visit https://errors.pydantic.dev/2.14/v/string_type',
      'workflow_suffix',
      '  Field required [type=missing, input_value={\'host\': 1, \'owner\': \'x\'}, input_type=dict]',
      '    For further information visit https://errors.pydantic.dev/2.14/v/missing',
      'repositories.0.packages.0.name',
      '  String should match pattern \'^[A-Za-z0-9_.-]+$\' [type=string_pattern_mismatch, input_value=\'a b\', input_type=str]',
      '    For further information visit https://errors.pydantic.dev/2.14/v/string_pattern_mismatch',
    ].join('\n'))
  })

  it('場所が空なら場所の行を出さず、1 件は単数形', () => {
    expect(formatValidationError('Repository', [{ type: 'value_error', location: [], message: 'Value error, x', input: parseJson('null') }]))
      .toBe('1 validation error for Repository\n  Value error, x [type=value_error, input_value=None, input_type=NoneType]\n    For further information visit https://errors.pydantic.dev/2.14/v/value_error')
  })

  it('入力値の repr は 50 文字を超えると前 25 文字と後ろ 24 文字を ... でつなぐ（Python の実出力）', () => {
    const text = formatValidationError('ProjectConfig', [{ type: 'missing', location: ['owner'], message: 'Field required', input: { host: 'h'.repeat(75) } }])
    expect(text).toContain('input_value={\'host\': \'hhhhhhhhhhhhhhh...hhhhhhhhhhhhhhhhhhhhhh\'}, input_type=dict]')
  })

  it('50 文字ちょうどなら切らない', () => {
    const value = 'x'.repeat(48)
    expect(formatValidationError('M', [{ type: 'string_type', location: ['a'], message: 'm', input: value }])).toContain(`input_value='${value}'`)
  })
})

// 入力値の repr は、UTF-8 のバイト長が 50 を超えると、前 25 バイト以内・後ろ 24 バイト以内の文字境界で切って ... でつなぐ。
// 期待値は Python（pydantic）の ValidationError の文の実出力（tests/python-output/input-values.json）。
function inputValueOf(input: JsonValue): string {
  const text = formatValidationError('M', [{ type: 'string_type', location: ['a'], message: 'm', input }])
  const line = text.split('\n', 3)[2] ?? ''
  return line.slice(line.indexOf('input_value=') + 'input_value='.length, line.lastIndexOf(', input_type'))
}

describe('formatValidationError（入力値の省略はバイト長で決まる）', () => {
  it.each(inputValueOutputs())('$name のとき、Python の入力値の表記と一致する', ({ input, inputValue }) => {
    expect(inputValueOf(input)).toBe(inputValue)
  })
})

describe('normalizeNewlines', () => {
  it('\\r\\n と \\r を \\n に揃える', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })
})

describe('compareStrings', () => {
  it('等しければ 0、小さければ負、大きければ正', () => {
    expect(compareStrings('a', 'a')).toBe(0)
    expect(compareStrings('a', 'b')).toBe(-1)
    expect(compareStrings('b', 'a')).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'

import { explains } from '../../../tests/_helpers/explains.js'
import { stepSync } from '../../../tests/_helpers/step.js'
import { parseJson } from '../../../tests/_helpers/json.js'
import { inputValueOutputs } from '../../../tests/_helpers/python-output.js'
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
  it.each(REPR_TABLE)('JSON の値 %s を渡すと、Python の repr と同じ文字列を返す', async (json, expected) => {
    await explains(`Python の \`repr\` に合わせて JSON の値を文字列にする、\`pythonRepr\` のテストです。JSON の値 \`${json}\` を渡した場合に、Python の実出力 \`${expected}\` と同じ文字列を返すことを確認します。`)
    stepSync('pythonRepr を呼び、結果を比べる', () => {
      expect(pythonRepr(parseJson(json))).toBe(expected)
    })
  })

  it('NaN と無限大は、nan・inf・-inf の文字列にする', async () => {
    await explains('Python の `repr` に合わせて実数を文字列にする、`pythonFloatRepr` のテストです。`NaN`・正の無限大・負の無限大を渡した場合に、`nan`・`inf`・`-inf` を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(pythonFloatRepr(NaN)).toBe('nan')
      expect(pythonFloatRepr(Infinity)).toBe('inf')
      expect(pythonFloatRepr(-Infinity)).toBe('-inf')
    })
  })

  it('0.0 と -0.0 は、小数点を付けた文字列にする', async () => {
    await explains('Python の `repr` に合わせて実数を文字列にする、`pythonFloatRepr` のテストです。`0` と `-0` を渡した場合に、`0.0` と `-0.0` のように小数点を付けた文字列を返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(pythonFloatRepr(0)).toBe('0.0')
      expect(pythonFloatRepr(-0)).toBe('-0.0')
    })
  })

  it('小数点位置が 16 桁以内の大きい実数は、固定表記にして整数値には .0 を付ける', async () => {
    await explains('Python の `repr` に合わせて実数を文字列にする、`pythonFloatRepr` のテストです。`1e15` のように小数点位置が 16 桁以内の大きい実数を渡した場合に、指数表記にせず、末尾に `.0` を付けた固定表記で返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(pythonFloatRepr(1e15)).toBe('1000000000000000.0')
      expect(pythonFloatRepr(-2.5e15)).toBe('-2500000000000000.0')
    })
  })

  it('文字列の repr は、引用符の選び方が Python と同じになる', async () => {
    await explains('Python の `repr` に合わせて文字列を文字列にする、`pythonStringRepr` のテストです。空文字と、一重引用符と二重引用符の両方を含む文字列を渡した場合に、Python と同じ引用符とエスケープで返すことを確認します。')
    stepSync('結果を比べる', () => {
      expect(pythonStringRepr('')).toBe('\'\'')
      expect(pythonStringRepr('a\'b"c')).toBe(String.raw`'a\'b"c'`)
    })
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
  ])('JSON の値 %s を渡すと、Python の型名 %s を返す', async (json, expected) => {
    await explains(`Python の型名を返す、\`pythonTypeName\` のテストです。JSON の値 \`${json}\` を渡した場合に、Python の型名 \`${expected}\` を返すことを確認します。`)
    stepSync('pythonTypeName を呼び、結果を比べる', () => {
      expect(pythonTypeName(parseJson(json))).toBe(expected)
    })
  })

  it('値が undefined の場合は、NoneType を返す', async () => {
    await explains('Python の型名を返す、`pythonTypeName` のテストです。値が存在しない（`undefined`）場合に、`NoneType` を返すことを確認します。')
    stepSync('pythonTypeName を呼び、結果を比べる', () => {
      expect(pythonTypeName(undefined)).toBe('NoneType')
    })
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
  it.each(INTEGER_TABLE)('%j を渡すと、Python の int() と同じく整数 %d を返す', async (text, expected) => {
    await explains(`Python の \`int()\` に合わせて文字列を整数にする、\`parsePythonInteger\` のテストです。\`${JSON.stringify(text)}\` を渡した場合に、整数 \`${String(expected)}\` を返すことを確認します。`)
    stepSync('parsePythonInteger を呼び、結果を比べる', () => {
      expect(parsePythonInteger(text)).toBe(expected)
    })
  })

  it.each(['1__0', '_1', '1_', '', 'abc', '1.5', '-', '0x10'])('%j を渡すと、Python の int() で ValueError になるため undefined を返す', async (text) => {
    await explains(`Python の \`int()\` に合わせて文字列を整数にする、\`parsePythonInteger\` のテストです。Python の \`int()\` で \`ValueError\` になる \`${JSON.stringify(text)}\` を渡した場合に、\`undefined\` を返すことを確認します。`)
    stepSync('parsePythonInteger を呼び、結果を比べる', () => {
      expect(parsePythonInteger(text)).toBeUndefined()
    })
  })
})

describe('pythonStrip', () => {
  it.each([
    ['  a b  ', 'a b'],
    ['\u{1C}x\u{1F}', 'x'],
    ['\u{FEFF}x\u{FEFF}', '\u{FEFF}x\u{FEFF}'],
    ['\u{85}x\u{85}', 'x'],
    ['\u{3000}\u{A0}x\u{2003}', 'x'],
  ])('%j を渡すと、Python の str.strip() と同じ結果を返す', async (text, expected) => {
    await explains(`Python の \`str.strip()\` に合わせて前後の空白を除く、\`pythonStrip\` のテストです。\`${JSON.stringify(text)}\` を渡した場合に、Python と同じく空白とみなす文字だけを除いた結果を返すことを確認します。`)
    stepSync('pythonStrip を呼び、結果を比べる', () => {
      expect(pythonStrip(text)).toBe(expected)
    })
  })
})

describe('splitCodePoints / truncateCodePoints', () => {
  it('絵文字を 1 文字として数え、切り取る位置もずれない', async () => {
    await explains('文字列をコードポイント単位で扱う、`splitCodePoints` と `truncateCodePoints` のテストです。絵文字を含む文字列の場合に、絵文字を 1 文字として分割し、指定した文字数で切り取っても、絵文字の途中で切れないことを確認します。')
    stepSync('splitCodePoints を呼び、結果を比べる', () => {
      expect(splitCodePoints('a\u{1F600}b')).toEqual(['a', '\u{1F600}', 'b'])
      expect(truncateCodePoints('\u{1F600}\u{1F600}\u{1F600}', 2)).toBe('\u{1F600}\u{1F600}')
    })
  })
})

describe('formatHttpStatusError', () => {
  it('ステータスが 4xx の場合は、Client error と MDN の案内を含む文を作成する', async () => {
    await explains('HTTP のステータスエラーの文を作成する、`formatHttpStatusError` のテストです。ステータスが 404 の場合に、httpx と同じ `Client error` の文と、MDN の参照先を含むことを確認します。')
    stepSync('formatHttpStatusError を呼び、結果を比べる', () => {
      expect(formatHttpStatusError({ statusCode: 404, statusText: 'Not Found', url: 'https://api.github.com/repos/o/r', location: undefined }))
        .toBe('Client error \'404 Not Found\' for url \'https://api.github.com/repos/o/r\'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404')
    })
  })

  it('statusText が空の場合は、空のまま表示する（Python の HTTP/1.1 の実出力: \'502 \'）', async () => {
    await explains('HTTP のステータスエラーの文を作成する、`formatHttpStatusError` のテストです。`statusText` が空の場合に、補わずに `502 ` のまま表示し、Python の HTTP/1.1 の実出力と一致することを確認します。')
    stepSync('formatHttpStatusError を呼び、結果を比べる', () => {
      expect(formatHttpStatusError({ statusCode: 502, statusText: '', url: 'http://h/x', location: undefined }))
        .toBe('Server error \'502 \' for url \'http://h/x\'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/502')
    })
  })

  it('ステータスが 5xx の場合は、Server error の文を作成する', async () => {
    await explains('HTTP のステータスエラーの文を作成する、`formatHttpStatusError` のテストです。ステータスが 502 の場合に、`Server error` で始まる文を返すことを確認します。')
    stepSync('formatHttpStatusError を呼び、結果を比べる', () => {
      expect(formatHttpStatusError({ statusCode: 502, statusText: 'Bad Gateway', url: 'http://h/x', location: undefined }))
        .toMatch(/^Server error '502 Bad Gateway'/u)
    })
  })

  it('ステータスがリダイレクトの場合は、Location の行を含める', async () => {
    await explains('HTTP のステータスエラーの文を作成する、`formatHttpStatusError` のテストです。ステータスが 301 で `Location` を持つ場合に、`Redirect response` の文へ `Redirect location` の行を含めることを確認します。')
    stepSync('formatHttpStatusError を呼び、結果を比べる', () => {
      expect(formatHttpStatusError({ statusCode: 301, statusText: 'Moved Permanently', url: 'http://h/a', location: 'http://h/b' }))
        .toBe('Redirect response \'301 Moved Permanently\' for url \'http://h/a\'\nRedirect location: \'http://h/b\'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/301')
    })
  })

  it('Location が存在しないリダイレクトの場合は、Location の行を表示しない', async () => {
    await explains('HTTP のステータスエラーの文を作成する、`formatHttpStatusError` のテストです。ステータスが 304 で `Location` が存在しない場合に、`Redirect location` の行を含めないことを確認します。')
    stepSync('formatHttpStatusError を呼び、結果を比べる', () => {
      expect(formatHttpStatusError({ statusCode: 304, statusText: '', url: 'http://h/a', location: undefined }))
        .toBe('Redirect response \'304 \' for url \'http://h/a\'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/304')
    })
  })

  it('ステータスが 1xx・2xx・6xx 以降の場合は、Invalid status code の文を作成する', async () => {
    await explains('HTTP のステータスエラーの文を作成する、`formatHttpStatusError` のテストです。ステータスが 299 のようにエラーでない値の場合に、`Invalid status code` で始まる文を返すことを確認します。')
    stepSync('formatHttpStatusError を呼び、結果を比べる', () => {
      expect(formatHttpStatusError({ statusCode: 299, statusText: '', url: 'http://h/a', location: undefined })).toMatch(/^Invalid status code '299 ' for url/u)
    })
  })
})

describe('formatOsError', () => {
  it('ENOENT は、[Errno 2] とパスの repr を含む文にする', async () => {
    await explains('OS のエラーの文を作成する、`formatOsError` のテストです。コードが `ENOENT` でパスを指定した場合に、Python と同じ `[Errno 2] No such file or directory:` の文にパスの `repr` を続けることを確認します。')
    stepSync('formatOsError を呼び、結果を比べる', () => {
      expect(formatOsError({ code: 'ENOENT', path: '/x/y' })).toBe('[Errno 2] No such file or directory: \'/x/y\'')
    })
  })

  it('2 つのパスがある場合は、-> でつなぐ', async () => {
    await explains('OS のエラーの文を作成する、`formatOsError` のテストです。パスと移動先の 2 つのパスを指定した場合に、`->` でつないだ文を返すことを確認します。')
    stepSync('formatOsError を呼び、結果を比べる', () => {
      expect(formatOsError({ code: 'EEXIST', path: 'a', dest: 'b' })).toBe('[Errno 17] File exists: \'a\' -> \'b\'')
    })
  })

  it('パスが存在しない場合は、本文だけの文にする', async () => {
    await explains('OS のエラーの文を作成する、`formatOsError` のテストです。パスを指定しない場合に、`[Errno 13] Permission denied` のように、パスを含めない文を返すことを確認します。')
    stepSync('formatOsError を呼び、結果を比べる', () => {
      expect(formatOsError({ code: 'EACCES' })).toBe('[Errno 13] Permission denied')
    })
  })

  it('対応表に存在しない code の場合は、undefined を返す', async () => {
    await explains('OS のエラーの文を作成する、`formatOsError` のテストです。対応表に存在しないコードの場合と、コードがない場合に、`undefined` を返すことを確認します。')
    stepSync('formatOsError を呼び、結果を比べる', () => {
      expect(formatOsError({ code: 'EWHATEVER', path: 'a' })).toBeUndefined()
      expect(formatOsError({})).toBeUndefined()
    })
  })
})

describe('formatValidationError', () => {
  it('検証エラーが複数ある場合は、Python の ValidationError の文と同じ形式にする（フィールドの誤り・未指定・入れ子の場所）', async () => {
    await explains('pydantic の `ValidationError` の文を作成する、`formatValidationError` のテストです。型の誤り・必須項目の不足・入れ子の場所のエラーが 3 件ある場合に、Python の実出力と同じ形式の文を返すことを確認します。')
    const text = stepSync('formatValidationError を呼ぶ', () => formatValidationError('ProjectConfig', [
      { type: 'string_type', location: ['host'], message: 'Input should be a valid string', input: 1 },
      { type: 'missing', location: ['workflow_suffix'], message: 'Field required', input: { host: 1, owner: 'x' } },
      { type: 'string_pattern_mismatch', location: ['repositories', 0, 'packages', 0, 'name'], message: 'String should match pattern \'^[A-Za-z0-9_.-]+$\'', input: 'a b' },
    ]))
    stepSync('結果を比べる', () => {
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
  })

  it('エラーの場所が空の場合は場所の行を表示せず、1 件の場合は単数形にする', async () => {
    await explains('pydantic の `ValidationError` の文を作成する、`formatValidationError` のテストです。エラーが 1 件で場所が空の場合に、場所の行を含めず、見出しを単数形の `validation error` にすることを確認します。')
    stepSync('formatValidationError を呼び、結果を比べる', () => {
      expect(formatValidationError('Repository', [{ type: 'value_error', location: [], message: 'Value error, x', input: parseJson('null') }]))
        .toBe('1 validation error for Repository\n  Value error, x [type=value_error, input_value=None, input_type=NoneType]\n    For further information visit https://errors.pydantic.dev/2.14/v/value_error')
    })
  })

  it('入力値の repr が 50 文字を超える場合は、前 25 文字と後ろ 24 文字を ... でつなぐ（Python の実出力）', async () => {
    await explains('pydantic の `ValidationError` の文を作成する、`formatValidationError` のテストです。入力値の `repr` が 50 文字を超える場合に、前の 25 文字と後ろの 24 文字を `...` でつないで省略することを確認します。')
    const text = stepSync('formatValidationError を呼ぶ', () => formatValidationError('ProjectConfig', [{ type: 'missing', location: ['owner'], message: 'Field required', input: { host: 'h'.repeat(75) } }]))
    stepSync('結果を比べる', () => {
      expect(text).toContain('input_value={\'host\': \'hhhhhhhhhhhhhhh...hhhhhhhhhhhhhhhhhhhhhh\'}, input_type=dict]')
    })
  })

  it('入力値の repr が 50 文字ちょうどの場合は、省略しない', async () => {
    await explains('pydantic の `ValidationError` の文を作成する、`formatValidationError` のテストです。入力値の `repr` が 50 文字ちょうどの場合に、`...` で省略せず全体を表示することを確認します。')
    const value = stepSync('入力を用意する', () => 'x'.repeat(48))
    stepSync('formatValidationError を呼び、結果を比べる', () => {
      expect(formatValidationError('M', [{ type: 'string_type', location: ['a'], message: 'm', input: value }])).toContain(`input_value='${value}'`)
    })
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
  it.each(inputValueOutputs())('入力値が $name の場合は、Python の入力値の表記と一致する', async ({ name, input, inputValue }) => {
    await explains(`pydantic の \`ValidationError\` の文に含める入力値の表記の、\`formatValidationError\` のテストです。入力値が「${name}」の場合に、Python の実出力の表記と一致し、UTF-8 のバイト長が 50 を超えるときは文字境界で切って \`...\` でつなぐことを確認します。`)
    stepSync('結果を比べる', () => {
      expect(inputValueOf(input)).toBe(inputValue)
    })
  })
})

describe('normalizeNewlines', () => {
  it('改行の \\r\\n と \\r を、\\n にそろえる', async () => {
    await explains('改行を `\\n` にそろえる、`normalizeNewlines` のテストです。`\\r\\n`・`\\r`・`\\n` が混在する文字列を渡した場合に、すべて `\\n` に変換することを確認します。')
    stepSync('normalizeNewlines を呼び、結果を比べる', () => {
      expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
    })
  })
})

describe('compareStrings', () => {
  it('2 つの文字列が等しい場合は 0、小さい場合は負、大きい場合は正の値を返す', async () => {
    await explains('文字列を比較する `compareStrings` のテストです。等しい場合は `0`、前が小さい場合は `-1`、前が大きい場合は `1` を返すことを確認します。')
    stepSync('compareStrings を呼び、結果を比べる', () => {
      expect(compareStrings('a', 'a')).toBe(0)
      expect(compareStrings('a', 'b')).toBe(-1)
      expect(compareStrings('b', 'a')).toBe(1)
    })
  })
})

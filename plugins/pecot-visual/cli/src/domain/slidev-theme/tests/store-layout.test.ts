import { describe, expect, it } from 'vitest'

import {
  classifyGitFailure,
  computeInputsHash,
  gitFailureAdvice,
  parseThemeStamp,
  ThemeFetchError,
  themeStoreDirectory,
} from '../store-layout.js'
import { explains } from '../../../../tests/_helpers/explains.js'

const SPEC = { url: 'https://git.example.com/acme/theme.git', tag: 'v1.0.0' }

describe('themeStoreDirectory', () => {
  it('テーマの置き場は、url の sha256 の先頭 16 桁とタグで決まる', async () => {
    await explains('テーマの保存先を決める `themeStoreDirectory` のテストです。url とタグ `v1.0.0` を渡した場合に、保存先が `/data/themes/379eb4ca106477b8/v1.0.0` になることを確認します。')
    // sha256('https://git.example.com/acme/theme.git') の先頭 16 桁
    expect(themeStoreDirectory('/data/themes', SPEC)).toBe('/data/themes/379eb4ca106477b8/v1.0.0')
  })

  it('url が違う場合は別の置き場になり、タグだけが違う場合は同じ階層の別ディレクトリになる', async () => {
    await explains('テーマの保存先を決める `themeStoreDirectory` のテストです。url だけを変えると保存先が変わり、タグだけを変えると、上位の階層が同じで末尾のタグだけが違う保存先になることを確認します。')
    const other = themeStoreDirectory('/data/themes', { ...SPEC, url: 'https://git.example.com/acme/other.git' })
    expect(other).not.toBe(themeStoreDirectory('/data/themes', SPEC))
    const next = themeStoreDirectory('/data/themes', { ...SPEC, tag: 'v1.0.1' })
    expect(next.replace(/v1\.0\.1$/u, 'v1.0.0')).toBe(themeStoreDirectory('/data/themes', SPEC))
  })
})

describe('computeInputsHash', () => {
  const digests = [{ file: 'a+1.0.0.patch', hash: 'aaa' }]

  it('package.json と patch の内容が同じ場合は、同じハッシュを返す', async () => {
    await explains('テーマの入力のハッシュを求める `computeInputsHash` のテストです。同じ `package.json` の内容と patch の一覧を 2 回渡した場合に、同じ値が返ることを確認します。')
    expect(computeInputsHash('{"name":"t"}', digests)).toBe(computeInputsHash('{"name":"t"}', digests))
  })

  it('package.json の内容が違う場合は、違うハッシュを返す', async () => {
    await explains('テーマの入力のハッシュを求める `computeInputsHash` のテストです。`package.json` の内容だけを変えた場合に、返る値が変わることを確認します。')
    expect(computeInputsHash('{"name":"t"}', digests)).not.toBe(computeInputsHash('{"name":"u"}', digests))
  })

  it('patch の内容のハッシュが違う場合は、違うハッシュを返す', async () => {
    await explains('テーマの入力のハッシュを求める `computeInputsHash` のテストです。patch の内容のハッシュだけを変えた場合に、返る値が変わることを確認します。')
    expect(computeInputsHash('{}', digests)).not.toBe(computeInputsHash('{}', [{ file: 'a+1.0.0.patch', hash: 'bbb' }]))
  })

  it('patch が存在する場合と存在しない場合で、違うハッシュを返す', async () => {
    await explains('テーマの入力のハッシュを求める `computeInputsHash` のテストです。patch の一覧が空の場合と、patch が 1 件ある場合で、返る値が変わることを確認します。')
    expect(computeInputsHash('{}', [])).not.toBe(computeInputsHash('{}', digests))
  })
})

describe('parseThemeStamp', () => {
  const valid = { spec: SPEC, fetchedAt: '2026-11-02T00:00:00.000Z', inputsHash: 'abc' }

  it('正しい形の JSON を渡すと、その内容をスタンプとして返す', async () => {
    await explains('テーマの取得記録（スタンプ）を読み込む `parseThemeStamp` のテストです。`spec`・`fetchedAt`・`inputsHash` を持つ正しい形の JSON を渡した場合に、その内容がそのまま返ることを確認します。')
    expect(parseThemeStamp(JSON.stringify(valid))).toEqual(valid)
  })

  it.each([
    ['JSON でない', 'not json'],
    ['配列', '[]'],
    ['spec が無い', JSON.stringify({ fetchedAt: 'x', inputsHash: 'y' })],
    ['inputsHash が文字列でない', JSON.stringify({ ...valid, inputsHash: 1 })],
    ['tag が文字列でない', JSON.stringify({ ...valid, spec: { url: 'u', tag: 1 } })],
  ])('スタンプの内容が「%s」の場合は、undefined を返す', async (_label, text) => {
    await explains(`テーマの取得記録（スタンプ）を読み込む \`parseThemeStamp\` のテストです。内容が「${_label}」の場合に、スタンプとして読めないため \`undefined\` を返すことを確認します。`)
    expect(parseThemeStamp(text)).toBeUndefined()
  })
})

// 次の stderr は実際に出た文言（.pecot/work/1343/probes/README.md）と、git が出す既知の文言。
const FAILURES: readonly (readonly [string, string, string])[] = [
  ['接続不可', 'fatal: unable to access \'https://127.0.0.1:1/x/y.git/\': Failed to connect to 127.0.0.1 port 1 after 0 ms: Could not connect to server', 'connection'],
  ['名前解決', 'fatal: unable to access \'https://nohost.invalid/x.git/\': Could not resolve host: nohost.invalid', 'connection'],
  ['証明書', 'fatal: unable to access \'https://git.example.com/x.git/\': SSL certificate problem: unable to get local issuer certificate', 'connection'],
  ['https の認証無し', 'fatal: could not read Username for \'https://git.example.com\': terminal prompts disabled', 'auth'],
  ['https の認証失敗', 'remote: Invalid username or password.\nfatal: Authentication failed for \'https://git.example.com/x.git/\'', 'auth'],
  ['prompt 無効', 'fatal: could not read Password: terminal prompts disabled', 'auth'],
  ['ssh の鍵', 'git@git.example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
  ['ssh のホスト鍵', 'Host key verification failed.\nfatal: Could not read from remote repository.', 'auth'],
  ['curl 7.x の接続拒否', 'fatal: unable to access \'https://h/x.git/\': Failed to connect to h port 443: Connection refused', 'connection'],
  ['接続のタイムアウト', 'fatal: unable to access \'https://h/x.git/\': Connection timed out after 5001 milliseconds', 'connection'],
  ['ネットワーク到達不可', 'ssh: connect to host h port 22: Network is unreachable', 'connection'],
  ['タグ無し', 'fatal: couldn\'t find remote ref refs/tags/v9.9.9', 'tag'],
  ['不明', 'fatal: something else', 'unknown'],
  ['空', '', 'unknown'],
]

describe('classifyGitFailure', () => {
  it.each(FAILURES)('git の失敗の出力が「%s」の場合は、原因の種類に分類する', async (_label, stderr, expected) => {
    await explains(`git の失敗の出力を分類する \`classifyGitFailure\` のテストです。標準エラー出力が「${_label}」の場合に、原因の種類が \`${expected}\` に分類されることを確認します。`)
    expect(classifyGitFailure(stderr)).toBe(expected)
  })
})

describe('gitFailureAdvice', () => {
  it('接続の失敗では、対処として http.sslCAInfo を案内する', async () => {
    await explains('git の失敗の対処を案内する `gitFailureAdvice` のテストです。原因が `connection` の場合に、案内の文に `http.sslCAInfo` が含まれることを確認します。')
    expect(gitFailureAdvice('connection', SPEC)).toContain('http.sslCAInfo')
  })

  it('認証の失敗では、対処として認証情報の設定を案内する', async () => {
    await explains('git の失敗の対処を案内する `gitFailureAdvice` のテストです。原因が `auth` の場合に、案内の文に `set up git credentials` が含まれることを確認します。')
    expect(gitFailureAdvice('auth', SPEC)).toContain('set up git credentials')
  })

  it('タグの失敗では、対処として指定したタグ名を案内する', async () => {
    await explains('git の失敗の対処を案内する `gitFailureAdvice` のテストです。原因が `tag` の場合に、案内の文に指定したタグ `v1.0.0` が含まれることを確認します。')
    expect(gitFailureAdvice('tag', SPEC)).toContain('v1.0.0')
  })

  it('分類できない失敗でも、対処として url を案内する', async () => {
    await explains('git の失敗の対処を案内する `gitFailureAdvice` のテストです。原因が `unknown` の場合に、案内の文にテーマの url が含まれることを確認します。')
    expect(gitFailureAdvice('unknown', SPEC)).toContain(SPEC.url)
  })
})

describe('ThemeFetchError', () => {
  it('テーマ取得のエラーは、渡した reason とメッセージを保持する', async () => {
    await explains('テーマの取得に失敗したことを表す `ThemeFetchError` のテストです。メッセージと `install` を渡して作成した場合に、`name` が `ThemeFetchError` になり、`reason` とメッセージがそのまま保持されることを確認します。')
    const error = new ThemeFetchError('失敗', 'install')
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install', message: '失敗' })
  })
})

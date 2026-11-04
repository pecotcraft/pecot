import { describe, expect, it } from 'vitest'

import {
  classifyGitFailure,
  computeInputsHash,
  gitFailureAdvice,
  parseThemeStamp,
  ThemeFetchError,
  themeStoreDirectory,
} from '../store-layout.js'

const SPEC = { url: 'https://git.example.com/acme/theme.git', tag: 'v1.0.0' }

describe('themeStoreDirectory', () => {
  it('url の sha256 先頭 16 桁とタグで置き場を決める', () => {
    // sha256('https://git.example.com/acme/theme.git') の先頭 16 桁
    expect(themeStoreDirectory('/data/themes', SPEC)).toBe('/data/themes/379eb4ca106477b8/v1.0.0')
  })

  it('url が違えば別の置き場になり、タグが違えば同じ階層の別ディレクトリになる', () => {
    const other = themeStoreDirectory('/data/themes', { ...SPEC, url: 'https://git.example.com/acme/other.git' })
    expect(other).not.toBe(themeStoreDirectory('/data/themes', SPEC))
    const next = themeStoreDirectory('/data/themes', { ...SPEC, tag: 'v1.0.1' })
    expect(next.replace(/v1\.0\.1$/u, 'v1.0.0')).toBe(themeStoreDirectory('/data/themes', SPEC))
  })
})

describe('computeInputsHash', () => {
  const digests = [{ file: 'a+1.0.0.patch', hash: 'aaa' }]

  it('同じ入力なら同じ値を返す', () => {
    expect(computeInputsHash('{"name":"t"}', digests)).toBe(computeInputsHash('{"name":"t"}', digests))
  })

  it('package.json が変われば変わる', () => {
    expect(computeInputsHash('{"name":"t"}', digests)).not.toBe(computeInputsHash('{"name":"u"}', digests))
  })

  it('patch の内容ハッシュが変われば変わる', () => {
    expect(computeInputsHash('{}', digests)).not.toBe(computeInputsHash('{}', [{ file: 'a+1.0.0.patch', hash: 'bbb' }]))
  })

  it('patch の有無で変わる', () => {
    expect(computeInputsHash('{}', [])).not.toBe(computeInputsHash('{}', digests))
  })
})

describe('parseThemeStamp', () => {
  const valid = { spec: SPEC, fetchedAt: '2026-11-02T00:00:00.000Z', inputsHash: 'abc' }

  it('正しい形を読む', () => {
    expect(parseThemeStamp(JSON.stringify(valid))).toEqual(valid)
  })

  it.each([
    ['JSON でない', 'not json'],
    ['配列', '[]'],
    ['spec が無い', JSON.stringify({ fetchedAt: 'x', inputsHash: 'y' })],
    ['inputsHash が文字列でない', JSON.stringify({ ...valid, inputsHash: 1 })],
    ['tag が文字列でない', JSON.stringify({ ...valid, spec: { url: 'u', tag: 1 } })],
  ])('%s は undefined', (_label, text) => {
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
  it.each(FAILURES)('%s を分ける', (_label, stderr, expected) => {
    expect(classifyGitFailure(stderr)).toBe(expected)
  })
})

describe('gitFailureAdvice', () => {
  it('接続の失敗は http.sslCAInfo を示す', () => {
    expect(gitFailureAdvice('connection', SPEC)).toContain('http.sslCAInfo')
  })

  it('認証の失敗は認証情報の設定を示す', () => {
    expect(gitFailureAdvice('auth', SPEC)).toContain('認証情報')
  })

  it('タグの失敗はタグ名を示す', () => {
    expect(gitFailureAdvice('tag', SPEC)).toContain('v1.0.0')
  })

  it('分類できない失敗も url を示す', () => {
    expect(gitFailureAdvice('unknown', SPEC)).toContain(SPEC.url)
  })
})

describe('ThemeFetchError', () => {
  it('reason を持つ', () => {
    const error = new ThemeFetchError('失敗', 'install')
    expect(error).toMatchObject({ name: 'ThemeFetchError', reason: 'install', message: '失敗' })
  })
})

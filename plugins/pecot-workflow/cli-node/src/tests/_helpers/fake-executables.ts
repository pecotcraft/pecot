/* eslint-disable security/detect-non-literal-fs-filename -- 触るのは一時ディレクトリ配下のみ */
// PATH に置く偽の実行ファイル（gh・nx など）の補助。外部コマンドはこれで差し替える。
//
// 使い方は次のとおり。
// - makeTemporaryDirectory() で bin を作る。
// - installFakeGh(bin, { token }) は、gh auth token が token を出す偽物を置く。token を省くと exit 1 になる。
// - installFakeNx(bin, { stdout, stderr, exitCode }) は、指定した出力と終了コードで終わる nx を置く。
// - installFakeExecutable(bin, name, body) は、任意の sh の本体を持つ実行ファイルを置く。
// - prependToPath(bin) は、process.env.PATH の先頭に bin を足す。
// - 元へ戻すのは、useIsolatedEnvironment の afterEach。
// - readFakeCalls(bin, name) は、呼ばれた引数の列を返す。1 呼び出しが 1 要素になる。
// 呼び出しは bin/name.calls に、1 行ずつ JSON の配列で記録される。
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', String.raw`'\''`)}'`
}

/**
bin/<name> に sh の実行ファイルを置く。呼び出しの引数は bin/<name>.calls に JSON 配列で 1 行ずつ追記する
*/
export function installFakeExecutable(bin: string, name: string, body: string): string {
  const callsFile = path.join(bin, `${name}.calls`)
  // 引数の JSON 化は sh だけで行い、node には依存しない。二重引用符とバックスラッシュはエスケープする
  const record = `{ printf '['; first=1; for a in "$@"; do e=$(printf '%s' "$a" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'); if [ $first = 1 ]; then first=0; else printf ','; fi; printf '"%s"' "$e"; done; printf ']\\n'; } >> ${shellQuote(callsFile)}\n`
  const target = path.join(bin, name)
  writeFileSync(target, `#!/bin/sh\n${record}${body}`)
  chmodSync(target, 0o755)
  return target
}

export function installFakeGh(bin: string, options: { readonly token?: string } = {}): string {
  const { token } = options
  const body = token === undefined
    ? 'exit 1\n'
    : `if [ "$1" = auth ] && [ "$2" = token ]; then printf '%s\\n' ${shellQuote(token)}; exit 0; fi\nexit 1\n`
  return installFakeExecutable(bin, 'gh', body)
}

export function installFakeNx(bin: string, options: { readonly stdout?: string, readonly stderr?: string, readonly exitCode?: number } = {}): string {
  const { stdout = '', stderr = '', exitCode = 0 } = options
  const body = `printf '%s' ${shellQuote(stdout)}\nprintf '%s' ${shellQuote(stderr)} >&2\nexit ${String(exitCode)}\n`
  return installFakeExecutable(bin, 'nx', body)
}

export function prependToPath(bin: string): void {
  process.env['PATH'] = `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`
}

export function readFakeCalls(bin: string, name: string): readonly (readonly string[])[] {
  const callsFile = path.join(bin, `${name}.calls`)
  const lines = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n') : []
  // eslint-disable-next-line no-restricted-syntax -- 自分で書いた文字列配列の JSON。直後に使うだけ
  return lines.filter(line => line !== '').map(line => JSON.parse(line) as readonly string[])
}

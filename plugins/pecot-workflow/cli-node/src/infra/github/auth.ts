/* eslint-disable security/detect-non-literal-fs-filename -- パスは設定ディレクトリ配下のファイルと、呼び出し側が渡す .env */
// GitHub トークン解決に使うホスト設定と .env の読み書き。cli/core/github/auth.py の移植。

import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { InvalidValueError } from '../../domain/errors.js'
import { isJsonObject, jsonField, parseJsonText } from '../../domain/json.js'
import type { JsonObject } from '../../domain/json.js'
import type { JsonValue } from '../../domain/python-format.js'
import { isJsonArray, pythonRepr, pythonStrip, pythonStringRepr } from '../../domain/python-format.js'
import { configDirectory } from '../config-store.js'
import { toOsError } from '../os-error.js'
import { readTextFile } from '../text-file.js'

/**
str(value) と同じ。文字列はそのまま、それ以外は repr
*/
export function pythonString(value: JsonValue): string {
  return typeof value === 'string' ? value : pythonRepr(value)
}

// ホスト設定のキャッシュ（モジュールレベル）
const hostsCache: { value: JsonObject | undefined } = { value: undefined }

/**
環境変数の値。無ければ undefined。

名前が実行時に決まるので、環境変数の名前を添字で直接書く形では読めない。
名前の元は、hosts.json の env_var、ホストから作る `PECOT_GITHUB_<HOST>_TOKEN`、ROOT_ENV_VAR_MAP。
環境変数の宣言の確認（.githooks/tests/test_nx_env_inputs.py）は、この読み方を検出できない。
宣言できない代わりに、テストが結果をトークンの値に依存させない。
テストは token を明示して渡すか、トークンの変数を自分で設定する。
トークンの変数を外す隔離は tests/_helpers/environment.ts の useIsolatedEnvironment が行う。
*/
export function environmentValue(name: string): string | undefined {
  // interface-env: PECOT_GITHUB_*_TOKEN GITHUB_COM_TOKEN
  return new Map(Object.entries(process.env)).get(name)
}

/**
ホスト設定をロードする（キャッシュ付き）。
設定ディレクトリの hosts.json を読む。ファイルが無ければ空の設定。
最上位が JSON のオブジェクトでないときは、空の設定として扱う
*/
export function loadHostsConfig(): JsonObject {
  if (hostsCache.value !== undefined) return hostsCache.value
  const hostsFile = path.join(configDirectory(), 'hosts.json')
  let loaded: JsonObject = { hosts: {} }
  if (existsSync(hostsFile)) {
    const parsed = parseJsonText(readTextFile(hostsFile))
    loaded = isJsonObject(parsed) ? parsed : {}
  }
  hostsCache.value = loaded
  return loaded
}

/**
ホスト設定のキャッシュを捨てる（テスト用）
*/
export function clearHostsConfigCache(): void {
  hostsCache.value = undefined
}

/**
ホストの設定（env_var・token_url・description・scopes）。無い、または空のオブジェクトなら undefined
*/
export function getHostConfig(host: string): JsonObject | undefined {
  const hosts = jsonField(loadHostsConfig(), 'hosts')
  const entry = isJsonObject(hosts) ? jsonField(hosts, host) : undefined
  return isJsonObject(entry) && Object.keys(entry).length > 0 ? entry : undefined
}

// Python の dict の添字参照が KeyError になる所。str(KeyError) と同じ文にする
function requiredField(config: JsonObject, key: string): JsonValue {
  const value = jsonField(config, key)
  if (value === undefined) throw new InvalidValueError(pythonStringRepr(key))
  return value
}

/**
hosts.json に定義が無いときの既定の環境変数名。hosts.json.sample・.env.sample と同じ名前。
hosts.json はリポに含まれないため、Actions などの新しい checkout ではこの名前を使う
*/
export const DEFAULT_ENV_VAR_MAP: ReadonlyMap<string, string> = new Map([
  ['github.com', 'PECOT_GITHUB_COM_TOKEN'],
])

/**
ホストに対応する環境変数名。hosts.json の定義、既定の対応、`PECOT_GITHUB_<HOST>_TOKEN`（ドットはアンダースコア）の順に使う
*/
export function getEnvironmentVariableName(host: string): string {
  const hostConfig = getHostConfig(host)
  return hostConfig === undefined
    ? DEFAULT_ENV_VAR_MAP.get(host) ?? `PECOT_GITHUB_${host.toUpperCase().replaceAll('.', '_')}_TOKEN`
    : pythonString(requiredField(hostConfig, 'env_var'))
}

// ルート .env の変数名マッピング（ホスト → ルート .env の変数名）。MCP ラッパーと同じトークンソースを参照するための定義
export const ROOT_ENV_VAR_MAP: ReadonlyMap<string, string> = new Map([
  ['github.com', 'GITHUB_COM_TOKEN'],
])

/**
環境変数ファイルを読み、実行中の環境に設定する。Python の load_env_file と同じく環境を書き換える。
KEY=VALUE 形式で、空行と # で始まる行は飛ばす。既にある環境変数は上書きしない
*/
export function loadEnvironmentFile(file: string): void {
  if (!existsSync(file)) return
  for (const rawLine of readTextFile(file).split('\n')) {
    const line = pythonStrip(rawLine)
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = pythonStrip(line.slice(0, separator))
    const value = pythonStrip(line.slice(separator + 1))
    // interface-env: none
    if (key !== '' && !Object.hasOwn(process.env, key)) Reflect.set(process.env, key, value)
  }
}

/**
トークンの取得先 URL（hosts.json の token_url、無ければ設定画面の URL）
*/
export function tokenUrlFor(host: string): string {
  const hostConfig = getHostConfig(host)
  return hostConfig === undefined ? `https://${host}/settings/tokens` : pythonString(requiredField(hostConfig, 'token_url'))
}

/**
hosts.json の scopes。無い、または配列でないときは空
*/
export function scopesFor(host: string): readonly string[] {
  const hostConfig = getHostConfig(host)
  const scopes = hostConfig === undefined ? undefined : jsonField(hostConfig, 'scopes')
  return isJsonArray(scopes) ? scopes.map(scope => pythonString(scope)) : []
}

function environmentEntry(host: string): string {
  const hostConfig = getHostConfig(host)
  const description = hostConfig === undefined ? host : pythonString(requiredField(hostConfig, 'description'))
  const scopes = scopesFor(host)
  const scopesComment = scopes.length > 0 ? `# 必要なスコープ: ${scopes.join(', ')}` : ''
  return `\n# ${description}\n# 取得先: ${tokenUrlFor(host)}\n${scopesComment}\n${getEnvironmentVariableName(host)}=\n`
}

const ENVIRONMENT_FILE_HEADER = `# pecot-cli 認証設定
# 各トークンの値を設定してください
#
# トークン作成時は必要なスコープを付与してください
`

/**
認証用の .env を生成または更新して、そのパスを返す。
無ければ新規作成する。あるときは、ホストの環境変数名が書かれていない場合だけ追記する
*/
export function ensureEnvironmentFile(host: string): string {
  const file = path.join(configDirectory(), '.env')
  const name = getEnvironmentVariableName(host)
  const entry = environmentEntry(host)
  try {
    if (!existsSync(file)) writeFileSync(file, ENVIRONMENT_FILE_HEADER + entry, 'utf8')
    else if (!readTextFile(file).includes(name)) appendFileSync(file, entry, 'utf8')
  }
  catch (error: unknown) {
    throw toOsError(error)
  }
  return file
}

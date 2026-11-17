// Git リモート URL の解析。git-clone の GIT URLS（スキーム付きと scp 風）から (host, owner, repository) を取り出す。

import { InvalidValueError } from './errors.js'
import { pythonStrip } from './python-format.js'

export class RemoteUrlFormatError extends InvalidValueError {}

export interface RemoteLocation {
  readonly host: string
  readonly owner: string
  readonly repository: string
}

// eslint-disable-next-line security/detect-unsafe-regex -- 入力はリモート URL 1 本で、バックトラックの幅は URL の長さに収まる
const SCHEME_URL_PATTERN = /^(?:https?|ssh|git|ftps?):\/\/(?:[^/@]+@)?([^/:@]+)(?::\p{Nd}+)?\/([^/~][^/]*)\/([^/]+?)(?:\.git)?\/?$/u
// eslint-disable-next-line security/detect-unsafe-regex -- 入力はリモート URL 1 本で、バックトラックの幅は URL の長さに収まる
const SCP_LIKE_URL_PATTERN = /^(?:[^@/:]+@)?([^/:@]+):\/?([^/~][^/]*)\/([^/]+?)(?:\.git)?\/?$/u
const USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/iu

/**
リモート URL を分ける。前後の空白は除く。
対応する形式は次の 2 つ。
- スキーム付き: `(http|https|ssh|git|ftp|ftps)://[userinfo@]host[:port]/owner/repo[.git][/]`。
- scp 風: `[user@]host:[/]owner/repo[.git][/]`。
*/
export function parseRemoteUrl(url: string): RemoteLocation {
  const trimmed = pythonStrip(url)
  for (const pattern of [SCHEME_URL_PATTERN, SCP_LIKE_URL_PATTERN]) {
    const [, host, owner, repository] = pattern.exec(trimmed) ?? []
    if (host !== undefined && owner !== undefined && repository !== undefined) {
      return { host, owner, repository }
    }
  }
  // エラー文に認証情報（userinfo）を出さない
  throw new RemoteUrlFormatError(`unexpected remote URL format: ${trimmed.replace(USERINFO_PATTERN, '$1')}`)
}

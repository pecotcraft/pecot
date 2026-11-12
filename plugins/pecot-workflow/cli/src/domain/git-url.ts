// Git リモート URL の解析。HTTPS / SSH 形式から (host, owner, repository) を取り出す。

import { InvalidValueError } from './errors.js'
import { pythonStrip } from './python-format.js'

export class RemoteUrlFormatError extends InvalidValueError {}

export interface RemoteLocation {
  readonly host: string
  readonly owner: string
  readonly repository: string
}

const HTTPS_URL_PATTERN = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/u
const SSH_URL_PATTERN = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/u
const USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/iu
// eslint-disable-next-line security/detect-unsafe-regex -- 入力はリモート URL 1 本で、バックトラックの幅は URL の長さに収まる
const SSH_SCHEME_URL_PATTERN = /^ssh:\/\/(?:[^@/]+@)?([^/:@]+)(?::\p{Nd}+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u

/**
リモート URL を分ける。前後の空白は除く。
対応する形式は次の 3 つ。
- 形式 1: `https://host/owner/repo[.git]`。
- 形式 2: `git@host:owner/repo[.git]`。
- 形式 3: `ssh://[user@]host[:port]/owner/repo[.git][/]`。
*/
export function parseRemoteUrl(url: string): RemoteLocation {
  const trimmed = pythonStrip(url)
  for (const pattern of [HTTPS_URL_PATTERN, SSH_URL_PATTERN, SSH_SCHEME_URL_PATTERN]) {
    const [, host, owner, repository] = pattern.exec(trimmed) ?? []
    if (host !== undefined && owner !== undefined && repository !== undefined) {
      // https://user:token@host/... の userinfo は host に含めない
      return { host: host.slice(host.lastIndexOf('@') + 1), owner, repository }
    }
  }
  // エラー文に認証情報（userinfo）を出さない
  throw new RemoteUrlFormatError(`unexpected remote URL format: ${trimmed.replace(USERINFO_PATTERN, '$1')}`)
}

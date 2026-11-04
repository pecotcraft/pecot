// MCP ツールのパス引数に渡された Windows 形式のパスを、WSL 側の POSIX パスへ変換する。
//
// 配布 README は Windows の MCP クライアントに WSL2 経由 (`wsl npx ...`) での起動を案内している。
// だがクライアントが組み立てるパスは `C:\Users\...` 形式になる。
// POSIX では `C:\...` は絶対パスと判定されない。
// 変換を挟まないと FR-011 の絶対パス確認 (src/mcp/result.ts) が実処理の前に全て弾いてしまう。
// 変換するのは入力側だけ。応答の artifacts / data には変換後の POSIX パスをそのまま載せる。
// Windows 形式への逆変換はしない。
//
// 変換後のパスは `..` を含むと mount root の外へ出うる (`C:\..\..\etc` → `/etc`)。FR-011 と
// 同じく cwd の曖昧さを排除するための変換であって、アクセス範囲を制限する境界ではない。

import path from 'node:path'

/**
WSL が標準で Windows のドライブを mount する場所。
*/
const DEFAULT_MOUNT_ROOT = '/mnt'

/**
ドライブの mount root を上書きする環境変数。`/etc/wsl.conf` の automount root を既定から変えた環境向け。
*/
export const MOUNT_ROOT_ENV = 'PECOTV_WSL_MOUNT_ROOT'

/**
ドライブレター + 区切り (`C:\...` / `C:/...`)。区切りまでを見て、以降を丸ごと残す。
*/
const DRIVE_ABSOLUTE_REGEX = /^([a-z]):[/\\](.*)$/is

/**
区切りを伴わないドライブ指定 (`C:relative`)。cwd 依存なので解決できない。
*/
const DRIVE_RELATIVE_REGEX = /^[a-z]:/i

/**
WSL の filesystem を指す UNC の接頭辞。
形式は `\\wsl$\<distro>\...` と `\\wsl.localhost\<distro>\...`。
スラッシュ表記の `//wsl$/...` と `//wsl.localhost/...` も含む。

先頭 2 区切りと distro 名直後の区切りをそれぞれ `[\\/]` で受理し、バックスラッシュ・
スラッシュどちらの表記も同じルートへ寄せる。`i` フラグは、Windows のホスト名が
大文字小文字を区別しないこと (`\\WSL$\...` 等) に、distro 名の一致確認 (`toLowerCase()`) を
揃えるため。

distro 名と残りの分割は正規表現に載せず fromWslUnc 側の手続きで行う。数量子を 2 つ
並べた形は静的解析が backtracking の危険と読むため、切り出しは手続きで書く。
*/
const WSL_UNC_PREFIX_REGEX = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]/i

/**
一般 UNC (`\\server\share\...` / `//server/share/...`) の接頭辞。
*/
const UNC_PREFIX_REGEX = /^[\\/]{2}/

/**
変換の結果。`unchanged` は POSIX パス・相対パスなど「Windows 形式ではない」入力。
*/
export type PathConversion
  = | { readonly kind: 'converted', readonly path: string }
    | { readonly kind: 'unchanged' }
    | { readonly kind: 'unsupported', readonly reason: string }

/**
Windows 形式のパスを POSIX パスへ変換する。

ドライブレター形式は WSL 判定に依存せず無条件で変換する (`C:\...` は POSIX の絶対パスと
衝突せず、非 WSL ホストで受け取っても解釈は 1 通りしかない)。`path.win32.isAbsolute` は
`\a\b` のようなルート相対も絶対と判定するため使わない。

UNC 形式は、参照先の distro が自分自身のときだけ WSL 内のパスへ畳める。他の distro の
filesystem はこのプロセスから見えないため、解決できない旨を返す。
*/
export function toPosixPath(
  value: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PathConversion {
  const drive = DRIVE_ABSOLUTE_REGEX.exec(value)
  if (drive !== null) {
    const [, letter = '', rest = ''] = drive
    return {
      kind: 'converted',
      path: path.posix.normalize(`${resolveMountRoot(environment)}/${letter.toLowerCase()}/${toPosixSeparators(rest)}`),
    }
  }

  if (DRIVE_RELATIVE_REGEX.test(value)) {
    return {
      kind: 'unsupported',
      reason: `ドライブ相対パス '${value}' は cwd 依存のため解決できません`
        + ' (ドライブレターの直後に区切りを置いた絶対パスで指定してください)',
    }
  }

  const uncPrefix = WSL_UNC_PREFIX_REGEX.exec(value)
  if (uncPrefix !== null) return fromWslUnc(value.slice(uncPrefix[0].length), environment)

  if (UNC_PREFIX_REGEX.test(value)) {
    return {
      kind: 'unsupported',
      reason: `UNC パス '${value}' は解決できません`
        + ' (WSL から見える絶対パス、またはドライブレター形式で指定してください)',
    }
  }

  return { kind: 'unchanged' }
}

/**
`\\wsl$\` の後ろ (`<distro>\...`) を、この distro の POSIX 絶対パスへ畳む。
*/
function fromWslUnc(
  body: string,
  environment: Readonly<Record<string, string | undefined>>,
): PathConversion {
  // ドライブレター形式 (`[/\\]` で両区切りを受理) と同じく、distro 名の後ろも
  // バックスラッシュ・スラッシュどちらの区切りも受理する (混在表記を落とさない)。
  const separator = body.search(/[\\/]/)
  const distro = separator === -1 ? body : body.slice(0, separator)
  const rest = separator === -1 ? '' : body.slice(separator + 1)
  const current = environment['WSL_DISTRO_NAME']
  if (current?.toLowerCase() !== distro.toLowerCase()) {
    return {
      kind: 'unsupported',
      reason: `このサーバは distro '${current ?? '(WSL_DISTRO_NAME 未設定)'}' で動作しており、`
        + `distro '${distro}' のパスは解決できません`,
    }
  }
  return { kind: 'converted', path: path.posix.normalize(`/${toPosixSeparators(rest)}`) }
}

/**
区切りを POSIX 側へ寄せる。連続した区切りは normalize が畳む。
*/
function toPosixSeparators(value: string): string {
  return value.replaceAll('\\', '/')
}

/**
ドライブを mount する root。

環境変数が絶対パスのときだけ採る。未設定・空・非絶対のときに既定へ倒すのは、
誤設定で相対パスが組み上がると FR-011 の確認で弾かれ、原因が分かりにくくなるため。
*/
function resolveMountRoot(environment: Readonly<Record<string, string | undefined>>): string {
  // `/etc/wsl.conf` の `[automount] root` を既定から変えた環境向けの逃がし先。
  // eslint-disable-next-line security/detect-object-injection -- MOUNT_ROOT_ENV は本ファイルが export する固定の定数
  const configured = environment[MOUNT_ROOT_ENV]
  return configured !== undefined && path.posix.isAbsolute(configured) ? configured : DEFAULT_MOUNT_ROOT
}

// flock(1) による取得の排他制御。
//
// 永続層へ書き込む取得は 2 系統ある (Playwright Chromium と実行時依存の npm install)。
// 単体配布形態では MCP クライアントごとに別プロセスが立ち、同じ領域へ 2 本が同時に
// 動き得るため、どちらも同じ primitive (flock(2)) で保護する。待ち方・上限・
// 「ロック待ち超過」を取得失敗と区別する exit code を 1 か所に置き、2 系統で揃える。
//
// flock(1) は util-linux 前提で macOS 等には無い。無い環境ではロックなしで動く
// (bin/pecotv の bootstrap も同じフォールバックを取る)。

import { spawnSync } from 'node:child_process'

/**
取得ロックの待ち上限 (秒)。

先行プロセスが取得中なら待てば済むが、無期限に待つと呼び出し元には
「無応答」としか見えない。計測 33 秒 (chromium) / 37 秒 (実行時依存) の取得を
待ち切れる長さに留め、超えたら「別プロセスが取得中」と分かる応答を返して
呼び出し元に再実行を委ねる。
*/
export const LOCK_WAIT_SECONDS = 60

/**
ロック待ちが上限を超えたときに flock(1) が返す exit code (`-E` で指定する)。

取得コマンド自身の exit code と衝突しない値を選ぶ (playwright install / npm install の
失敗はいずれも 1)。
*/
export const LOCK_CONFLICT_EXIT_CODE = 75

/**
flock(1) が使えるか。util-linux 前提のため macOS 等では不在になる。
*/
export function hasFlockCommand(): boolean {
  const result = spawnSync('flock', ['--version'], { stdio: 'ignore' })
  return result.status === 0
}

/**
spawnPromise へそのまま渡せる起動指定。
*/
export interface LockedCommand {
  readonly command: string
  readonly commandArguments: readonly string[]
}

/**
`command commandArguments` を flock 越しに起動する形へ包む。

ロックの置き場所が決まらない (`lockPath` が undefined) 環境と flock(1) が無い環境では
包まずに返す。flock(1) は親ディレクトリが無いとロックファイルを作れず exit 66 で
終わるため、場所が決まらないときにパスを組み立てて渡すと取得そのものが必ず失敗する。

`-F` を付けて fork させない。
既定の flock は fork して子で exec する。
そのため、タイムアウトで flock に SIGTERM を送っても、
取得コマンド側が孤児として生き残り、継承した fd 越しにロックを保持し続ける。
`-w` / `-E` はロック待ちの上限と、上限超過を取得失敗と区別するための exit code。
*/
export function withFlock(
  lockPath: string | undefined,
  command: string,
  commandArguments: readonly string[],
): LockedCommand {
  if (lockPath === undefined || !hasFlockCommand()) return { command, commandArguments }
  return {
    command: 'flock',
    commandArguments: [
      '-w', String(LOCK_WAIT_SECONDS),
      '-E', String(LOCK_CONFLICT_EXIT_CODE),
      '-F',
      lockPath,
      command,
      ...commandArguments,
    ],
  }
}

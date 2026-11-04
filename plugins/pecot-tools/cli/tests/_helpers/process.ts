// プロセスの生死判定。infra の単体テスト（子プロセスの SIGTERM）と e2e（サーバの自力終了・
// 孤児化した孫の後始末）で同じ判定を使うため、1 箇所に置く。

import { readFileSync } from 'node:fs'

/**
プロセスが消えているか（kill(pid, 0) が ESRCH を返すか）。
*/
export function isReaped(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  }
  catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

/**
`/proc/<pid>/stat` の state（1 文字）。読めなければ undefined。
*/
function processState(pid: number): string | undefined {
  let stat: string
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pid は本ヘルパの引数のみ
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  }
  catch {
    return undefined
  }
  // comm には空白や ')' が入り得るため、最後の ')' の後ろから読む。
  return stat.slice(stat.lastIndexOf(')') + 1).trim().charAt(0)
}

/**
プロセスが動いていないか（消えている、または終了済みで回収待ちの zombie）。

親が先に終了した孫は PID 1 へ再親付けされる。devcontainer の PID 1 は素の sh で wait を
呼ばないため、終了した孫は回収されず zombie のまま残り kill(pid, 0) は成功してしまう。
「消えた」だけを見ると落ちるので、zombie も終了として扱う。
*/
export function isTerminated(pid: number): boolean {
  return isReaped(pid) || processState(pid) === 'Z'
}

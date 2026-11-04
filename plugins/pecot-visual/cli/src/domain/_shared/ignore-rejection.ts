/**
promise の完了を待ち、失敗は捨てる。後始末など、失敗が呼び出し側の結果を左右しない処理で使う。
*/
export async function ignoreRejection(promise: PromiseLike<unknown>): Promise<void> {
  try {
    await promise
  }
  catch {
    // 呼び出し側は失敗を扱わない契約のため、理由は捨てる。
  }
}

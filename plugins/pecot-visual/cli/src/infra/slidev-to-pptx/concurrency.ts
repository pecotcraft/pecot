/**
並列度を制限してタスクを実行する純粋制御フロー。Promise.allSettled 形式で全結果を返す。
*/
export async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: Promise<T>[] = []
  const executing = new Set<Promise<T>>()
  for (const task of tasks) {
    // 自分自身を executing から外すため、完了時に参照できる入れ物へ promise を置く。
    const slot: { promise?: Promise<T> } = {}
    const p = (async () => {
      try {
        return await task()
      }
      finally {
        if (slot.promise !== undefined) executing.delete(slot.promise)
      }
    })()
    slot.promise = p
    executing.add(p)
    results.push(p)
    if (executing.size >= concurrency) {
      try {
        await Promise.race(executing)
      }
      catch {
        // 個々の失敗は末尾の Promise.allSettled が返すため、ここでは待ち合わせだけを行う。
      }
    }
  }
  return Promise.allSettled(results)
}

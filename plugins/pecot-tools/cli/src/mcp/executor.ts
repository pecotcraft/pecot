// 上限付き並行実行器（FR-018 / research R9）。
//
// MCP の Protocol 層は受信したリクエストを並行に捌く。
// そのためツールハンドラを run() で包み、「同時に実行されるのは limit 件まで」を保証する。
// awscli の各呼び出しは独立プロセスなので、逐次化までは要らない。
// 上限だけを構造的に強制する（ツール実装側の善意には依存しない）。

export interface BoundedExecutor {
  /**
  task を上限内で実行し、その結果を返す。

  - 枠が空いていれば即座に、埋まっていれば到着順（FIFO）で待ってから実行する。
  - task の失敗は呼び出し元へそのまま伝播する。枠は finally で解放するので、後続は実行される。
  */
  run<T>(task: () => Promise<T>): Promise<T>
}

/**
同時実行数 limit の実行器を生成する。
*/
export function createBoundedExecutor(limit: number): BoundedExecutor {
  let active = 0
  const waiting: (() => void)[] = []

  // 枠の取得までは呼び出しと同じ tick で実行されるため、active の増加と waiting への積み方が到着順になる。
  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1
      return
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve)
    })
  }

  // 待機列があれば枠を明け渡す（active は減らさない）。無ければ枠を返す。
  const release = (): void => {
    const next = waiting.shift()
    if (next === undefined) {
      active -= 1
      return
    }
    next()
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await task()
      }
      finally {
        release()
      }
    },
  }
}

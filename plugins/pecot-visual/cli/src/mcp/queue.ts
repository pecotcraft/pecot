// MCP ツール実行の逐次化キュー (FR-012)。
//
// MCP の Protocol 層は受信したリクエストを並行に捌くため、ツールハンドラ本体を
// enqueue で包むことで「同時に動くのは 1 件」を保証する。Playwright / soffice /
// slidev build を起こすツールが同時多発すると CPU とポートを奪い合うため、
// サーバ側で直列化する。
//
// キューの所有者は createMcpServer() で、サーバ 1 インスタンスにつき 1 本を生成し、
// registerTool するハンドラをそこで enqueue に包む。ツール実装側はキューを受け取らない
// (直列化はサーバ側の構造で保証し、ツール実装の善意に依存させない)。

import { AsyncLocalStorage } from 'node:async_hooks'

/**
走行中タスクからの再 enqueue を検知したときに投げる例外。
*/
export class ReentrantEnqueueError extends Error {
  constructor() {
    super('enqueue cannot be called from a running task (the queue would deadlock waiting for itself)')
    this.name = 'ReentrantEnqueueError'
  }
}

export interface ExecutionQueue {
  /**
  task を FIFO で直列実行し、その結果を返す。

  - 実行順は enqueue の呼び出し順で、前タスクの完了 (成功・失敗どちらも) を待ってから動く。
  - task の失敗は呼び出し元へそのまま伝播する。内部チェーンは切れず、後続は実行される。
  - **再入禁止**: 走行中の task の中から同じキューへ enqueue できない。
    前タスク (= 自分自身) の完了待ちに入って永久にデッドロックするため、
    待たずに ReentrantEnqueueError を投げて即座に失敗させる。
  */
  enqueue<T>(task: () => Promise<T>): Promise<T>
}

/**
逐次実行キューを生成する。
*/
export function createExecutionQueue(): ExecutionQueue {
  // tail は「直前にキューへ入ったタスクの完了」を表す。reject させない
  // (完了時に resolve するだけの gate) ことで、失敗したタスクが後続を巻き込まない。
  let tail: Promise<void> = Promise.resolve()

  // task の実行を AsyncLocalStorage の中で実行し、その async context から再 enqueue された
  // 呼び出しを識別する。task が await / setTimeout を挟んでも context は引き継がれるため、
  // キューが「実行中」かではなく、「タスクの実行文脈から呼ばれた」かで判定できる。
  const insideTask = new AsyncLocalStorage<true>()

  return {
    async enqueue<T>(task: () => Promise<T>): Promise<T> {
      // tail を差し替える前に弾く。差し替えてしまうと以降の enqueue が
      // 二度と解放されない gate を待つことになる。
      if (insideTask.getStore() === true) {
        throw new ReentrantEnqueueError()
      }

      // ここまでは enqueue 呼び出しと同じ tick で動くため、tail の差し替え順 = 到着順になる。
      const previous = tail
      const gate: PromiseWithResolvers<void> = Promise.withResolvers()
      tail = gate.promise

      await previous
      try {
        // task が Promise を返す前に同期 throw しても finally で gate は解放される。
        return await insideTask.run(true, task)
      }
      finally {
        gate.resolve()
      }
    },
  }
}

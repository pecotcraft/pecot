// 子プロセス起動の結果型。stdout / stderr は capture 済の文字列。
// timedOut が true なら SIGTERM 後の状態。exitCode は process exit code。
// signal 終了時は null を取り得るため、型は number | null。
//
// 旧 `SubprocessResult` (domain/ports.ts) を rename + 独立 domain 型として切り出した。
// 次の 2 箇所で共有される。
// `infra/_shared/process.ts` の `spawnPromise`。
// `infra/slidev-to-pptx/runner.ts` の `SlidevRunner.build()` の戻り値型。

export interface SpawnResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

// `slidev build` を子プロセスで起動する SlidevRunner 実装。
// `@slidev/cli` の bin を依存ルート (infra/_shared/dependency-root.ts) から解決し、
// `node <slidev-bin>` で起動する。プラグイン形態では cli の direct dep として hoist された
// 実体が、単体配布形態では `setup` が置いた永続層の実体が引かれる。利用者 project 側に
// slidev bin が無くても動作する。bin の解決そのものは dev サーバ起動 (mcp/dev-server-registry.ts)
// と共有するため infra/_shared/slidev-bin.ts に置く。
// `--theme` は command 側で許容文字 validate 済の前提で受け取る。

import type { SlidevRunner } from '../../domain/_shared/ports.js'
import type { SpawnResult } from '../../domain/_shared/spawn-result.js'
import { spawnPromise } from '../_shared/process.js'
import { resolveSlidevBin } from '../_shared/slidev-bin.js'

export type SlidevBinResolver = () => string

export class ChildProcessSlidevRunner implements SlidevRunner {
  private readonly resolveBin: SlidevBinResolver

  public constructor(resolver: SlidevBinResolver = resolveSlidevBin) {
    this.resolveBin = resolver
  }

  async build(
    projectDirectory: string,
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- stream は mutable 型
    options: Readonly<{
      theme?: string
      timeoutMs: number
      stdout?: NodeJS.WritableStream
      stderr?: NodeJS.WritableStream
      signal?: AbortSignal
    }>,
  ): Promise<SpawnResult> {
    const slidevBin = this.resolveBin()
    const arguments_: string[] = [slidevBin, 'build']
    if (options.theme !== undefined) {
      arguments_.push('--theme', options.theme)
    }
    const spawnOptions: {
      cwd: string
      env: NodeJS.ProcessEnv
      timeoutMs: number
      stdoutRelay?: NodeJS.WritableStream
      stderrRelay?: NodeJS.WritableStream
      signal?: AbortSignal
    } = {
      cwd: projectDirectory,
      // interface-env: none
      env: process.env,
      timeoutMs: options.timeoutMs,
    }
    if (options.stdout !== undefined) spawnOptions.stdoutRelay = options.stdout
    if (options.stderr !== undefined) spawnOptions.stderrRelay = options.stderr
    if (options.signal !== undefined) spawnOptions.signal = options.signal
    return spawnPromise(process.execPath, arguments_, spawnOptions)
  }
}

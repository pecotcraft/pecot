// ChildProcessSlidevRunner: `node <slidev-bin> build` 起動の引数組立てと spawn ルートを確認する。
// `@slidev/cli` の本物 bin は重い (Slidev 全体を解決する)。
// そのため SlidevBinResolver port で、fake bin (引数を echo して exit する node script) を inject して挙動を確認する。

// 全ての fs path は temp ディレクトリ由来でリテラルではないため、ファイル全体で許可する。
/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { ChildProcessSlidevRunner } from '../../../src/infra/slidev-to-pptx/runner.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'
import { explains } from '../../_helpers/explains.js'

const temporaryRoot = useTemporaryDirectory('pecotv-slidev-runner-')

afterEach(() => {
  rmSync(temporaryRoot(), { recursive: true, force: true })
})

/**
引数列を `args=...` で stdout に echo してから、指定 exit code で終了する fake slidev bin を生成する。
実体は node script で、その path を返す。
*/
function installFakeSlidevBin(stdoutMessage: string, exitCode: number): string {
  const binPath = temporaryRoot('fake-slidev.mjs')
  const script
    = `#!/usr/bin/env node\n`
      + `console.log(${JSON.stringify(stdoutMessage)});\n`
      + `console.log('args=' + process.argv.slice(2).join(' '));\n`
      + `process.exit(${String(exitCode)});\n`
  writeFileSync(binPath, script)
  return binPath
}

describe('ChildProcessSlidevRunner', () => {
  it('成功した場合は、終了コード 0 と標準出力を取得する', async () => {
    await explains('`ChildProcessSlidevRunner` のビルドのテストです。成功する偽の slidev を実行した場合に、終了コードが 0 で、標準出力に偽の slidev の出力と `args=build` が含まれることを確認します。')
    const binPath = installFakeSlidevBin('FAKE-SLIDEV-BUILD', 0)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { timeoutMs: 10_000 })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('FAKE-SLIDEV-BUILD')
    expect(result.stdout).toContain('args=build')
  })

  it('theme を指定すると、引数に --theme とテーマの名前を渡す', async () => {
    await explains('`ChildProcessSlidevRunner` の引数のテストです。`theme` に `sample-theme` を指定した場合に、起動した slidev の引数が `build --theme sample-theme` になることを確認します。')
    const binPath = installFakeSlidevBin('OK', 0)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { theme: 'sample-theme', timeoutMs: 10_000 })

    expect(result.stdout).toContain('args=build --theme sample-theme')
  })

  it('失敗した場合は、そのときの終了コードを返す', async () => {
    await explains('`ChildProcessSlidevRunner` のビルドのテストです。終了コード 7 で終わる偽の slidev を実行した場合に、結果の終了コードが 7 になることを確認します。')
    const binPath = installFakeSlidevBin('NG', 7)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { timeoutMs: 10_000 })
    expect(result.exitCode).toBe(7)
  })

  it('タイムアウトを過ぎると、timedOut を true にする', async () => {
    await explains('`ChildProcessSlidevRunner` のタイムアウトのテストです。終了しない偽の slidev に 100 ミリ秒のタイムアウトを指定した場合に、`timedOut` が `true` になることを確認します。')
    const binPath = temporaryRoot('fake-slidev-slow.mjs')
    writeFileSync(binPath, `#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 30000);\n`)

    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
  }, 15_000)

  it('signal を中断すると、子プロセスを止め、タイムアウトを待たずに返る', async () => {
    await explains('`ChildProcessSlidevRunner` の中断のテストです。200 ミリ秒後に中断する `signal` を渡した場合に、タイムアウトを待たずに返り、`timedOut` が `false` で、`signal` が `SIGTERM` になることを確認します。')
    const binPath = temporaryRoot('fake-slidev-slow-abort.mjs')
    writeFileSync(binPath, `#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 30000);\n`)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { timeoutMs: 20_000, signal: AbortSignal.timeout(200) })

    expect(result.timedOut).toBe(false)
    expect(result.signal).toBe('SIGTERM')
  }, 15_000)

  it('標準出力と標準エラーの転送先を指定すると、出力を転送する', async () => {
    await explains('`ChildProcessSlidevRunner` の出力の転送のテストです。標準出力と標準エラーの転送先を指定した場合に、終了コードが 0 で、転送先に偽の slidev の出力 `RELAYED` が含まれることを確認します。')
    const binPath = installFakeSlidevBin('RELAYED', 0)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const chunks: string[] = []
    const stdout = {
      write(data: string | Readonly<Buffer>): boolean {
        chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
        return true
      },
    }
    // eslint-disable-next-line no-restricted-syntax -- test 内 stub を WritableStream として narrowing
    const stdoutStream = stdout as unknown as NodeJS.WritableStream

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, {
      timeoutMs: 10_000,
      stdout: stdoutStream,
      stderr: stdoutStream,
    })
    expect(result.exitCode).toBe(0)
    expect(chunks.join('')).toContain('RELAYED')
  })
})

// ChildProcessSlidevRunner: `node <slidev-bin> build` 起動の引数組立てと spawn ルートを確認する。
// `@slidev/cli` の本物 bin は重い (Slidev 全体を解決する)。
// そのため SlidevBinResolver port で、fake bin (引数を echo して exit する node script) を inject して挙動を確認する。

// 全ての fs path は temp ディレクトリ由来でリテラルではないため、ファイル全体で許可する。
/* eslint-disable security/detect-non-literal-fs-filename */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { ChildProcessSlidevRunner } from '../../../src/infra/slidev-to-pptx/runner.js'
import { useTemporaryDirectory } from '../../_helpers/temporary-directory.js'

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
  it('成功時に exitCode=0 / stdout を capture する', async () => {
    const binPath = installFakeSlidevBin('FAKE-SLIDEV-BUILD', 0)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { timeoutMs: 10_000 })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('FAKE-SLIDEV-BUILD')
    expect(result.stdout).toContain('args=build')
  })

  it('--theme 指定時に args へ "--theme <name>" が含まれる', async () => {
    const binPath = installFakeSlidevBin('OK', 0)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { theme: 'sample-theme', timeoutMs: 10_000 })

    expect(result.stdout).toContain('args=build --theme sample-theme')
  })

  it('failure exit code を返す', async () => {
    const binPath = installFakeSlidevBin('NG', 7)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { timeoutMs: 10_000 })
    expect(result.exitCode).toBe(7)
  })

  it('timeout 経過時 timedOut=true', async () => {
    const binPath = temporaryRoot('fake-slidev-slow.mjs')
    writeFileSync(binPath, `#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 30000);\n`)

    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
  }, 15_000)

  it('signal を abort すると子プロセスを止め、timeout を待たずに返る (#1228)', async () => {
    const binPath = temporaryRoot('fake-slidev-slow-abort.mjs')
    writeFileSync(binPath, `#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 30000);\n`)
    const projectDirectory = temporaryRoot('proj')
    mkdirSync(projectDirectory, { recursive: true })

    const runner = new ChildProcessSlidevRunner(() => binPath)
    const result = await runner.build(projectDirectory, { timeoutMs: 20_000, signal: AbortSignal.timeout(200) })

    expect(result.timedOut).toBe(false)
    expect(result.signal).toBe('SIGTERM')
  }, 15_000)

  it('stdout / stderr relay を伝搬する', async () => {
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

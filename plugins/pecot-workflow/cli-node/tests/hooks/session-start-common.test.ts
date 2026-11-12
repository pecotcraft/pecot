/* eslint-disable security/detect-non-literal-fs-filename -- 触るのはケースの一時ディレクトリ配下のみ */
// session-start-common.sh のテスト。CLAUDE_ENV_FILE への環境変数の追記、flock の排他制御、.pecot/.gitignore の生成を確かめる。
// flock のケースは、ロックを持つ子プロセス（holder）を spawn で保持し、終了時に必ず止める。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it } from 'vitest'

import { createHookCase } from './_helpers/environment.js'
import type { HookCase } from './_helpers/environment.js'
import { isFile } from './_helpers/files.js'
import { pathWithoutCommand } from './_helpers/mock-bin.js'
import { hooksDirectory } from './_helpers/paths.js'
import { run } from './_helpers/run.js'
import type { RunResult } from './_helpers/run.js'
import { splitLines } from './_helpers/text.js'

const COMMON_SCRIPT = path.join(hooksDirectory, 'lib', 'session-start-common.sh')

// CLAUDE_ENV_FILE を、空ファイルへ向ける。
function setUpEnvironmentFile(hookCase: HookCase): string {
  const file = path.join(hookCase.temporaryPath, 'env_file')
  writeFileSync(file, '')
  hookCase.setEnv('CLAUDE_ENV_FILE', file)
  return file
}

function makeGitProject(hookCase: HookCase, hasPecot = false): string {
  const projectDirectory = path.join(hookCase.temporaryPath, 'proj')
  mkdirSync(hasPecot ? path.join(projectDirectory, '.pecot') : projectDirectory, { recursive: true })
  expect(run(hookCase, 'git', ['-C', projectDirectory, 'init', '--quiet']).exitCode).toBe(0)
  return projectDirectory
}

// git-sync は pull に失敗しても `|| true` で exit 0 を保つので、副作用（CLAUDE_ENV_FILE への追記など）だけを見る。
function runCommon(hookCase: HookCase, projectDirectory: string): RunResult {
  return run(hookCase, 'bash', [COMMON_SCRIPT], {
    env: { CLAUDE_PROJECT_DIR: projectDirectory, PECOT_ORIGINAL_CLAUDE_PROJECT_DIR: projectDirectory },
  })
}

// ロックを保持する子プロセス。手順は `exec 9>lock && flock -n 9 && touch ready && sleep 5`。
interface Holder {
  hasExited(): boolean
  exitCode(): number | null
  stop(): Promise<void>
}

function holdLock(hookCase: HookCase, lockFile: string, readyFile: string): Holder {
  const child = spawn('bash', ['-c', 'exec 9>"$1" && flock -n 9 && touch "$2" && sleep 5', '_', lockFile, readyFile], {
    env: hookCase.composeEnv(),
    cwd: hookCase.temporaryPath,
    stdio: 'ignore',
  })
  return {
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    exitCode: () => child.exitCode,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = new Promise<void>((resolve) => {
        child.once('close', () => {
          resolve()
        })
      })
      child.kill('SIGTERM')
      await closed
    },
  }
}

const READY_TIMEOUT_MS = 10_000

// holder がロックを取った後に置く ready ファイルの出現を待つ。
// 待つ側が flock -n を試すと holder とロックを取り合うので、ファイルの出現だけを見る。
async function waitUntilReady(readyFile: string, holder: Holder): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (existsSync(readyFile)) return
    if (holder.hasExited()) throw new Error(`holder プロセスがロック取得前に終了した (rc=${String(holder.exitCode())})`)
    await sleep(20)
  }
  throw new Error('ロックが取得されなかった')
}

// 本体と同じ規則（PROJECT_DIR の cksum）で lock のパスを再現する。
function lockFileFor(hookCase: HookCase, temporaryDirectory: string, projectDirectory: string): string {
  const cksum = run(hookCase, 'cksum', [], { stdin: projectDirectory })
  expect(cksum.exitCode).toBe(0)
  return path.join(temporaryDirectory, `.session-start-common-${cksum.stdout.trim().split(/\s+/u, 1)[0] ?? ''}.lock`)
}

describe('session-start-common.sh', () => {
  // CLAUDE_ENV_FILE

  it('ディスパッチャ経由で、セッションのプロジェクトディレクトリを CLAUDE_ENV_FILE に追記する', () => {
    const hookCase = createHookCase()
    const environmentFile = setUpEnvironmentFile(hookCase)
    const projectDirectory = makeGitProject(hookCase)

    runCommon(hookCase, projectDirectory)

    expect(readFileSync(environmentFile, 'utf8')).toContain(`export PECOT_SESSION_PROJECT_DIR=${projectDirectory}\n`)
  })

  it('CLAUDE_ENV_FILE が未設定のとき、何も書き込まない', () => {
    const hookCase = createHookCase()
    const environmentFile = setUpEnvironmentFile(hookCase)
    hookCase.setEnv('CLAUDE_ENV_FILE', undefined)
    const projectDirectory = makeGitProject(hookCase)

    runCommon(hookCase, projectDirectory)

    expect(readFileSync(environmentFile, 'utf8')).toBe('')
  })

  // flock の排他制御。flock コマンド単体の相互排他だけを確かめる。本体の _LOCK_ID 配線は、本体を通すケースが確かめる。

  it('flock コマンドで、ロックを取得できる', () => {
    const hookCase = createHookCase()
    const lockDirectory = path.join(hookCase.temporaryPath, 'tmp')
    mkdirSync(lockDirectory, { recursive: true })
    const lockFile = path.join(lockDirectory, '.session-start-common.lock')

    const result = run(hookCase, 'bash', ['-c', 'exec 9>"$1" && flock -n 9 && echo ok', '_', lockFile])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('ok')
  })

  it('ロックを保持している間、別のプロセスのロック取得は失敗する', async () => {
    const hookCase = createHookCase()
    const lockDirectory = path.join(hookCase.temporaryPath, 'tmp')
    mkdirSync(lockDirectory, { recursive: true })
    const lockFile = path.join(lockDirectory, '.session-start-common.lock')
    const readyFile = path.join(lockDirectory, '.holder-ready')

    const holder = holdLock(hookCase, lockFile, readyFile)
    try {
      await waitUntilReady(readyFile, holder)
      const result = run(hookCase, 'bash', ['-c', 'exec 9>"$1" && flock -n 9', '_', lockFile])
      expect(result.exitCode).not.toBe(0)
    }
    finally {
      await holder.stop()
    }
  })

  it('ロックを解放した後は、再び取得できる', () => {
    const hookCase = createHookCase()
    const lockDirectory = path.join(hookCase.temporaryPath, 'tmp')
    mkdirSync(lockDirectory, { recursive: true })
    const lockFile = path.join(lockDirectory, '.session-start-common.lock')

    // 取得したサブシェルが終われば、ロックは自動で解放される
    run(hookCase, 'bash', ['-c', 'exec 9>"$1" && flock -n 9', '_', lockFile])
    const result = run(hookCase, 'bash', ['-c', 'exec 9>"$1" && flock -n 9 && echo ok', '_', lockFile])

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('ok')
  })

  // lock のパスは TMPDIR 配下に _LOCK_ID（PROJECT_DIR の cksum）で作られる。同じ規則で再現して、holder に先取りさせる。
  it('別のプロセスが同じロックを保持している間、本体はロックの取得に失敗して何もせず終わる', async () => {
    const hookCase = createHookCase()
    const projectDirectory = makeGitProject(hookCase, true)
    const temporaryDirectory = path.join(hookCase.temporaryPath, 'tmpdir')
    mkdirSync(temporaryDirectory)
    hookCase.setEnv('TMPDIR', temporaryDirectory)
    const lockFile = lockFileFor(hookCase, temporaryDirectory, projectDirectory)
    const readyFile = path.join(temporaryDirectory, '.holder-ready')

    const holder = holdLock(hookCase, lockFile, readyFile)
    try {
      await waitUntilReady(readyFile, holder)
      const gitignore = path.join(projectDirectory, '.pecot', '.gitignore')
      expect(existsSync(gitignore)).toBe(false)

      const result = run(hookCase, 'bash', [COMMON_SCRIPT], {
        env: { CLAUDE_PROJECT_DIR: projectDirectory, TMPDIR: temporaryDirectory },
      })

      // ロックの取得に失敗したら exit 0 で飛ばし、.gitignore の再生成は動かない
      expect(result.exitCode).toBe(0)
      expect(existsSync(gitignore)).toBe(false)
    }
    finally {
      await holder.stop()
    }
  })

  // flock が無い環境（標準の macOS）

  it('flock が PATH に無くても、サブスクリプトが動き、ロックを残さない', () => {
    const hookCase = createHookCase()
    const binDirectory = pathWithoutCommand(hookCase, 'flock')
    expect(existsSync(path.join(binDirectory, 'flock'))).toBe(false)
    const projectDirectory = makeGitProject(hookCase, true)
    const temporaryDirectory = path.join(hookCase.temporaryPath, 'tmpdir')
    mkdirSync(temporaryDirectory)
    const environmentFile = path.join(hookCase.temporaryPath, 'claude_env')
    writeFileSync(environmentFile, '')

    const result = run(hookCase, 'bash', [COMMON_SCRIPT], {
      env: {
        PATH: binDirectory,
        CLAUDE_PROJECT_DIR: projectDirectory,
        TMPDIR: temporaryDirectory,
        CLAUDE_ENV_FILE: environmentFile,
        PECOT_ORIGINAL_CLAUDE_PROJECT_DIR: projectDirectory,
      },
    })

    expect(result.exitCode).toBe(0)
    expect(isFile(path.join(projectDirectory, '.pecot', '.gitignore'))).toBe(true)
    expect(readFileSync(environmentFile, 'utf8')).toContain('export PECOT_SESSION_PROJECT_DIR=')
    // flock が無いときは、ロックを掛けない
    expect(readdirSync(temporaryDirectory)).toEqual([])
  })

  // .pecot/.gitignore 生成の配線

  it('.pecot が無いプロジェクトでは、.pecot を作らない', () => {
    const hookCase = createHookCase()
    const projectDirectory = makeGitProject(hookCase)
    hookCase.setEnv('CLAUDE_PROJECT_DIR', projectDirectory)

    const result = run(hookCase, 'bash', [COMMON_SCRIPT])

    // git-sync は pull に失敗しても || true で exit 0 を保つので、exit 0 は安定する。
    expect(result.exitCode).toBe(0)
    // 新規作成は利用検知側（pecot-dir-init.sh）に一本化している。session-start は .pecot を作らない。
    expect(existsSync(path.join(projectDirectory, '.pecot'))).toBe(false)
  })

  it('.pecot があるとき、.gitignore を作り、config を除外の対象から外す行を書く', () => {
    const hookCase = createHookCase()
    const projectDirectory = makeGitProject(hookCase, true)
    hookCase.setEnv('CLAUDE_PROJECT_DIR', projectDirectory)

    // git pull の失敗などで出力や exit code は問わない。.gitignore 生成の配線だけを確かめる。
    run(hookCase, 'bash', [COMMON_SCRIPT])

    const gitignore = path.join(projectDirectory, '.pecot', '.gitignore')
    expect(isFile(gitignore)).toBe(true)
    const lines = splitLines(readFileSync(gitignore, 'utf8'))
    expect(lines).toContain('*')
    expect(lines.at(lines.indexOf('*') + 1)).toBe('!/config/')
    expect(lines).toContain('!/config/projects/*.json')
  })
})

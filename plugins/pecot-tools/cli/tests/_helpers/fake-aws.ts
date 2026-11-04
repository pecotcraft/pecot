// 偽 awscli（tests/_fixtures/fake-aws/aws）を PATH 先頭へ差し込むヘルパ。
//
// infra の子プロセス実行と mcp の実行パイプラインは、いずれも実 awscli を導入せずに検証する。
// 差し込み条件（PATH・fixture ディレクトリ・呼び出し記録）がファイルごとにずれると、挙動の差の原因になる。
// そのため、ここに 1 本だけ置く。
//
// 次の fixtures/*.stderr と `--version` の既定出力は、実 awscli 2.36.40 の出力をそのまま置いている。
// 採取日は 2026-09-07。
//   invalid-input / no-credentials / invalid-token。
//   profile-not-found / sso-token-expired / s3-cp-no-credentials。
// access-denied は、実アカウントを使わないと出せない。
// 文言の骨格（`aws: [ERROR]: An error occurred (...)`）だけを実採取に合わせた。
// 残りは research R4 の転記で、AccessDenied / ResourceNotFound 系は未採取。

/* eslint-disable security/detect-non-literal-fs-filename -- 扱うのは import.meta.dirname 相対と mkdtemp のみ */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, vi } from 'vitest'

/**
偽 awscli を置いたディレクトリ。PATH の先頭に差し込む。
*/
export const FAKE_AWS_BIN_DIR = path.resolve(import.meta.dirname, '..', '_fixtures', 'fake-aws')

/**
既定の fixture ディレクトリ。
*/
export const FAKE_AWS_FIXTURE_DIR = path.join(FAKE_AWS_BIN_DIR, 'fixtures')

export interface FakeAwsOptions {
  /**
  fixture 名の明示。省略時は偽 awscli が `<service>-<subcommand>` を使う。
  */
  readonly fixture?: string
  /**
  fixture ディレクトリの差し替え。テストが生成した大きな出力を読ませるときに使う。
  */
  readonly fixtureDir?: string
  /**
  SIGTERM を受けるまで応答しない。

  `exitWhenFile` と同時に true にしてはならない。
  偽 awscli（fake-aws/aws）は HANG の無限待機（`sleep infinity`）へ先に入る。
  EXIT_WHEN_FILE 側の待機ループには進まず、`release()` は働かなくなる。片方だけを使う。
  */
  readonly hang?: boolean
  /**
  fixture を出力した後、`release()` が呼ばれるまで終了しない。

  SSO のデバイス認証（URL とコードを出したうえで承認を待つ）を、実時間の sleep ではなく
  テスト側の合図で進めるために使う。`hang` と排他（上の注記を参照）。
  */
  readonly exitWhenFile?: boolean
  /**
  応答前に待つ秒数。
  */
  readonly sleepSeconds?: number
  /**
  `aws --version` の出力 1 行（全文置換）。
  */
  readonly version?: string
}

export interface FakeAws {
  /**
  記録された呼び出しの引数配列（呼び出し順）。
  */
  callLog(): readonly (readonly string[])[]
  /**
  最後に起動した偽 awscli の PID。
  */
  pid(): number | undefined
  /**
  `exitWhenFile` で待機している偽 awscli を進ませる。
  */
  release(): void
  /**
  stub した環境変数と一時ディレクトリを片付ける。
  */
  restore(): void
}

/**
偽 awscli の差し込み条件一式。env は子プロセスへ渡す形、パスは記録の読み出しに使う。
*/
export interface FakeAwsEnvironment {
  /**
  偽 awscli を PATH 先頭に置いた環境変数。
  */
  readonly env: Record<string, string>
  /**
  呼び出し記録（JSON Lines）の書き出し先。
  */
  readonly callLogPath: string
  /**
  最後に起動した偽 awscli の PID の書き出し先。
  */
  readonly pidFilePath: string
  /**
  `exitWhenFile` の待機を解く sentinel の置き場所。
  */
  readonly releasePath: string
  /**
  上のパスを置いた一時ディレクトリ。片付けの対象。
  */
  readonly directory: string
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(element => typeof element === 'string')
}

/**
呼び出し記録（JSON Lines）を読む。env だけを使う e2e からも読めるよう公開する。
*/
export function readCallLog(logPath: string): readonly (readonly string[])[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      return isStringArray(parsed) ? parsed : []
    })
}

/**
最後に起動した偽 awscli の PID を読む。env だけを使う e2e からも読めるよう公開する。
*/
export function readPidFile(pidPath: string): number | undefined {
  if (!existsSync(pidPath)) return undefined
  const text = readFileSync(pidPath, 'utf8').trim()
  // 空文字は Number() だと 0 になるため、PID が未書き込みの状態として先に弾く。
  if (text === '') return undefined
  const parsed = Math.trunc(Number(text))
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
偽 awscli の差し込み条件を組み立てる（環境変数の適用はしない）。

単体テストは vi.stubEnv 経由（installFakeAws）で使い、実プロセスを起こす e2e は
返り値の env を子プロセスへそのまま渡す。条件の組み立てが 2 実装に割れないようここへ 1 本置く。
*/
export function fakeAwsEnvironment(options: Readonly<FakeAwsOptions> = {}): FakeAwsEnvironment {
  const directory = mkdtempSync(path.join(tmpdir(), 'pecot-tools-fake-aws-'))
  const callLogPath = path.join(directory, 'calls.jsonl')
  const pidFilePath = path.join(directory, 'pid')
  const releasePath = path.join(directory, 'release')

  return {
    env: {
      PATH: `${FAKE_AWS_BIN_DIR}:${process.env['PATH'] ?? ''}`,
      FAKE_AWS_FIXTURE_DIR: options.fixtureDir ?? FAKE_AWS_FIXTURE_DIR,
      FAKE_AWS_CALL_LOG: callLogPath,
      FAKE_AWS_PID_FILE: pidFilePath,
      ...(options.fixture !== undefined && { FAKE_AWS_FIXTURE: options.fixture }),
      ...((options.hang === true) && { FAKE_AWS_HANG: '1' }),
      ...((options.exitWhenFile === true) && { FAKE_AWS_EXIT_WHEN_FILE: releasePath }),
      ...(options.sleepSeconds !== undefined && { FAKE_AWS_SLEEP_SECONDS: String(options.sleepSeconds) }),
      ...(options.version !== undefined && { FAKE_AWS_VERSION: options.version }),
    },
    callLogPath,
    pidFilePath,
    releasePath,
    directory,
  }
}

/**
偽 awscli を PATH の先頭に差し込む。PATH を stub するので it.concurrent と併用しない。
*/
export function installFakeAws(options: Readonly<FakeAwsOptions> = {}): FakeAws {
  const environment = fakeAwsEnvironment(options)

  for (const [name, value] of Object.entries(environment.env)) vi.stubEnv(name, value)

  return {
    callLog: () => readCallLog(environment.callLogPath),
    pid: () => readPidFile(environment.pidFilePath),
    release: () => {
      writeFileSync(environment.releasePath, '')
    },
    restore: () => {
      vi.unstubAllEnvs()
      rmSync(environment.directory, { recursive: true, force: true })
    },
  }
}

/**
PATH を空のディレクトリだけにして awscli を見つからなくする（ENOENT の検証用）。
*/
export function withoutAws(): FakeAws {
  const emptyDirectory = mkdtempSync(path.join(tmpdir(), 'pecot-tools-no-aws-'))
  vi.stubEnv('PATH', emptyDirectory)

  return {
    callLog: () => [],
    // 偽 awscli は起動しないので PID ファイルも作られない（常に undefined）。
    pid: () => readPidFile(path.join(emptyDirectory, 'pid')),
    release: () => {
      // 偽 awscli を起動しないので待機している子も居ない。FakeAws を満たすための空実装。
    },
    restore: () => {
      vi.unstubAllEnvs()
      rmSync(emptyDirectory, { recursive: true, force: true })
    },
  }
}

/**
テスト内で差し込んだ偽 awscli を `afterEach` でまとめて戻す関数。
`describe` / ファイルの直下で 1 度だけ呼び、テスト内では `install` / `withoutAws` を使う。
*/
export interface FakeAwsSession {
  readonly install: (options?: Readonly<FakeAwsOptions>) => FakeAws
  readonly withoutAws: () => FakeAws
  /**
  直近に差し込んだ偽 awscli を戻し、条件を変えて差し込み直す。
  */
  readonly reinstall: (options?: Readonly<FakeAwsOptions>) => FakeAws
  /**
  直近に差し込んだ偽 awscli。まだ差し込んでいなければ例外にする。
  */
  readonly current: () => FakeAws
}

export function useFakeAws(): FakeAwsSession {
  const installed: FakeAws[] = []
  afterEach(() => {
    for (const fake of installed.splice(0).toReversed()) fake.restore()
  })
  const install = (options: Readonly<FakeAwsOptions> = {}): FakeAws => {
    const fake = installFakeAws(options)
    installed.push(fake)
    return fake
  }
  return {
    install,
    withoutAws: () => {
      const fake = withoutAws()
      installed.push(fake)
      return fake
    },
    reinstall: (options = {}) => {
      installed.pop()?.restore()
      return install(options)
    },
    current: () => {
      const latest = installed.at(-1)
      if (latest === undefined) throw new Error('偽 awscli を差し込めていません')
      return latest
    },
  }
}

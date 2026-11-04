// `pecotv chromium host-deps` 実装。Chromium が起動するのに要る OS のライブラリを確認し、
// 足りなければ入れる (#1217)。bin/pecotv の bootstrap が Chromium 取得の直後に呼ぶ。
// テストの前提確認 (scripts/ci/chromium-preflight.sh) は --require-launch 付きで呼び、
// 起動できないなら原因を問わず本実行の前に落とす。
//
// 判定と導入の本体は infra/playwright/host-dependencies.ts。ここは結果を利用者向けの文言と
// exit code に写すだけにする。

import { Command } from 'commander'

import {
  ensureChromiumHostDependencies,
  hostDependenciesDefaultDependencies,
  type HostDependencies,
} from '../../infra/playwright/host-dependencies.js'

/**
OS のライブラリが足りず、入れられなかったときの exit code。
*/
export const HOST_DEPS_MISSING_EXIT_CODE = 2

/**
--require-launch のとき、OS のライブラリ以外の原因で起動できなかったときの exit code。
*/
export const LAUNCH_FAILED_EXIT_CODE = 3

interface HostDependenciesOptions {
  readonly requireLaunch?: boolean
}

export interface HostDependenciesCommandDependencies {
  readonly hostDeps: () => HostDependencies
  readonly stderr: NodeJS.WritableStream
  readonly setExitCode: (code: number) => void
}

export function hostDependenciesCommandDefaultDependencies(): HostDependenciesCommandDependencies {
  return {
    hostDeps: hostDependenciesDefaultDependencies,
    stderr: process.stderr,
    setExitCode: (code) => {
      process.exitCode = code
    },
  }
}

export function createChromiumHostDependenciesCommand(buildDependencies: () => HostDependenciesCommandDependencies): Command {
  return new Command('host-deps')
    .description('Chromium の起動に要る OS のライブラリを確認し、足りなければ入れる')
    .option('--require-launch', 'OS のライブラリ以外の原因で起動できないときも失敗にする (テストの前提確認用)')
    .action(async (options: Readonly<HostDependenciesOptions>) => {
      const dependencies = buildDependencies()
      // apt-get は数分かかり得るため、始める前に何を入れるかを stderr に出す。
      const hostDependencies: HostDependencies = {
        ...dependencies.hostDeps(),
        notify: (message) => {
          dependencies.stderr.write(`${message}\n`)
        },
      }
      const outcome = await ensureChromiumHostDependencies(hostDependencies)
      switch (outcome.status) {
        case 'ok': {
          hostDependencies.record('ok')
          return
        }
        case 'installed': {
          dependencies.stderr.write(`Chromium の起動に要る OS のライブラリを入れました: ${outcome.packages.join(' ')}\n`)
          hostDependencies.record('ok')
          return
        }
        case 'missing': {
          dependencies.stderr.write(`${outcome.detail}\n`)
          hostDependencies.record('missing')
          dependencies.setExitCode(HOST_DEPS_MISSING_EXIT_CODE)
          return
        }
        case 'launch-failed': {
          // 実行ファイル未取得等。取得は bin/pecotv の別の段が担うため、記録だけして通す。
          hostDependencies.record('launch-failed')
          dependencies.stderr.write(`Chromium を起動できませんでした (OS のライブラリ以外の原因): ${outcome.detail}\n`)
          if (options.requireLaunch === true) dependencies.setExitCode(LAUNCH_FAILED_EXIT_CODE)
          return
        }
      }
    })
}

// テストの env を隔離する補助。
// Claude Code のセッション内と素の端末とで、テストの結果を変えないために使う。
//
// 使い方（テストファイルの describe の外で 1 回呼ぶ）:
//   useIsolatedEnvironment()
//     各テストの前に隔離の対象を全部外し、後に元へ戻す。
//   setEnvironment({ HOME: '/x', CLAUDE_PROJECT_DIR: undefined })
//     テストの中で値を足す。undefined の値は外す。
//
// 隔離の対象は ISOLATED_ENVIRONMENT に並べてある。
// 対象はトークン（GITHUB_*_TOKEN と、ホスト名を挟む PECOT_GITHUB_*_TOKEN）、PECOT_GITHUB_API_URL、CLAUDE_PROJECT_DIR。
// PECOT_SESSION_PROJECT_DIR、データ置き場の 3 変数、XDG_DATA_HOME、HOME、GIT_* も対象。
// 隔離の後に、GIT_CONFIG_NOSYSTEM=1 と GIT_CONFIG_GLOBAL=/dev/null を置く。
// 製品の runGit を通る git が、システムと利用者の git の設定を読まないようにするため。
// PATH は外さない（git・sh を探せなくなるため）。
// PATH に偽物を置くときは、fake-executables.ts の prependToPath を使う。
import { afterEach, beforeEach } from 'vitest'

/**
隔離する変数の名前。名前の完全一致か、正規表現に当たるもの
*/
export const ISOLATED_ENVIRONMENT: readonly (string | RegExp)[] = [
  /^GIT_/u,
  /^GH_/u,
  /^GITHUB_.*TOKEN$/u,
  /^PECOT_GITHUB_.*TOKEN$/u,
  'PECOT_GITHUB_API_URL',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'PLUGIN_DATA',
  'PECOT_SESSION_PROJECT_DIR',
  'PECOT_BOOTSTRAP_SKIP',
  'XDG_DATA_HOME',
  'HOME',
]

function isIsolated(name: string): boolean {
  return ISOLATED_ENVIRONMENT.some(pattern => typeof pattern === 'string' ? pattern === name : pattern.test(name))
}

/**
テスト内で env を設定する。undefined の値は外す。元へ戻すのは useIsolatedEnvironment の afterEach
*/
export function setEnvironment(values: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else Reflect.set(process.env, name, value)
  }
}

/**
各テストの前に隔離対象を外し、後に process.env を丸ごと元へ戻す
*/
export function useIsolatedEnvironment(): void {
  let saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved = { ...process.env }
    for (const name of Object.keys(process.env)) {
      if (isIsolated(name)) Reflect.deleteProperty(process.env, name)
    }
    // 製品の runGit を通る git が、/etc/gitconfig と利用者の git の設定を読まないようにする
    setEnvironment({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  })
  afterEach(() => {
    for (const name of Object.keys(process.env)) {
      if (!Object.hasOwn(saved, name)) Reflect.deleteProperty(process.env, name)
    }
    setEnvironment(saved)
  })
}

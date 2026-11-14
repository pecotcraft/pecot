// コマンドの名前まわりの小さな関数。help・バインド・定義書の書き出しが同じものを使う。

/**
入力名を長いオプションの形にする。`force_overwrite_active` は `--force-overwrite-active`
*/
export function flagOf(name: string): string {
  return `--${name.replaceAll('_', '-')}`
}

/**
文字列を名前の順（コードユニットの順）に並べる比較関数
*/
export function byName(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
コマンド名の語と、その意味
*/
export interface CommandWord {
  readonly name: string
  readonly meaning: string
}

/**
グループの語。help は、グループの一覧と `pecot <グループ> --help` に help の文を出す
*/
export interface CommandGroup extends CommandWord {
  readonly help: string
}

/**
コマンド名の 1 語目に使うグループ。利用者が操作する対象で、help の一覧はこの順に並ぶ
*/
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  { name: 'project', meaning: 'プロジェクトとの接続と設定ファイル。ボードの上の Issue には触らない', help: 'Connect to projects and manage the project config' },
  { name: 'board', meaning: 'ボードの上の Issue の置き場所。設定ファイルは書かない', help: 'Show the project board and place Issues on it' },
  { name: 'issue', meaning: 'Issue そのもの', help: 'Work with Issues' },
  { name: 'session', meaning: '1 つの Issue の作業の始まりから終わりまで', help: 'Start, show, restore and finish the work on an Issue' },
  { name: 'pr', meaning: 'PR そのもの', help: 'Work with PRs' },
  { name: 'release', meaning: 'リリース', help: 'Work with releases' },
  { name: 'tracker', meaning: 'Tracker の Issue の書き直し', help: 'Rewrite the list in a Tracker Issue' },
  { name: 'worktree', meaning: 'worktree', help: 'Work with worktrees' },
  { name: 'branch', meaning: 'リモートのブランチ', help: 'Work with remote branches' },
]

/**
コマンド名の 2 語目に使う動詞の語彙。1 語に 1 つの意味を決める
*/
export const COMMAND_VERBS: readonly CommandWord[] = [
  { name: 'list', meaning: '複数を並べる' },
  { name: 'search', meaning: 'GitHub を探す' },
  { name: 'show', meaning: '1 件を出す' },
  { name: 'get', meaning: '設定の値を出す' },
  { name: 'check', meaning: '次の操作の前に確かめる' },
  { name: 'create', meaning: 'GitHub のものを作る' },
  { name: 'delete', meaning: 'GitHub のものを消す' },
  { name: 'add', meaning: '集まりに入れる' },
  { name: 'remove', meaning: '集まりから出す' },
  { name: 'init', meaning: '既にあるものを pecot で使える状態にする' },
  { name: 'set', meaning: '設定のキーに値を入れる' },
  { name: 'unset', meaning: '設定のキーの値を消す' },
  { name: 'link', meaning: 'リポジトリをプロジェクトにつなぐ' },
  { name: 'activate', meaning: '使うプロジェクトを切り替える' },
  { name: 'start', meaning: '作業を始める' },
  { name: 'restore', meaning: '作業の状態を戻す' },
  { name: 'finish', meaning: '作業を終えて片付ける' },
  { name: 'sync', meaning: '判定や一覧に合わせて書き直す' },
  { name: 'move', meaning: 'ボードの列を移す' },
  { name: 'merge', meaning: 'PR をマージする' },
  { name: 'comment', meaning: 'コメントを書く' },
  { name: 'reopen', meaning: '閉じたものを開き直す' },
  { name: 'block', meaning: '前提を付ける' },
  { name: 'unblock', meaning: '前提を外す' },
  // 動詞ではないが残す。issue create と session start の合成で、整理は別の Issue にする
  { name: 'quick', meaning: 'Issue を作り、そのまま作業を始める' },
]

const COMMAND_WORD_COUNT = 2

/**
コマンド名の決まりに合わない path と、その理由
*/
export interface CommandNameViolation {
  readonly path: string
  readonly reason: string
}

function isListed(words: readonly CommandWord[], word: string | undefined): boolean {
  return word === undefined || words.some(listed => listed.name === word)
}

/**
コマンド名の決まり（`<グループ> <動詞>` の 2 語で、1 語目が COMMAND_GROUPS、2 語目が COMMAND_VERBS にある）に合わない path を、渡された順で返す。全部が合えば空
*/
export function commandNameViolations(paths: readonly (readonly string[])[]): readonly CommandNameViolation[] {
  return paths
    .map(path => ({
      path: path.join(' '),
      reason: [
        ...path.length === COMMAND_WORD_COUNT ? [] : [`has ${String(path.length)} word(s); a command name is '<group> <verb>' (2 words)`],
        ...isListed(COMMAND_GROUPS, path.at(0)) ? [] : [`'${String(path.at(0))}' is not a group in COMMAND_GROUPS`],
        ...isListed(COMMAND_VERBS, path.at(1)) ? [] : [`'${String(path.at(1))}' is not a verb in COMMAND_VERBS`],
      ].join('; '),
    }))
    .filter(violation => violation.reason !== '')
}

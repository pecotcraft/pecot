// ツールの名前まわりの小さな関数。登録の検証と定義書の書き出しが同じものを使う。

/**
文字列を名前の順（コードユニットの順）に並べる比較関数
*/
export function byName(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
ツール名の語と、その意味
*/
export interface CommandWord {
  readonly name: string
  readonly meaning: string
  // 読むだけの動詞の印。定義書の検証が、この語のツールに read でない effects を許さない
  readonly readOnly?: true
}

/**
ツール名の 1 語目に使うグループ。利用者が操作する対象
*/
export const COMMAND_GROUPS: readonly CommandWord[] = [
  { name: 'project', meaning: 'プロジェクトとの接続と設定ファイル。ボードの上の Issue には触らない' },
  { name: 'board', meaning: 'ボードの上の Issue の置き場所。設定ファイルは書かない' },
  { name: 'issue', meaning: 'Issue そのもの' },
  { name: 'session', meaning: '1 つの Issue の作業の始まりから終わりまで' },
  { name: 'pr', meaning: 'PR そのもの' },
  { name: 'release', meaning: 'リリース' },
  { name: 'worktree', meaning: 'worktree' },
  { name: 'branch', meaning: 'リモートのブランチ' },
  { name: 'workflow', meaning: '導入先のリポに置く GitHub Actions のワークフロー' },
]

/**
ツール名の 2 語目に使う動詞の語彙。1 語に 1 つの意味を決める
*/
export const COMMAND_VERBS: readonly CommandWord[] = [
  { name: 'list', meaning: '複数を並べる', readOnly: true },
  { name: 'search', meaning: 'GitHub を探す', readOnly: true },
  { name: 'show', meaning: '1 件を出す', readOnly: true },
  { name: 'get', meaning: '設定の値を出す', readOnly: true },
  { name: 'check', meaning: '次の操作の前に確かめる', readOnly: true },
  { name: 'doctor', meaning: '導入に要る設定がそろっているかを確かめる', readOnly: true },
  { name: 'attributes', meaning: '付けられる機能の定義を出す', readOnly: true },
  { name: 'create', meaning: 'GitHub のものを作る' },
  { name: 'delete', meaning: 'GitHub のものを消す' },
  { name: 'add', meaning: '集まりに入れる' },
  { name: 'remove', meaning: '集まりから出す' },
  { name: 'init', meaning: '既にあるものを pecot で使える状態にする' },
  { name: 'install', meaning: '雛形をリポに書き出す' },
  { name: 'set', meaning: '設定のキーに値を入れる' },
  { name: 'unset', meaning: '設定のキーの値を消す' },
  { name: 'link', meaning: 'リポジトリをプロジェクトにつなぐ' },
  { name: 'activate', meaning: '使うプロジェクトを切り替える' },
  { name: 'start', meaning: '作業を始める' },
  { name: 'finish', meaning: '作業を終えて片付ける' },
  { name: 'move', meaning: 'ボードの列を移す' },
  { name: 'merge', meaning: 'PR をマージする' },
  { name: 'restack', meaning: 'スタックしたブランチを、base の新しい位置へスタックし直す' },
  { name: 'comment', meaning: 'コメントを書く' },
  { name: 'edit', meaning: '既にあるものの値を書き換える' },
  { name: 'reopen', meaning: '閉じたものを開き直す' },
  { name: 'block', meaning: '前提を付ける' },
  { name: 'unblock', meaning: '前提を外す' },
]

const TOOL_WORD_COUNT = 2

/**
ツール名の決まりに合わない名前と、その理由
*/
export interface ToolNameViolation {
  readonly name: string
  readonly reason: string
}

function isListed(words: readonly CommandWord[], word: string | undefined): boolean {
  return word === undefined || words.some(listed => listed.name === word)
}

/**
ツール名の決まり（`<グループ>_<動詞>` の 2 語で、1 語目が COMMAND_GROUPS、2 語目が COMMAND_VERBS にある）に合わない名前を、渡された順で返す。全部が合えば空
*/
export function toolNameViolations(names: readonly string[]): readonly ToolNameViolation[] {
  return names
    .map((name) => {
      const words = name.split('_')
      return {
        name,
        reason: [
          ...words.length === TOOL_WORD_COUNT ? [] : [`has ${String(words.length)} word(s); a tool name is '<group>_<verb>' (2 words)`],
          ...isListed(COMMAND_GROUPS, words.at(0)) ? [] : [`'${String(words.at(0))}' is not a group in COMMAND_GROUPS`],
          ...isListed(COMMAND_VERBS, words.at(1)) ? [] : [`'${String(words.at(1))}' is not a verb in COMMAND_VERBS`],
        ].join('; '),
      }
    })
    .filter(violation => violation.reason !== '')
}

// git の実行を domain から切り離す型。実体は infra/git.ts の gitRunnerFor が作る。
// 作業ディレクトリは実体が持つ。domain は git の引数（先頭に `git` を含めない）だけを渡す。

export interface GitResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
git を実行する。非 0 終了でも例外にせず結果を返す。git の起動に失敗したときは例外を投げる。
*/
export type GitRunner = (arguments_: readonly string[]) => GitResult

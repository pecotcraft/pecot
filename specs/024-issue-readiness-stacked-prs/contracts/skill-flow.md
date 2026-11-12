# Contract: スキルの流れ

**Date**: 2026-11-12

スキルは、判断を CLI の出力に任せる。スキルの文に、base の選び方・積む条件・マージの順番の規則を書かない。
ここでは、スキルごとに変える手順と、変えない手順を決める。

## 共通の決まり

- この文書は、pecot の呼び出しを CLI の形（`pecot create-branch` など）で書く。スキルの文では、Epic #42 の切り替えの後の書き方（MCP のツール名）に合わせる

- 着手できるかどうかは、`pecot project info` の判定の列と、`pecot create-branch` の結果で知る。スキルの文で判断させない
- エージェントは `gh stack` を打たない。hook が止める
- `issue block`・`issue unblock`・`pr restack` は、hook の確認にかけない。前提の見直しは、利用者が決めた後に打つからだ
- エージェントは `git rebase` を手で打って積み直さない。`pecot pr restack` を使う
- ブロック中の Issue を進めたいときは、利用者に前提の見直しを提案する。エージェントの判断で前提を外さない
- CLI が `warning:` で出した食い違い（着手済みの Issue がブロック中になった、など）は、そのまま利用者に伝える。エージェントの判断で、列や前提を直さない

## w-breakdown

| Step | 変更 |
|---|---|
| tasks の工程の実行 | `/speckit.tasks` に渡す指示に、前提の表の形と、種類を決める問いを足す。形は [prerequisite-table.md](prerequisite-table.md) の 1 |
| tasks の工程の後 | できた tasks.md に 4 列の表があることを確かめる。無ければ、表を足すよう工程をやり直す |

- spec-kit のテンプレートは変えない
- 「マージを待つ」の行の理由が空のときは、利用者に確かめる

## w-issueize

| Step | 今 | 変更後 |
|---|---|---|
| 2 フェーズ構造の把握 | 前提から段を計算し、`order` と `parallel` を決める | 前提の表を読む。段と枝の文字は計算しない |
| 2 利用者に示す表 | Phase・番号・タイトル案・済・前提・一部だけの依存 | 番号と進め方は、`pecot issue create --plan` の出力を示す |
| 3 Issue ファイルの編集 | `order` と `parallel` を書く | `blocked_by` を書く。`order`・`parallel`・`status` は書かない |
| 3 投稿の前 | 無い | `pecot issue create --plan <ファイル...>` を打ち、出力を前提の表と並べて示す。合意を得てから投稿する |
| 4 完了報告 | Phase と Issue 番号の表 | 表に進め方を足す。積める並びと、最初に着手できる Issue を示す |

- 4 列の表が無い tasks.md は、[prerequisite-table.md](prerequisite-table.md) の 4 のとおりに扱う
- 「番号が示すのは着手の条件」の記述を外す
- 本文に前後関係を書かせない。マージを待つ前提の節は、CLI が足す

## w-active

| Step | 今 | 変更後 |
|---|---|---|
| 1 プロジェクト情報の表示 | `pecot project info` を打つ | 変えない。出力の判定の列・列を直した行（`moved:`）・食い違いの警告（`warning:`）を利用者に伝える |
| 2 対象の確認 | 利用者が選ぶ | 選ぶ材料に、判定を示す。`Blocked` の Issue を選んだときは、理由を伝えて止める |
| 3 ベースブランチの最新化 | `git pull` | 変えない |
| 4 ブランチ作成 | `pecot create-branch` | 変えない。base は CLI が選ぶ。`--base` を付けない |
| 5 ブランチ切り替え | `created:` の行のブランチに切り替える | 行に `(stacked on #N)` があれば、積んで着手した旨を利用者に伝える |
| 6 以降 | 調査・計画・レビュー・投稿・承認 | 変えない |

- `pecot create-branch` が終了コード 2 で止まり、出力に `is blocked by` があるときは、案内の 2 行を利用者に示す。前提の見直しは利用者が決める

## w-pr

| Step | 今 | 変更後 |
|---|---|---|
| 3 PR の作成 | `--prepare` が base を入れる。書き換えない | 変えない。積んだブランチでは、下の段のブランチが入る |
| 3 PR の作成の後 | 無い | 出力に `added: PR ... to stack` があれば、スタックに入った旨を伝える。`moved:` の行があれば、動いた Issue を伝える |

- 「base を書き換えない」の説明に、積んだブランチの場合を足す
- 本文に、上下の PR やスタックの位置を書かない

## w-merge

| Step | 今 | 変更後 |
|---|---|---|
| 2 マージ | `gh pr merge <PR> --squash` | `pecot pr merge <owner>/<repo>/<PR>` |
| 2 片付け | `pecot pr cleanup` | 変えない |
| 2 片付けの後 | 無い | `Readiness changed:` の一覧を利用者に伝える。上の段があるときは、載せ直しの案内を伝える |
| 4 以降 | 実装差分の分析・Epic へのコメント・後続フェーズの通知 | 後続フェーズの通知は、`Readiness changed:` の一覧を使う |

- `pecot pr merge` が「最下段でない」と止まったときは、先にマージする PR を利用者に示す。エージェントの判断で下の段をマージしない
- merge queue に入ったときは、マージを待ってから片付けに進む

## w-revise

| Step | 変更 |
|---|---|
| 修正の push の後 | `pecot session status` を打つ。上に積んだ段があれば、その作業ディレクトリで `pecot pr restack` が要る旨を報告に入れる |
| レビューの前 | 積んだブランチでは、`pecot pr restack --check` を打つ。載せ直しが要るときは、先に載せ直す |

- 上の段の作業ディレクトリには入らない。起動されたディレクトリの外の作業ディレクトリを操作しないからだ

## w-help

| 文書 | 変更 |
|---|---|
| `references/board-status.md` | `Blocked` を足す。`Pending`・`Blocked`・`Ready` の違いを、置く理由・動かす者・出る条件の表で示す。`Ready` の用途を「着手できる」に直す。`Needs Attention` を足す |
| `references/issue-flow-rules.md` | `order` の説明を通し番号に直す。前提と種類の決まりを足す |
| `references/spec-driven-workflow.md` | 列の表を直す。前提の表から Issue 化、積んで着手、マージまでの流れを足す |
| `references/commands.md` | 定義書から書き出し直す。手で直さない |

## hook

Epic #42 の切り替えの後、エージェントは pecot を MCP のツールで呼ぶ。Bash の `pecot` は hook が止める。
pecot の投稿の確認は、MCP 用の hook に置く。Bash 用の hook に残るのは、`gh` のコマンドの規則だけだ。

| 規則 | 対象 | 判断 |
|---|---|---|
| `gh stack` の直接の実行 | Bash の `gh stack` で始まるコマンド。`view` と `--help` は除く | 止める。置き場は Bash 用の `gh-command-check.sh` だ。pecot の `pr create`・`pr merge`・`pr restack` を案内する |
| pecot の `pr merge` | MCP のツール `pr_merge`。`dry_run` が真のときは除く | 確認にかける。置き場は MCP 用の `pecot-post-ask.sh` だ。w-merge の起動の印があれば通す |

# 引き継ぎのワークフロー

PR がマージされると、GitHub Actions の上で w-handoff を回し、マージした結果を Epic と後続の Issue にコメントで書く雛形です。置くかどうかは任意です。w-handoff は、この雛形からだけ起こします。

## コメントの書き手

マージの後の 2 つのコメントは、この雛形だけが書きます。PR を出したセッション（w-pr の待ち受け、w-active などの取りこぼしの片付け）は、手元の片付けと `session_finish` だけを行い、コメントを書きません。

| コメント | 書く先 | 書くとき |
|---|---|---|
| merge-diff | PR が閉じた Issue の親 Epic | 親 Epic があるとき。計画どおりでも書く |
| precede-notify | 親 Epic の OPEN のサブタスク | speckit 由来のタスクで、後続に影響する変更があるとき |

PR が閉じた Issue は、PR の closing issues と、head ブランチの名前の末尾の `/<番号>` から求めます。

- 通知先は、PR が閉じた Issue を blocked by で待つサブタスクにする。無ければ、ほかの OPEN のサブタスクから選ぶ
- 雛形を置かないリポでは、どちらのコメントも付かない。Issue のクローズとブランチの削除は、コメントと別に行われる
- 実行が失敗したときに、ほかの道で書き直す仕組みは無い。コメントが無くても、ボードの列と Issue の状態は変わらない

## 前提

- pecot-workflow の MCP ツール `workflow_install` と `workflow_doctor` があること。呼んで、ツールが見つからないと言われなければよい
- リポが github.com にあること。GHES では確かめていない
- `.pecot/config/projects/<設定名>.json` が既定のブランチに入っていること。手順は [ボードを自動で直すワークフロー](board-sync-workflow.md) の「設定の JSON を既定ブランチに置く」にある
- 親 Epic・後続の Issue が、雛形を置くリポにあること。雛形の token は、そのリポにしか書けない

## 導入

認証には、[自動レビューのワークフロー](review-workflow.md) の secret・変数をそのまま使います。自動レビューを入れたリポでは、雛形を置くだけで動きます。

Claude の GitHub App は要りません。自前の App を置かないときは、実行の `GITHUB_TOKEN` を claude-code-action に渡します。

action は、`github_token` が空だと、OIDC の token を Claude の App の token に交換します。Anthropic の交換の窓口は、`pull_request_target` の token を拒みます（anthropics/claude-code-action#713）。

### 1. 雛形を置く

pecot-workflow の MCP ツール `workflow_install`（`name: "handoff"`）で、雛形をリポに書き出します。

- 雛形: `${CLAUDE_PLUGIN_ROOT}/cli/templates/workflow/pecot-handoff.yml`
- 置き先: 利用者のリポの `.github/workflows/pecot-handoff.yml`
- 既にファイルがあると、上書きせずに止まる。更新は `force: true` で上書きする

### 2. 認証をそろえる

自動レビューのワークフローの「導入」の 3 の手順と同じです。

- secret `CLAUDE_CODE_OAUTH_TOKEN` を置く。API の利用で払うときは、Workload Identity Federation の 4 つの変数を置く
- コメントを自前の App の名前で書きたいときは、自前の GitHub App を足す（「自前の GitHub App」の節）

### 3. 確かめる

pecot-workflow の MCP ツール `workflow_doctor`（`name: "handoff"`）で、雛形と設定がそろっているかを確かめます。見る項目と読み方は、自動レビューと同じです。Claude の GitHub App は使わないので、その項目は出ません。

### 4. 既定のブランチへ入れる

雛形をコミットし、既定のブランチへ入れます。入れた後にマージした PR から動きます。

## 動く契機

`pull_request_target` の `closed` で起き、次の 3 つがそろうときだけ動きます。

- PR がマージされた。マージせずに閉じた PR では動かない
- head が同じリポのブランチ。fork の PR では動かない
- PR を作ったのが bot でない

merge queue がマージしたときも動きます。

`pull_request_target` は、既定のブランチの雛形で動きます。雛形は PR のコードを checkout せず、設定の JSON のある既定のブランチだけを読みます。PR の変更は `gh pr diff` で読みます。

## 権限

| 項目 | 中身 |
|---|---|
| job の権限 | `contents: read`・`issues: write`・`pull-requests: read`・`id-token: write` |
| コメントを書く token | 自前の App の token。置かないときは、実行の `GITHUB_TOKEN`（`github-actions[bot]`） |
| 許すツール | `Read`・`pr_show`・`issue_show`・`issue_comment`・`gh pr diff`・`gh pr view` |
| 拒むツール | `Edit`・`Write`・`NotebookEdit`・`AskUserQuestion`・`Agent`・`WebFetch`・`WebSearch`・`git clone`・`/proc` の `Read` |

`id-token` は、Workload Identity Federation だけが使います。

w-handoff は、ファイルを書き換えず、Issue を閉じず、ブランチも消しません。コメントは `issue_comment` の `message` で投稿します。

## 自前の GitHub App

コメントを自前の App の名前で書きたい利用者だけが足す手順です。置き方は、自動レビューの「自前の GitHub App」の節と同じで、同じ変数と secret を使います。

- App の権限
  - Issues: read and write
  - Pull requests: read
  - Contents: read

雛形は、トークンを発行するときに、上の 3 つの権限だけに絞ります。自動レビューと同じ App を使うときは、インストールで与える権限を、2 つの雛形が要る権限の合計にします。

## 運用

### 変えられる値

リポの変数に置くと、雛形の既定値より優先します。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PECOT_HANDOFF_MODEL` | `opus` | 使うモデル。別名か、完全な名前で書く |
| `PECOT_HANDOFF_EFFORT` | `medium` | effort の段階。`low`・`medium`・`high`・`xhigh`・`max` のどれか |
| `PECOT_HANDOFF_MAX_TURNS` | `30` | main のターンの上限 |
| `PECOT_HANDOFF_TIMEOUT_MINUTES` | `20` | job の時間の上限。分 |
| `PECOT_HANDOFF_PROJECT` | 空 | 使うプロジェクトの設定の名前。`.pecot/config/projects/` のファイル名から `.json` を除いて書く |

`PECOT_HANDOFF_PROJECT` は、リポが 2 つ以上のプロジェクトの設定に入っているときに置きます。

### 再実行

Actions の画面で実行をやり直すと、コメントをもう一度書きます。前のコメントは消さず、同じ Epic に 2 つ並びます。要らない方は、画面で消します。

### 実行の記録

run の Summary に、使われたモデルと effort、呼んだツール、拒まれた呼び出しが出ます。出し方は、自動レビューの「実行の記録」と同じです。表の見出しは `Handoff run` です。

### 雛形を更新する

雛形の 1 行目の版の目印で、置いた雛形が古いかを確かめます。`workflow_install` の `check: true` と `workflow_doctor` が版を比べます。上書きは `workflow_install` に `force: true` を付けます。

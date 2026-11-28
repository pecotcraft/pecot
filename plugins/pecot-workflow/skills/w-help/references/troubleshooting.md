# トラブルシューティング

## 認証エラー

GitHub の公式の MCP サーバが、読めない・書けないと返したときは、つなぎ方と権限を見直す。つなぎ方は [w-help](../SKILL.md) の「公式の MCP をつなぐ」にある。
ボードを読み書きするには、`projects` の toolset と、Projects の読み書きの権限が要る。

github-ops の operation が `github-auth` で止まったときは、[github-ops で書く](github-ops.md) の「止めるとき」に従う。

## プロジェクトが見つからない

- 一覧確認: pecot-workflow の MCP ツール `project_list` を使う
- 検索: 公式の MCP の `projects_list`（`list_projects`）で、owner のボードを読む

## フィールドが見つからない

[ボードの欄を足す・直す](#ボードの欄を足す直す) の手順で足す。

## 旧い形のボードを移す

`board_show` か、ボードを自動で直すワークフローのログが warning を出したときに行う。warning は、旧い名前の進行の欄と、pecot が使わないフィールド（`pecot-priority`・`pecot-size`）を知らせる。

1. [ボードの欄を足す・直す](#ボードの欄を足す直す) の手順で、名前を移す
2. `project_check` の結果の `deletable` に名前があれば、その名前を利用者に示し、消してよいか承認を得る。消すと、各 Item のそのフィールドの値も消え、戻せない
3. 承認を得たら、`changes` に、その欄を消す変更（`delete`）を足して通し直し、github-ops の `project-fields` を起動する

## ボードの欄を足す・直す

1. 公式の MCP の `projects_list`（`list_project_fields`）で、ボードの欄を読む
2. pecot-workflow の MCP ツール `project_check` に、読んだ欄（`reads.fields`）を渡す。`method: "fields"`・`owner`・`project`（ボードの番号）も渡す。`pecot-lane` を使うボードでは `lanes` も渡す
3. `problems` に挙がった欄と選択肢を、github-ops の `project-fields` の `changes` の形で組み立て、`changes` に入れて通し直す。`problems` が空になるまで繰り返す
4. github-ops の `project-fields` を、`params` に `project` と、通した `changes` を入れて起動する。手順は [github-ops で書く](github-ops.md)
5. 欄を読み直し、pecot-workflow の MCP ツール `project_activate` に渡して、設定ファイルを読み直す

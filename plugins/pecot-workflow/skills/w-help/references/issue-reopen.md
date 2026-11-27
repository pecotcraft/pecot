# Issue を開き直す

閉じた Issue を開き直し、ボードの列を戻す。GitHub の公式の MCP のツールで行う。
ボードの自動化が Issue を閉じ直さないよう、Issue を開く前にボードのカードを整える。

1. カードを `projects_list`（`list_project_items`。query は `repo:<owner/repo> is:issue <番号>`）で読む
2. カードが出てこなければ、`projects_write` の `add_project_item` で足す。アーカイブしたカードは一覧に出ず、足すと欄の値を残したまま戻る。戻ったカードを `projects_get`（`get_project_item`）で読む
3. 組み込みの `Status` が `Done` なら、`update_project_item` で null を書いて消す。`Done` のままだと、組み込みの Auto-close issue が閉じ直す
4. `pecot-status` を `update_project_item` で書く。指定が無ければ `Ready`
5. `issue_check`（`update`・`state: open`）に通してから、`issue_write`（`update`・`state: open`）で開く
6. 数秒おいて `issue_read`（`get`）で読み、閉じていれば 5 をもう一度行う。ボードの自動化は、開いた直後に閉じ直すことがある
7. 開き直す理由があれば、[Issue とコメントを公式の MCP で書く](issue-write.md) の手順でコメントを書く。テンプレートは無いので、`issue_comment_check` には `template` を渡さない

2 で足したカードの欄がすべて空なら、カードはボードに無かった。そのことを利用者に伝える。

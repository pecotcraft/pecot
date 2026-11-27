# Issue を開き直す

閉じた Issue を開き直し、ボードの列を戻す。GitHub の公式の MCP のツールで行う。
ボードの自動化が Issue を閉じ直さないよう、Issue を開く前にボードのカードを整える。

1. カードを `projects_list`（`list_project_items`。query は `repo:<owner/repo> is:issue <番号>`）で読む。`pecot-lane` の値を控える
2. カードがアーカイブされていれば、`projects_write` の `delete_project_item` で外し、`add_project_item` で足し直す。公式の MCP に、アーカイブを解く手が無いからだ。足し直したら、控えた `pecot-lane` を `update_project_item` で書き戻す
3. 組み込みの `Status` が `Done` なら、`update_project_item` で null を書いて消す。`Done` のままだと、組み込みの Auto-close issue が閉じ直す
4. `pecot-status` を `update_project_item` で書く。指定が無ければ `Ready`
5. `issue_check`（`update`・`state: open`）に通してから、`issue_write`（`update`・`state: open`）で開く
6. 数秒おいて `issue_read`（`get`）で読み、閉じていれば 5 をもう一度行う。ボードの自動化は、開いた直後に閉じ直すことがある
7. 開き直す理由があれば、[Issue とコメントを公式の MCP で書く](issue-write.md) の手順でコメントを書く。テンプレートは無いので、`issue_comment_check` には `template` を渡さない

カードがボードに無いときは、2〜4 を飛ばし、ボードに無いことを利用者に伝える。

---
template: "pecot-template://issue/task"
kind: task
owner: ""
repo: ""
title: ""
type: ""
labels: []
parent_owner: ""
parent_repo: ""
parent_issue_number: null
blocked_by: []
project_fields: []
---

<!--
読者: /pecot-w:w-active で plan を立てる実装者と、完了を判定する人。末尾の「例:」の形で書く。

書き方:
- 見出しの `—` の後は、何がどうなったか（どうなるか）を、主語と述語のある 1 文で書く

フィールド:
- 鍵の名前は、書く公式の MCP のツールの引数の名前。`issue_check` に通してから、同じ値を渡す
- template・kind: 変えない
- owner・repo: 起票先のリポ。必須
- title: `[Task] ` で始める。親 Epic があれば `[Task] #{親の番号}-{順}: ` にする。順は 2 桁で、親の sub-issue の題で使っていない番号
- type: リポの Issue type の名前。Issue type を使わないリポでは消す
- labels・assignees・milestone・issue_fields: 要るときだけ書く。`issue_fields` は `issue_write` と同じ `[{field_name, value}]` の形
- parent_owner・parent_repo・parent_issue_number: 親 Epic。無ければ消す。`issue_fields` があるときは `sub_issue_write` で付ける
- blocked_by: この Issue の着手を止める前提の一覧。前提が無ければ `[]` のまま
  - `issue` は、前提の Issue を指す `owner/repo/N`
  - スタック不可の前提だけ、`wait: merge` と、待つ理由の 1 文の `reason`（改行しない）を足す。本文の末尾の `## Waits for merge` の節にも挙げる。行は `- #N: 理由` の形で、書く行は `issue_check` が候補で返す
  - 書く先は `issue_dependency_write`（`type: blocked_by`）
- project_fields: ボードの欄を `[{name, value}]` で書く。書く先は `projects_write` の `update_project_item`
  - `pecot-lane` は、分類したいときだけ書く。書かなければ親 Epic の値にそろえる
  - 置く列（設定の workflow の欄）は、前提があれば `Blocked`、無ければ `Ready`
- 起票ルール: skills/w-help/references/issue-flow-rules.md （投稿先 / 親 Epic / blocked_by の判定基準）

例:

## Goal — `mytool export` が CSV を書き出せる

今は JSON しか書き出せず、表計算ソフトで開くには利用者が自分で変換している。

| コマンド | 今 | 達成後 |
|---|---|---|
| `mytool export --format csv` | エラーで止まる | CSV を書き出す |

## Acceptance — CSV が表計算ソフトでそのまま開ける

- `mytool export --format csv` の出力が、表計算ソフトで列のずれなく開ける — 確認: 実際に書き出して開く

- `--format` を省くと、今までどおり JSON を書き出す — 確認: `mytool export` の出力を読む
-->

## Goal — <達成したい状態を1行で>

<利用者から見て何が変わるか。今と達成後の比較は表にする>

## Acceptance — <達成判定を1行で>

- <外から見える状態> — 確認: <判定の手段>

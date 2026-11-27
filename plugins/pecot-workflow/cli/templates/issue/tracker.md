---
template: "pecot-template://issue/tracker"
kind: tracker
owner: ""
repo: ""
title: ""
type: ""
labels: []
project_fields: []
---

<!--
読者: この Tracker が束ねる対象を追う人（運用する人と AI）。何を束ね、どう運用するかを確かめて、sub-issue の表示と見比べる。末尾の「例:」の形で書く。

書き方:
- 見出しの `—` の後は、何がどうなったか（どうなるか）を、主語と述語のある 1 文で書く
- 束ねる対象は、対象の種類と集め方を書く。個々の Issue へのリンク・担当・進み具合は書かない（sub-issue の表示とボードが見せる）

フィールド:
- 鍵の名前は、書く公式の MCP のツールの引数の名前。`issue_check` に通してから、同じ値を渡す
- template・kind: 変えない
- owner・repo: 起票先のリポ。必須（Tracker は aggregation_repo へ寄せない）
- title: `[Tracker] ` で始める
- type: リポの Issue type の名前。Issue type を使わないリポでは消す
- labels・assignees・milestone・issue_fields: 要るときだけ書く。`issue_fields` は `issue_write` と同じ `[{field_name, value}]` の形
- project_fields: ボードの欄を `[{name, value}]` で書く。書く先は `projects_write` の `update_project_item`
  - `pecot-lane` は、分類したいときだけ書く
  - 置く列（設定の workflow の欄）は `Backlog`
- 起票ルール: skills/w-help/references/issue-flow-rules.md （投稿先 / 親 Epic / blocked_by の判定基準）

例:

## Scope — 依存パッケージの脆弱性の通知を、このリポジトリの Issue として束ねる

- 束ねる対象 — 依存パッケージの脆弱性の通知 1 件につき sub-issue 1 件

- 集め方 — 毎時の確認が、新しい通知を sub-issue に足す

## Operation — 通知が直ったら、その sub-issue を閉じる

- 閉じ方 — 通知が解消したら sub-issue を閉じる

- この Issue — sub-issue を持つ間は閉じない
-->

## Scope — <束ねる対象を1行で>

- 束ねる対象 — <対象の種類と、sub-issue 1 件の単位>

- 集め方 — <sub-issue を足す手段>

## Operation — <運用の決まりを1行で>

- 閉じ方 — <sub-issue を閉じる条件>

- この Issue — <この Issue を閉じる条件>

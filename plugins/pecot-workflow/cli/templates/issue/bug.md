---
template: "pecot-template://issue/bug"
kind: bug
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
読者: バグを再現して直す実装者。Repro で再現し、直した後に Acceptance で確かめる。末尾の「例:」の形で書く。

書き方:
- 見出しの `—` の後は、何がどうなったか（どうなるか）を、主語と述語のある 1 文で書く
- 長いログは `<details>` に入れる

フィールド:
- 鍵の名前は、書く公式の MCP のツールの引数の名前。`issue_check` に通してから、同じ値を渡す
- template・kind: 変えない
- owner・repo: 起票先のリポ。必須
- title: `[Bug] ` で始める。親 Epic があれば `[Bug] #{親の番号}-{順}: ` にする。順は 2 桁で、親の sub-issue の題で使っていない番号
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

## Problem — `list --sort date` が日付を文字列として並べる

`2026-10-02` が `2026-9-30` より前に並ぶ。環境: Linux・mytool 1.3.0

| 期待する動き | 今の動き |
|---|---|
| 日付の古い順に並ぶ | 文字列の順に並ぶ |

### Repro

1. `mytool add --date 2026-9-30 a` と `mytool add --date 2026-10-02 b` を打つ

2. `mytool list --sort date` を打ち、`b` が `a` より前に並ぶことを見る

## Acceptance — `--sort date` が日付の古い順に並べる

- Repro の手順で、`a` が `b` より前に並ぶ — 確認: Repro の手順を打つ
-->

## Problem — <何が起きているか1行で>

<何をしたら何が起きるか。環境と、期待する動き・今の動きの表>

| 期待する動き | 今の動き |
|---|---|
| <本来の動き> | <今起きている動き> |

### Repro

1. <手順>

2. <手順>

## Acceptance — <直った状態を1行で>

- <外から見える状態> — 確認: <判定の手段>

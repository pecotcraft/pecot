---
template: "pecot-template://issue/task-implement"
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
読者: フェーズを実行する実装者。Artifacts の spec と plan を読んで Tasks を進め、Acceptance で完了を判定する。末尾の「例:」の形で書く。

書き方:
- Tasks は、tasks.md のこのフェーズのタスクを過不足なく写す。記法 `T001 [P] [US1] 説明（ファイルパス含む）` のまま、1 行に 1 タスク
- Acceptance は、Tasks と同じく tasks.md のこのフェーズから写す。`**Checkpoint**:` の行と、あれば `**Independent Test**:` の行を、言い換えずに 1 行に 1 つ写す
- Artifacts は、speckit の一式を置いたディレクトリを 1 つ、実パスで書く。外部のリポにあるときは `owner/repo:specs/NNN-*/` の形

フィールド:
- 鍵の名前は、書く公式の MCP のツールの引数の名前。`issue_check` に通してから、同じ値を渡す
- template・kind: 変えない
- owner・repo: 起票先のリポ。必須
- title: `[Task] ` で始める。親 Epic があれば `[Task] #{親の番号}-{順}: ` にする。順は 2 桁で、親の sub-issue の題で使っていない番号
- type: リポの Issue type の名前。Issue type を使わないリポでは消す
- labels・assignees・milestone・issue_fields: 要るときだけ書く。`issue_fields` は `issue_write` と同じ `[{field_name, value}]` の形
- parent_owner・parent_repo・parent_issue_number: 親 Epic。無ければ消す。`issue_fields` があるときは `sub_issue_write` で付ける
- blocked_by: この Issue の着手を止める前提の一覧。前提が無ければ `[]` のまま
  - `issue` は、同じ一括の Issue の key（ファイルの名前の幹）か、Issue 化済みのフェーズを指す `owner/repo/N`
  - スタック不可の前提だけ、`wait: merge` と、前提の表の `理由` の文をそのまま写した `reason`（改行しない）を足す
  - スタック不可の前提は、本文の末尾の `## Waits for merge` の節にも挙げる。行は `- #N: 理由` の形で、書く行は `issue_check` が候補で返す
  ```yaml
  blocked_by:
    - issue: phase3
    - issue: phase4
      wait: merge
      reason: "action は、既定のブランチのプラグインを入れる。main に入るまで、確認ができない"
  ```
  - 書く先は `issue_dependency_write`（`type: blocked_by`）
- project_fields: ボードの欄を `[{name, value}]` で書く。書く先は `projects_write` の `update_project_item`
  - `pecot-lane` は、分類したいときだけ書く。書かなければ親 Epic の値にそろえる
  - 置く列（設定の workflow の欄）は、前提があれば `Blocked`、無ければ `Ready`
- 起票ルール: skills/w-help/references/issue-flow-rules.md （投稿先 / 親 Epic / blocked_by の判定基準）

例:

## Goal

`mytool export --format csv` で、CSV のファイルを書き出せるようにする。書き出しの処理に形式の選択を足し、CSV の書き手を新しく加える。

## Tasks

- T004 [US1] `src/export.py` に `--format` を足し、選んだ形式の書き手に書き出しを渡す
- T005 [P] [US1] `src/writers/csv.py` に、`mytool list` と同じ列の順で書く CSV の書き手を足す

## Acceptance

- Checkpoint: この時点で、CSV の書き出しが単独で動き、確かめられる
- Independent Test: `mytool export --format csv` で書き出したファイルを表計算ソフトで開き、列がずれずに並ぶことを見る

## Artifacts

`acme/mytool:specs/012-csv-export/`
-->

## Goal

<このフェーズが終わると何ができるようになるか>

## Tasks

- T001 [P] [US1] <説明（ファイルパス含む）>
- T002 [US1] <説明（ファイルパス含む）>

## Acceptance

- Checkpoint: <tasks.md のこのフェーズの Checkpoint>
- Independent Test: <tasks.md のこのフェーズの Independent Test。無ければこの行を消す>

## Artifacts

`<owner/repo>:specs/<NNN-feature>/`

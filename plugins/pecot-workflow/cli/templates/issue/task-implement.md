---
title: ""
type: task
template: task-implement
repository: ""
priority: ""
size: ""
labels: []
parent_epic: ""
blocked_by: []
---

<!--
読者: フェーズを実行する実装者。Artifacts の spec と plan を読んで Tasks を進め、Acceptance で完了を判定する。末尾の「例:」の形で書く。

書き方:
- Tasks は、tasks.md のこのフェーズのタスクを過不足なく写す。記法 `T001 [P] [US1] 説明（ファイルパス含む）` のまま、1 行に 1 タスク
- Acceptance は、Tasks と同じく tasks.md のこのフェーズから写す。`**Checkpoint**:` の行と、あれば `**Independent Test**:` の行を、言い換えずに 1 行に 1 つ写す
- Artifacts は、speckit の一式を置いたディレクトリを 1 つ、実パスで書く。外部のリポにあるときは `owner/repo:specs/NNN-*/` の形

フィールド:
- repository: 実装が行われるリポ `owner/repo` 必須
- parent_epic: 親 Epic を `owner/repo/number` で指定（推奨）
- blocked_by: このフェーズの着手を止める前提の一覧。前提が無ければ `[]` のまま
  - 要素は `issue`（必須）。同じ一括投稿の Issue ファイルのキー（`suffix`）か、Issue 化済みのフェーズを指す `owner/repo/N`
  - 積める前提は `issue` だけを書く。マージを待つ前提だけ、`wait: merge` と、1 行の `reason` を足す
  - 書き方は `- issue: phase3` と、`- issue: phase4` に `wait: merge`・`reason: "..."` を続ける形
- order・status: 書かない。通し番号と置く列は CLI が決める
- 起票ルール: skills/w-help/references/issue-flow-rules.md （投稿先 / parent_epic / order の判定基準）

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

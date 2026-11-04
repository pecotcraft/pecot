---
title: ""
type: bug
repository: ""
status: ready
priority: ""
size: ""
labels: []
parent_epic: ""
order: ""
---

<!--
読者: バグを再現して直す実装者。Repro で再現し、直した後に Acceptance で確かめる。末尾の「例:」の形で書く。

書き方:
- 見出しの `—` の後は、何がどうなったか（どうなるか）を、主語と述語のある 1 文で書く
- 長いログは `<details>` に入れる

フィールド:
- repository: 起票先 `owner/repo` 必須
- parent_epic: `owner/repo/number` 推奨。番号のみは aggregation_repo 解釈なので別リポの Epic を指すなら full path 必須
- order: 親 Epic 内の通し番号。タイトル先頭が `#{epic}-{order:02d}` で自動生成
- 起票ルール: skills/w-help/references/issue-flow-rules.md （投稿先 / parent_epic / order の判定基準）

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

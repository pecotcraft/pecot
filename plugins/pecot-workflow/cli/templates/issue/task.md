---
title: ""
type: task
repository: ""
labels: []
parent_epic: ""
lane: ""
blocked_by: []
---

<!--
読者: /pecot-w:w-active で plan を立てる実装者と、完了を判定する人。末尾の「例:」の形で書く。

書き方:
- 見出しの `—` の後は、何がどうなったか（どうなるか）を、主語と述語のある 1 文で書く

フィールド:
- repository: 起票先 `owner/repo` 必須
- parent_epic: `owner/repo/number` 推奨。番号のみは aggregation_repo 解釈なので別リポの Epic を指すなら full path 必須
- lane: 分類したいときだけ、ボードの `pecot-lane` の値を書く。空なら親 Epic の値が入る
- blocked_by: この Issue の着手を止める前提の一覧。前提が無ければ `[]` のまま
  - `issue` は、前提の Issue を指す `owner/repo/N`
  - スタック不可の前提だけ、`wait: merge` と、待つ理由の 1 文の `reason`（改行しない）を足す
  ```yaml
  blocked_by:
    - issue: acme/mytool/12
    - issue: acme/mytool/13
      wait: merge
      reason: "action は、既定のブランチのプラグインを入れる。main に入るまで、確認ができない"
  ```
- order・status: 書かない。通し番号（タイトル先頭の `#{epic}-NN`）と置く列（前提があれば `Blocked`、無ければ `Ready`）は CLI が決める
- 起票ルール: skills/w-help/references/issue-flow-rules.md （投稿先 / parent_epic / blocked_by の判定基準）

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

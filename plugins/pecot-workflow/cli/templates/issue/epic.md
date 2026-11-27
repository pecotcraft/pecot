---
template: "pecot-template://issue/epic"
kind: epic
owner: ""
repo: ""
title: ""
type: ""
labels: []
project_fields: []
---

<!--
読者: この Epic を分解する人（/pecot-w:w-ready・/pecot-w:w-breakdown を回す人と AI）。GAP と sub-issue の表示を見比べて次の 1 件を決め、AS-IS が TO-BE に届いたら Epic を閉じる。末尾の「例:」の形で書く。

書き方:
- 見出しの `—` の後は、何がどうなったか（どうなるか）を、主語と述語のある 1 文で書く
- GAP は、AS-IS と TO-BE の差を書く。サブタスクや Issue へのリンク・担当・進み具合は書かない（sub-issue の表示とボードが見せる）

フィールド:
- 鍵の名前は、書く公式の MCP のツールの引数の名前。`issue_check` に通してから、同じ値を渡す
- template・kind: 変えない
- owner・repo: aggregation_repo を設定していれば、そのリポ。設定が無いか例外のときだけ、ほかのリポを書く
- title: `[Epic] ` で始める
- type: リポの Issue type の名前。Issue type を使わないリポでは消す
- labels・assignees・milestone・issue_fields: 要るときだけ書く。`issue_fields` は `issue_write` と同じ `[{field_name, value}]` の形
- project_fields: ボードの欄を `[{name, value}]` で書く。書く先は `projects_write` の `update_project_item`
  - `pecot-lane` は、分類したいときだけ書く
  - 置く列（設定の workflow の欄）は `Backlog`
- 起票ルール: skills/w-help/references/issue-flow-rules.md （投稿先 / 親 Epic / blocked_by の判定基準）

例:

## AS-IS — 表計算ソフトの利用者が JSON を手で変換している

- 書き出しの形式は JSON だけ — 問い合わせの 3 割が変換の方法

- 並べ替えは文字列の比較だけ — 日付と数値の列で順が崩れる

## TO-BE — 表計算ソフトの利用者が変換なしで出力を使える

- **CSV で書き出せる**

- **日付と数値の列が、値の順に並ぶ**

## GAP — 書き出しの形式と並べ替えの比較が足りない

- 書き出し — CSV の形式が無い

- 並べ替え — 列の型に合わせた比較が無い
-->

## AS-IS — <現状を1行で>

- <事実> — <数字・実例での裏付け>

## TO-BE — <完了時の状態を1行で>

- **<残るもの・変わるもの>**

## GAP — <埋めるべき差分を1行で>

- <差のある場所> — <AS-IS と TO-BE の差>

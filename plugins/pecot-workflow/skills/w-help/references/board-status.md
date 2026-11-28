# ボードステータス

## 進行の欄

| ステータス | 用途 |
|-----------|------|
| Backlog | Epic・Tracker置き場（直接作業しない） |
| Pending | 人が後回しにした（Epic／タスク）。人だけが出し入れする |
| Blocked | 前提を待っているタスク。pecot が置き、pecot が出す |
| Ready | 今、着手できるタスク |
| Active | 作業中（**作業開始時に必ず設定**） |
| In Review | PR が出ている |
| Archived | 手動退避（完了はStatusフィールドで管理） |

### Pending・Blocked・Ready の違い

| | Pending | Blocked | Ready |
|---|---|---|---|
| 置く理由 | 人が、今はやらないと決めた | 進める予定だが、前提（先に終える Issue、マージ待ちの PR）を待っている | 今、着手できる |
| 動かす者 | 人だけ | pecot だけ | pecot |
| 出る条件 | 人が別の列へ動かしたとき | 前提がそろい、着手できると判定されたとき | 着手の操作で Active に移ったとき。前提が崩れたときは Blocked に戻る |

- 列を動かすものは 2 つある
  - pecot の操作: 着手・PR の作成・片付けなどが、その場で列を動かす
  - ワークフロー: pecot の action の board-sync を GitHub Actions で動かし、ボード全体を判定に合わせて、列と札を直す。待ち受けるセッションの無い画面でのマージ・blocked by の付け外し・カードの手での移動で、ずれたものが対象になる
    - 入れるかは任意で、置き方は[ボードを自動で直すワークフロー](board-sync-workflow.md)にある
- pecot-workflow の MCP ツール `board_show` は列を動かさない。判定と食い違いそうな Issue があると、件数と直し方の案内を警告で返す
- `Ready` には、着手できるタスクだけを置く。前提を待つタスクは `Blocked` に置く

## 既定の Status

| ステータス | 用途 |
|-----------|------|
| Todo | 作業が残っている |
| In Progress | 着手済みで PR がある |
| Done | 完了 |
| Needs Attention | 人の対応か判断を待っている。pecot が置く |

## 領域のレーン（`pecot-lane`）

`pecot-lane` は、作業の領域を表す single select のフィールドです。ボードの `Lanes` のビューが、列を `pecot-status`、横のレーンを `pecot-lane` に分けて出します。
着手できるタスクの無い領域が、ビューを開くだけで分かります。

- 値は利用者が決める。プラグイン・チーム・サービスなど、作業を分けたい単位にする。GitHub の画面に出るので、英語の名前にする
- 値は、pecot-workflow の MCP ツール `project_check`（`fields`）の `lanes` で渡す。`project_check` は、既存の値を残して足りない値だけを `problems` に挙げる。足すのは github-ops の `project-fields`（[トラブルシューティング](troubleshooting.md) の「ボードの欄を足す・直す」）
- `lanes` を渡さないと、`project_check` は `pecot-lane` を求めない
- `Lanes` のビューは、github-ops の `project-view` で作り、結果の `url` で開く。`params` は次の形にする

  ```text
  {"project": <ボードの番号>, "name": "Lanes", "column": "pecot-status", "row": "pecot-lane"}
  ```

- 値の無い Issue は、ビューの「No pecot-lane」のレーンに入る

## ボードに値が無いとき

`Blocked` と `Needs Attention` は、あれば使う値です。無いボードでも pecot は止まらず、列を動かしません。

値を足すときは、[トラブルシューティング](troubleshooting.md) の「ボードの欄を足す・直す」の手順で足す。

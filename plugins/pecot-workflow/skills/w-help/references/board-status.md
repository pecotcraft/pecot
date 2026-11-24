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

- 列を動かすものは 3 つある
  - pecot の操作: 着手・PR の作成・片付けなどが、その場で列を動かす
  - pecot-workflow の MCP ツール `board_sync`: ボード全体を判定に合わせて、列と札を直す。画面でのマージ・blocked by の付け外し・カードの手での移動で、ずれたものが対象になる。手元でも GitHub Actions でも同じコマンドを打つ
  - ワークフロー: `board_sync` を GitHub Actions で打つ。入れるかは任意で、置き方は[ボードを自動で直すワークフロー](board-sync-workflow.md)にある
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
- 値は、pecot-workflow の MCP ツール `project_create`・`project_init` の `lanes` で渡す。`project_init` は、既存の値を残して足りない値だけを足す
- `lanes` を渡さず、ボードに `pecot-lane` も無いときは、フィールドを作らず、値を決めるよう案内する
- `Lanes` のビューは、結果の `view.url` で開く。ビューを作れなかったときは、`view.manual_steps` の手順で画面から作る
- 値の無い Issue は、ビューの「No pecot-lane」のレーンに入る

## ボードに値が無いとき

`Blocked` と `Needs Attention` は、あれば使う値です。無いボードでも pecot は止まらず、列を動かしません。

値を足すときは、pecot-workflow の MCP ツール `project_init` を呼ぶ。

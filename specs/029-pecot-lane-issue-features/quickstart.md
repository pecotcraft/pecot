# Quickstart: pecot のフィールドの整理と、Issue の機能の担保を確かめる

確かめは、`plugins/pecot-workflow/CONTRIBUTING.md` の「3. 試験環境」に従い、検証用のリポ `pecotcraft/pecot-sandbox` とボード `pecot sandbox`（Projects の 3 番）で行う。

このリポのボードを移すのは、最後の「このリポへの導入」だけにする。棚卸しで見つけた不適合と「使う」とした機能の起票（tasks.md の Phase 9）は、確かめではないので、このリポに起票する。

入力と出力の形は [contracts/mcp-tools.md](contracts/mcp-tools.md)、値の決まりは [data-model.md](data-model.md) を見る。

## 前提

- 検証用の clone を `.pecot/work/<Issue番号>/pecot-sandbox/` に作り、直した作業ツリーの pecot-workflow で Claude Code を起こしている
- 検証用のボードは、確かめの前に今の形（`pecot-workflow-sandbox`・`pecot-priority`・`pecot-size`）になっている。違えば、確かめの前に作り直す

## A-1. 既存のボードの移行（US4・US4b）

1. `project_init` を `confirm_delete` なしで呼ぶ
   - 期待: `pecot-workflow-sandbox` が `pecot-status` になる。Issue の進行の欄の値は前と同じ。設定ファイルが `_sandbox` の無い名前に移る。`migration.pending_delete` に `pecot-priority`・`pecot-size` が出て、まだ消えていない
2. `board_show` と `board_sync` を呼ぶ
   - 期待: 移行の前と同じ Item・同じ列。`pecot-priority`・`pecot-size` が残っていても止まらない
3. `project_init` を `confirm_delete: true` で呼ぶ
   - 期待: 2 つのフィールドが消え、`migration.deleted` に出る

## A-2. `pecot-lane` とレーンのビュー（US1）

1. `project_init` を `lanes: ["alpha", "beta"]` で呼ぶ
   - 期待: `pecot-lane` ができる。ボードに `Lanes` のビューができ、列が `pecot-status`、横のレーンが `pecot-lane`
2. ボードの画面で `Lanes` を開く
   - 期待: 値の無い Issue は「No pecot-lane」のレーンに入る
3. `project_init` を `lanes: ["gamma"]` で呼ぶ
   - 期待: 選択肢が alpha・beta・gamma になり、既存の Issue の値は消えない

## A-3. 起票・同期・一覧（US2・US3）

1. w-quick で 1 件起票する
   - 期待: 起票の内容から `pecot-lane` が決まって入る。`pecot-priority`・`pecot-size` を聞かれない
2. `issue_create` を `lane: "delta"`（無い値）で呼ぶ
   - 期待: Issue を作らずに止まり、取りうる値が出る
3. ボードの画面で `pecot-lane` に選択肢 `epsilon` を足し、`project_init` を呼ばずに `issue_create` を `lane: "epsilon"` で呼ぶ
   - 期待: 止まらずに起票でき、`epsilon` が入る（選択肢を設定に写さないので、画面の変更がすぐ使える）
4. `pecot-lane` の入った Epic の下に、`lane` なしでタスクを起票する
   - 期待: タスクに親と同じ値が入る
5. ボードの画面で `pecot-lane` の無い Issue を 1 件作り、`board_sync` を呼ぶ
   - 期待: `missing_lane` にその Issue が出て、警告が 1 行出る。同期は終わる
6. `board_show` を呼び、w-active を始める
   - 期待: `lanes` に alpha・beta・gamma・epsilon と値なしの組が、件数つきで出る。件数 0 の値も出る。w-active の候補が領域ごとに分かれる

## A-4. 新しいボード（US1・US4）

1. `project_create` を `lanes` つき・`suffix` なしで呼ぶ
   - 期待: `pecot-status` と `pecot-lane` とビューができる。`pecot-priority`・`pecot-size` はできない
2. `project_create` に `suffix` を渡す
   - 期待: 無い入力として止まる

## B-1. 名前で機能を扱う（US5）

1. 検証用のボードに、pecot が知らないフィールドを 6 種類足す（single select・multi select・text・number・date・iteration）
2. `issue_attributes` を呼ぶ
   - 期待: 6 つのフィールドと、Issue fields・Issue type・ラベル・マイルストーンが、種類と取りうる値つきで出る
3. `issue_create` を、6 つのフィールドと `assignees`・`milestone`・`type` を `attributes` に入れて呼ぶ
   - 期待: すべての値が入る。`issue_show` の `attributes` に、すべて名前と値で出る
4. `issue_edit` で、2 つの値を変え、1 つを `null` で外す
   - 期待: 変えた値と外した値が `changed` に出て、ボードと Issue に反映される
5. 数値のフィールドに `"big"`、無い選択肢、無い名前を混ぜて `issue_create` を呼ぶ
   - 期待: Issue ができない。`errors` に 3 件、それぞれの取りうる値か似た名前が出る
6. `attributes` を渡さずに `issue_create` を呼ぶ
   - 期待: 止まらずに起票でき、どの機能も空のまま
7. `issue_edit` で、`attributes` の `pecot-status` を `Ready` にする
   - 期待: 何も書かずに `read_only_attribute` で止まり、`board_move` を使うよう出る

## B-2. 担保の確かめ（US5）

1. 手元で `pecot-workflow:test-cli` の担保のテストのファイルだけを動かす
   - 期待: 通る
2. 担保の一覧から `supported` の項目を 1 つ消して、同じテストを動かす
   - 期待: 消した項目を挙げて落ちる。確かめたら戻す
3. 写しに無い項目を 1 つ足した SDL を、定期の確かめのスクリプトに渡す（`--sdl <ファイル>`・`--openapi <ファイル>` で、GitHub に取りに行かない）
   - 期待: 増えた項目を挙げた差が出る。`--dry-run` では Issue を作らず、作る予定の題と本文と印を出す
4. 同じ差でもう一度動かす
   - 期待: 同じ印の Issue があるとして、作らない。差が変わったときは、新しく作らず、開いた差の Issue の題と本文を書き直す

## このリポへの導入（FR-011・FR-012・FR-032）

PR がマージされ、リリースされた pecot-workflow で行う。

1. このリポで `project_init` を `lanes: ["pecot-workflow", "pecot-visual", "pecot-tools", "repo"]` で呼ぶ
2. 開いている Issue のすべてに `pecot-lane` を入れ、`board_sync` の `missing_lane` が空になることを確かめる
3. 利用者の確認を取ってから、`confirm_delete: true` で `project_init` を呼ぶ
4. `Lanes` のビューを開き、着手できるタスクの無い領域が分かることを確かめる（SC-001）

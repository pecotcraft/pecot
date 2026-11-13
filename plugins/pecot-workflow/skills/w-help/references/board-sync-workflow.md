# ボードを自動で直すワークフロー

`board_sync` を GitHub Actions で打つ雛形です。置くかどうかは任意で、置かなくても手元で `board_sync` を呼べば同じ列と札に直ります。

## 雛形と置き先

- 雛形: `${CLAUDE_PLUGIN_ROOT}/cli/templates/workflow/pecot-board-sync.yml`
- 置き先: 利用者のリポの `.github/workflows/pecot-board-sync.yml`
- 置くのは雛形をそのまま写したファイルだけとする。書き換えるのは、`schedule` のコメントを外すときと、版を固定するときだけだ

## 動く契機

| 契機 | 拾う変化 |
|---|---|
| `pull_request_target`（`opened`・`reopened`・`closed`・`ready_for_review`・`converted_to_draft`） | PR の作成・マージ・クローズ・ドラフトの切り替え |
| `issues`（`closed`・`reopened`） | Issue のクローズと開き直し |
| `workflow_dispatch` | Actions の画面からの手での起動 |

blocked by の付け外しとカードの移動は、GitHub の webhook にあっても Actions の契機に無いので、拾えません。`schedule` を有効にするか、手元で `board_sync` を呼んで直します。

## 設定の JSON を既定ブランチに置く

Actions の checkout には `.active` が入りません。`.pecot/config/projects/<設定名>.json` が既定ブランチに入っている必要があります。

1. ルートの `.gitignore` が `.pecot/config/` を除外していないか確かめる
2. 設定の JSON を既定ブランチへ入れる
3. 設定の JSON が 1 つなら、`board_sync` はそれを使う。2 つ以上あるときは `--project <設定名>` が要るので、雛形の実行の行に足す

## token を用意する

どちらか 1 つを用意します。どちらの variable も無い間は、job が失敗せずに飛びます。

### GitHub App（既定）

- App の権限
  - 組織の Projects: read and write
  - リポの Issues・Pull requests・Contents: read
- リポの variable `PECOT_BOARD_SYNC_APP_CLIENT_ID` に App の Client ID を置く
- リポの secret `PECOT_BOARD_SYNC_APP_PRIVATE_KEY` に秘密鍵を置く

### PAT

- classic PAT を使う。権限は `project` で、private のリポなら `repo` も要る
- リポの variable `PECOT_BOARD_SYNC_USE_PAT` に `true` を置く
- リポの secret `PECOT_BOARD_SYNC_TOKEN` に PAT を置く

## GHES

github.com 以外のホストでは、token を渡す環境変数の名前が変わります。名前は `PECOT_GITHUB_<HOST>_TOKEN` で、`<HOST>` はホスト名を大文字にし、ドットをアンダースコアに替えたものです。

例は `ghe.example.com` の `PECOT_GITHUB_GHE_EXAMPLE_COM_TOKEN` です。github.com は `PECOT_GITHUB_COM_TOKEN` です。

## 定期の実行を足す

雛形の `schedule` はコメントです。使うときは、コメントを外して cron の間隔を選びます。

- `schedule` で、画面での blocked by の付け外しと、カードの手での移動も拾える
- private のリポでは、1 回の実行が切り上げで 1 分として数えられる。毎時の実行は、月に約 720 回だ
- 料金は GitHub の Actions の料金のページで確かめる

## 版を固定する

雛形は `npx -y --prefix=/ @pecot/workflow-mcp@5 board sync` を打ち、major の最新に追従します。`@5.1.0` のように書くと、版を固定できます。

## 試す

Actions の画面から `workflow_dispatch` で 1 回起動し、ログの `moved:`・`set:`・warning の行を読みます。ボードへ書かずに見るときは、実行の行へ `--dry-run` を足します。

# ボードを自動で直すワークフロー

`board_sync` を GitHub Actions で打つ雛形です。置くかどうかは任意で、置かなくても手元で `board_sync` を呼べば同じ列と札に直ります。

## 前提

- `board_sync` は `@pecot/workflow-mcp` の 6.0.0 から入っている。雛形は、実行の行に書いた major の最新に追従する
- 利用者のリポが GHES にあるときは、次の 2 つも前提になる
  - SHA で固定した版の action（`actions/checkout`・`actions/setup-node`・`actions/create-github-app-token`）を使える
  - Actions の実行環境から npm の registry に届く

## 雛形と置き先

- 雛形: `${CLAUDE_PLUGIN_ROOT}/cli/templates/workflow/pecot-board-sync.yml`
- 置き先: 利用者のリポの `.github/workflows/pecot-board-sync.yml`
- 置くのは雛形をそのまま写したファイルだけとする。書き換えてよいのは次の箇所だけだ
  - `schedule` のコメントを外して、cron の間隔を選ぶ
  - 版を固定する
  - 設定が 2 つ以上あるとき、実行の行へ `--project` を足す
  - 試すとき、実行の行へ `--dry-run` を足す
  - GHES のとき、token の環境変数の名前を替える

## 動く契機

| 契機 | 拾う変化 |
|---|---|
| `pull_request_target`（`opened`・`reopened`・`closed`・`ready_for_review`・`converted_to_draft`） | PR の作成・マージ・クローズ・ドラフトの切り替え |
| `issues`（`closed`・`reopened`） | Issue のクローズと開き直し |
| `workflow_dispatch` | Actions の画面からの手での起動 |

次の変化は契機に無いので、拾えません。`schedule` を有効にするか、手元で `board_sync` を呼んで直します。

- blocked by の付け外し
- カードの移動
- PR の本文を後から直して、Issue と結び付けたとき（`edited`）

### merge queue のリポ

PR を merge queue がマージしたときも、`pull_request_target` の `closed` の実行が起き、secret が渡ります。

- 確かめた実行では、actor は PR を出して queue へ入れた人と同じだった。PR を出した人と queue へ入れた人が違う場合は、確かめていない
- `Closes #N` で閉じた Issue の `issues` の実行も、別に起きる。同じ group の実行は順に動き、どちらも成功する

## ボードが複数のリポを持つとき

契機は、雛形を置いたリポの PR と Issue だけを拾います。ほかのリポの変化は、そのリポに雛形が無ければ拾えません。

- 全部のリポに雛形を置く
- 1 つのリポに置き、ほかのリポの変化は `schedule` か、手元の `board_sync` で補う

設定の JSON は、雛形を置くリポごとに要ります。

## 設定の JSON を既定ブランチに置く

Actions の checkout には `.active` が入りません。`.pecot/config/projects/<設定名>.json` が既定ブランチに入っている必要があります。

1. どれが設定かを調べる。`board_show` の Overview にある Project の名前が、ファイル名になる
2. ルートの `.gitignore` が `.pecot/` を丸ごと除外しているときは、その行を外す
3. `.pecot/.gitignore` が設定の JSON を許可しているか確かめる。許可の一覧は `pecot-gitignore-ensure.sh` が作り、`!/config/projects/*.json` の行が JSON を戻す
4. 設定の JSON を既定ブランチへ入れる
5. 設定の JSON が 1 つなら、`board_sync` はそれを使う。2 つ以上あるときは `--project <設定名>` が要るので、雛形の実行の行に足す

## token を用意する

どちらか 1 つを用意します。どちらの variable も無い間は、job が失敗せずに飛びます。

### GitHub App

ボードとリポの所有者が同じ組織のときに使います。雛形が作る token は、その所有者への installation の範囲に限られるためです。個人のアカウントのボードと、所有者の違うボードには合いません。

- App の権限
  - 組織の Projects: read and write
  - リポの Issues・Pull requests・Contents: read
- リポの variable `PECOT_BOARD_SYNC_APP_CLIENT_ID` に App の Client ID を置く
- リポの secret `PECOT_BOARD_SYNC_APP_PRIVATE_KEY` に秘密鍵を置く

### PAT

個人のアカウントのボードと、リポと所有者の違うボードでは、こちらを使います。

- classic PAT を使う。権限は `project` で、private のリポなら `repo` も要る
- リポの variable `PECOT_BOARD_SYNC_USE_PAT` に `true` を置く
- リポの secret `PECOT_BOARD_SYNC_TOKEN` に PAT を置く

fine-grained PAT は、この 2 つの場面に使えません。

- 個人のアカウントの Projects を扱えない
- token の持ち主は 1 つで、持ち主の違うリポとボードをまたげない

根拠は GitHub の [personal access token の文書](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)です。ボードとリポが同じ組織なら、PAT より GitHub App を使います。

## 実行の結果

書き込みが 1 件でも失敗すると、実行が失敗（終了コード 1）で終わります。token の権限が足りないときは、ここで気づけます。

## GHES

github.com 以外のホストでは、token を渡す環境変数の名前が変わります。名前は `PECOT_GITHUB_<HOST>_TOKEN` で、`<HOST>` はホスト名を大文字にし、ドットをアンダースコアに替えたものです。

例は `ghe.example.com` の `PECOT_GITHUB_GHE_EXAMPLE_COM_TOKEN` です。github.com は `PECOT_GITHUB_COM_TOKEN` です。

## 定期の実行を足す

雛形の `schedule` はコメントです。使うときは、コメントを外して cron の間隔を選びます。

- `schedule` で、画面での blocked by の付け外しと、カードの手での移動も拾える
- private のリポでは、1 回の実行が切り上げで 1 分として数えられる。毎時の実行は、月に約 720 回だ
- 料金は GitHub の Actions の料金のページで確かめる

### GraphQL の点数

1 回の実行で使う点数は、ボードの大きさで決まります。GitHub の点数の計算法でクエリを数えると、上限は次の式です。

`4 × ⌈N / 100⌉ + R + W + S`

| 記号 | 数えるもの | 1 回の点数 |
|---|---|---|
| N | ボードの全アイテムの数。`Done` と閉じた Issue も含む | 100 件の 1 ページで 4 点。1 件ごとに 4 つの一覧を読むため |
| R | 個別に読む Issue の数。`Ready`・`Blocked`・`Active`・`In Review` の開いた Issue。前提の無い `Ready` と、PR・Tracker を除く | 1 件 1 点。前提が 9 件以上ある Issue は 2 点以上 |
| W | 書き込む列と札の数。ログの `moved:`・`set:` の行の数 | 1 回 1 点として数える |
| S | 積む先の PR を引き足した数。前提の PR が開発ブランチに届かないときだけ起きる | 1 回 1 点 |

- 例: N が 31・R が 7・W が 4・S が 0 の実行は、式で 15 点になる。終わりの行の値は 8 点だった
- token の点数は 1 時間に 5000 点だ。App の token は installation ごとに数える
- PAT は、持ち主が手元で使う点数と 5000 点を分け合う
- 終わりの `count: GraphQL points used` の行は、前後の実行と点数が入れ替わって見えることがある（0 点の実行もあった）。1 回の値ではなく、数回の平均で読む

## 版を固定する

雛形は `npx -y --prefix=/ @pecot/workflow-mcp@6 board sync` を打ち、major の最新に追従します。`@6.0.0` のように書くと、版を固定できます。

## 試す

Actions の画面から `workflow_dispatch` で 1 回起動し、ログの `moved:`・`set:`・warning の行を読みます。ボードへ書かずに見るときは、実行の行へ `--dry-run` を足します。

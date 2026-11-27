# ボードを自動で直すワークフロー

pecot の action `board-sync` と `session-finish` を GitHub Actions で呼ぶ雛形です。置くかどうかは任意です。置かないと、列と札はセッションの手順が動かすときにだけ変わります。

## 前提

- 雛形は、pecot の action を `pecotcraft/pecot/actions/<処理>` で呼ぶ。`workflow_install` が、リリースのタグを commit の SHA に直して置く
- 利用者のリポが GHES にあるときは、次の 2 つも前提になる
  - SHA で固定した版の action（`actions/checkout`・`actions/create-github-app-token`）を使える
  - github.com の pecot の action を使える。GitHub Connect で github.com の action を取れるようにするか、`actions-sync` で写す

## 雛形と置き先

- 置き方: pecot-workflow の MCP ツール `workflow_install` を `name: board-sync` で呼ぶ
- 雛形: `${CLAUDE_PLUGIN_ROOT}/cli/templates/workflow/pecot-board-sync.yml`
- 置き先: 利用者のリポの `.github/workflows/pecot-board-sync.yml`
- 置くのは `workflow_install` が書いたファイルだけとする。書き換えてよいのは次の箇所だけだ
  - `schedule` のコメントを外して、cron の間隔を選ぶ
  - 設定が 2 つ以上あるとき、`board-sync` と `session-finish` の step の `with:` へ `project` を足す
  - 試すとき、`board-sync` の step の `with:` へ `dry-run: 'true'` を足す

## 動く契機

| 契機 | 拾う変化 |
|---|---|
| `pull_request_target`（`opened`・`reopened`・`closed`・`ready_for_review`・`converted_to_draft`） | PR の作成・マージ・クローズ・ドラフトの切り替え |
| `issues`（`closed`・`reopened`） | Issue のクローズと開き直し |
| `workflow_dispatch` | Actions の画面からの手での起動 |

次の変化は契機に無いので、拾えません。`schedule` を有効にするか、Actions の画面から `workflow_dispatch` で起動して直します。

- blocked by の付け外し
- カードの移動
- PR の本文を後から直して、Issue と結び付けたとき（`edited`）

### merge queue のリポ

PR を merge queue がマージしたときも、`pull_request_target` の `closed` の実行が起き、secret が渡ります。

- 確かめた実行では、actor は PR を出して queue へ入れた人と同じだった。PR を出した人と queue へ入れた人が違う場合は、確かめていない
- `Closes #N` で閉じた Issue の `issues` の実行も、別に起きる。同じ group の実行は順に動き、どちらも成功する

## マージで閉じた PR の片付け

PR がマージされると、`finish` の job が、`sync` の job の前に `session-finish` の action を呼びます。PR を出したセッションが片付けずに終わっても、GitHub 側が片付きます。

- PR が閉じる Issue を閉じ、その Issue を待っていた Issue を動かす。手元の片付けはしない
- head ブランチは消さない。リポの Settings の General にある「Automatically delete head branches」を有効にして、GitHub に消させる
- セッションが先に片付けていれば、閉じた Issue は `unchanged` と出て、そのまま成功する
- 列は `finish` では動かない。続く `sync` が、閉じた Issue のカードを直す

`finish` が動くのは、次の 3 つがそろうときだけです。

- `pull_request_target` の `closed` で、PR がマージされた
- head が同じリポのブランチ。fork の PR では、同じ名前の Issue に触れるので動かない
- head ブランチの名前の末尾が `/<番号>`。pecot のタスクのブランチの形だ。2 ブランチのモードのリリースの PR は head が開発ブランチ（例: `develop`）なので、片付けない

token の変数がそろっていないときは、`finish` も飛びます。

### `finish` の権限

`finish` は、実行の `GITHUB_TOKEN` を使います。job の権限は `contents: read`・`issues: write`・`pull-requests: read` で、Issue のクローズに要る分だけです。

- ボードの GitHub App と PAT に、権限を足さなくてよい
- workflow 全体の権限は `contents: read` のまま。`finish` の job だけが広げる
- `finish` は concurrency の group の外で動く。group は待っている実行を 1 つだけ残すので、マージの直後に続く `issues` の実行に、片付けを取り消されないようにするためだ
- `finish` が失敗しても、`sync` は動く

## ボードが複数のリポを持つとき

契機は、雛形を置いたリポの PR と Issue だけを拾います。ほかのリポの変化は、そのリポに雛形が無ければ拾えません。

- 全部のリポに雛形を置く
- 1 つのリポに置き、ほかのリポの変化は `schedule` で補う

設定の JSON は、雛形を置くリポごとに要ります。

## 設定の JSON を既定ブランチに置く

Actions の checkout には `.active` が入りません。`.pecot/config/projects/<設定名>.json` が既定ブランチに入っている必要があります。

1. どれが設定かを調べる。pecot-workflow の MCP ツール `board_show` の Overview にある Project の名前が、ファイル名になる
2. ルートの `.gitignore` が `.pecot/` を丸ごと除外しているときは、その行を外す
3. `.pecot/.gitignore` が設定の JSON を許可しているか確かめる。許可の一覧は `pecot-gitignore-ensure.sh` が作り、`!/config/projects/*.json` の行が JSON を戻す
4. 設定の JSON を既定ブランチへ入れる
5. 設定の JSON が 1 つなら、action はそれを使う。2 つ以上あるときは設定名が要るので、雛形の 2 つの step（`board-sync`・`session-finish`）の `with:` に `project: <設定名>` を足す

## token を用意する

どちらか 1 つを用意します。どちらの variable も無い間は、job が失敗せずに飛びます。`workflow_doctor` を `name: board-sync` で呼ぶと、そろっているかを確かめられます。

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

書き込みが 1 件でも失敗すると、step が失敗で終わります。token の権限が足りないときは、ここで気づけます。

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
| S | スタック先の PR を引き足した数。前提の PR が開発ブランチに届かないときだけ起きる | 1 回 1 点 |

- 例: N が 31・R が 7・W が 4・S が 0 の実行は、式で 15 点になる。終わりの行の値は 8 点だった
- token の点数は 1 時間に 5000 点だ。App の token は installation ごとに数える
- PAT は、持ち主が手元で使う点数と 5000 点を分け合う
- 終わりの `count: GraphQL points used` の行は、前後の実行と点数が入れ替わって見えることがある（0 点の実行もあった）。1 回の値ではなく、数回の平均で読む

## 版を上げる

pecot の action は commit の SHA で固定し、行の末尾のコメントにリリースのタグ（`# pecot-actions/v<版>`）を書いています。

- `.github/dependabot.yml` に `github-actions` の ecosystem があれば、Dependabot が SHA とコメントの版を一緒に上げる PR を出す
- 雛形の新しい版を取り込むときは、`workflow_install` を `force` で呼んで置き直す

## 試す

Actions の画面から `workflow_dispatch` で 1 回起動し、ログの `moved:`・`set:`・warning の行を読みます。ボードへ書かずに見るときは、`board-sync` の step の `with:` へ `dry-run: 'true'` を足します。

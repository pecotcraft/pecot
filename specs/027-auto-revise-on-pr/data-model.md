# Data Model: PR を作ると、GitHub Actions の上で w-revise のレビューが始まる

新しい保存先は作らない。状態は、GitHub の PR・コメント・実行の記録と、導入先のリポのファイルが持つ。

## 自動レビューの実行

1 つの PR に対する 1 回の実行だ。GitHub Actions の run が 1 つ対応する。

| 欄 | 型 | 出どころ | 意味 |
|---|---|---|---|
| `pr` | `owner/repo/N` | イベント | 対象の PR |
| `trigger` | `opened`・`ready_for_review`・`comment` | イベントの名前と `action` | 起動の契機。`comment` は合言葉のコメント |
| `actor` | 文字列 | `github.actor` | 起動した人か bot |
| `head_sha` | 文字列 | `pull_request` はイベント。`comment` は PR の確かめの step が読んだ値 | レビューした時点の PR の先頭 |
| `round` | 整数 | PR の既存のスレッド | 1 巡目は 1。前の巡の `F-NN` のスレッドがあれば、その次の数 |
| `result` | 下の表 | 実行の終わり方 | 結果 |

### 起動の条件

すべて満たすときだけ、エージェントを起こす。判定は job の `if` が持つ。`comment` の契機では、イベントに PR の head と draft が無いので、fork・draft・閉じた PR の判定は、PR を読む step が持つ。`if` は `env` を読めないので、利用者が変える値はリポの変数から読む。

| 条件 | 見るもの |
|---|---|
| リポの中のブランチの PR | PR の head のリポが、導入先のリポと同じ |
| draft でない | PR の `draft` が偽 |
| 契機が `comment` のとき | コメントが PR に付いた。本文が合言葉と同じか、合言葉の直後が空白か改行。書いたのが人で、`author_association` が `OWNER`・`MEMBER`・`COLLABORATOR` のどれか |
| 契機が `opened`・`ready_for_review` のとき | PR を作ったのが人。bot なら、許した bot の一覧に名前がある |

起動した人が書き込み権限を持つかは、claude-code-action も重ねて確かめる。

### 結果

| 値 | 意味 | PR に残るもの |
|---|---|---|
| `reviewed` | レビューを終えた。指摘が 0 件のときも含む | インラインコメントと指摘の一覧。0 件なら指摘の一覧だけ |
| `failed` | 途中で失敗した | 止まったことを知らせるコメント |
| `limit` | ターンか時間の上限で止まった | 止まったことを知らせるコメント |
| `setup-missing` | 要る権限か設定が足りない | 足りない設定を知らせるコメント。PR に書けないときは、実行の記録だけ |

- `reviewed` のときは、指摘の一覧が結果を兼ねる。別のコメントを足さない。実行の記録へは、GitHub が PR に出すチェックの行から行ける
- `failed`・`limit`・`setup-missing` のコメントは CLI が書く。エージェントは書かない

## 指摘

w-reviewer が返す 1 件だ。形は、手で回す w-revise と同じにする。

| 欄 | 意味 |
|---|---|
| 番号 | `F-NN`。2 巡目以降は `R<巡>/F-NN` |
| 視点の印 | `[tech]`・`[cuj]`・`[quality]` |
| 投稿先 | インラインコメント・ファイルコメント・指摘の一覧の General 節。人のいない実行でファイルコメントの手段が無ければ、General 節 |
| スレッド | インラインとファイルの指摘が持つ。自動レビューは resolve しない |

状態の移り方:

| 状態 | 誰が移すか |
|---|---|
| 投稿済み・未解決 | 自動レビュー、または手で回す w-revise の Step 3 |
| 採否が決まった | 手で回す w-revise の Step 4。人が決める |
| 解決済み | 手で回す w-revise の Step 6 |

## 指摘の一覧

`review-findings` のテンプレートで書くコメントだ。形は変えない。
手で回す w-revise は、次の 2 つで、自動レビューの指摘が使えるかを決める。

| 見るもの | 使い道 |
|---|---|
| 未解決で、先頭が `**F-NN**` か `**R<巡>/F-NN**` のスレッド | 採否の確認に使う指摘の集まり |
| スレッドの先頭のコメントが指すコミット | PR の今の先頭と違えば、指摘が古い diff を見たものだと開発者に示す |

## 止まったことを知らせるコメント

結果が `reviewed` でないときに、CLI が PR に 1 つ書く。

| 欄 | 中身 |
|---|---|
| 結果 | `failed`・`limit`・`setup-missing` のどれか |
| 止まった場所 | 指摘を投稿する前か、インラインコメントを投稿した後か |
| 次にすること | 合言葉のコメントでの起動し直しか、端末の w-revise。`setup-missing` は足りない設定の名前 |
| 目印 | 実行の ID を入れた、画面に出ないコメントの行。同じ実行で 2 度書かないために使う |

トークンの値と secret の値は、書かない。

## 合言葉

| 欄 | 既定値 |
|---|---|
| 文字列 | `@pecotbot review`。変数 `PECOT_REVIEW_TRIGGER_PHRASE` で変えられる |
| 一致の仕方 | 本文が合言葉と同じか、合言葉の直後が空白か改行。GitHub Actions の式に正規表現が無いので、`==` と `startsWith` の 3 つの比べ方で判定する。`@pecotbot reviewer` では起動しない |
| 起動できる人 | `author_association` が `OWNER`・`MEMBER`・`COLLABORATOR` の人。job の `if` が見て、claude-code-action も書き込み権限を確かめる |

- `pecotbot` は、pecot が Organization として持つ名前だ。他人のアカウントの名前（`@pecot` など）は使わない。書くたびにその人へ通知が飛ぶためだ
- `prompt` を渡す形では、action は合言葉を確かめない。判定は job の `if` だけが持つ

## ワークフローの雛形

導入先のリポの `.github/workflows/pecot-review.yml` に置くファイルだ。

| 欄 | 中身 |
|---|---|
| 版の目印 | 1 行目のコメント。整数 |
| 利用者が変える値 | 合言葉・許す bot の一覧・ターンの上限・時間の上限。リポの変数に置く。変数が無ければ、雛形の既定値で動く |
| 利用者が足す行 | 開始と終了の印のコメントで囲む |

## エージェント用の認証

自動レビューと、後に続く自動処理が、同じ名前で読む。

| 名前 | 種類 | 中身 |
|---|---|---|
| `PECOT_AGENT_APP_CLIENT_ID` | 変数 | 任意。権限を絞りたい利用者が作る GitHub App の Client ID。無ければ、Claude の App を使う |
| `PECOT_AGENT_APP_PRIVATE_KEY` | secret | 任意。その App の秘密鍵 |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | モデルの利用の認証。既定。サブスクリプションのトークン |
| `PECOT_AGENT_ANTHROPIC_FEDERATION_RULE_ID`・`_ORGANIZATION_ID`・`_SERVICE_ACCOUNT_ID`・`_WORKSPACE_ID` | 変数 | Workload Identity Federation。secret のトークンが無いときに使う |

GitHub のトークンは、既定では Claude の App のものだ。利用者は何も登録しない。自前の App を置いたときは、App にインストールで与える権限を使う自動処理の合計にし、ワークフローが発行のときに自分に要る権限だけに絞る。

| 自動処理 | 発行するトークンの権限 |
|---|---|
| 自動レビュー | Pull requests: write、Contents: read |
| 後に続く自動処理（spec 023） | その spec が決める |

## 雛形の一覧

`pecot workflow install` と `pecot workflow doctor` が読む表だ。雛形を足すときは、行を足す。

| 欄 | 意味 |
|---|---|
| 名前 | `review`。コマンドの引数 |
| 雛形のファイル | `cli/templates/workflow/pecot-review.yml` |
| 置き先 | `.github/workflows/pecot-review.yml` |
| 要る変数と secret | 上の「エージェント用の認証」の表のもの |

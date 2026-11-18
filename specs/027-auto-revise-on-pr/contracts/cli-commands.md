# Contract: 足すコマンド

設計の時点の契約だ。実装の後は、`plugins/pecot-workflow/interface/` の定義書を正とする。
出力は、既存の共通の関数を通した英語の行にする。データは stdout に、予定・結果・警告・エラーは stderr に出す。
3 つとも、既存のコマンドと同じ仕組みで、MCP ツールとしても出す。名前は `workflow_install`・`workflow_doctor`・`review_finish` だ。

## 共通

| 項目 | 決め |
|---|---|
| 認証 | `PECOT_GITHUB_COM_TOKEN` を読む。既存のコマンドと同じ |
| 終了コード | 既存のコマンドの決まりに従う。成功・実行時の失敗・入力か前提の誤りを分ける |
| 対話 | 無い。どのコマンドも入力を待たない |
| プロジェクトの設定 | 要らない。3 つとも、ボードを読まない |

## `pecot workflow install <名前>`

ワークフローの雛形を、導入先のリポに書き出す。

| 引数 | 型 | 既定値 | 意味 |
|---|---|---|---|
| `名前` | 文字列 | 無い | 雛形の一覧の名前。初版は `review` だけ |
| `--check` | 真偽値 | 偽 | 書き出さずに、置かれた雛形の版を確かめる |
| `--force` | 真偽値 | 偽 | 既にあるファイルを上書きする |
| `-D` | パス | 現在地 | リポのルート |

| 条件 | 振る舞い |
|---|---|
| ファイルが無い | 置き先に雛形を書く。次に利用者がすること（Claude の App を入れる、モデルの認証の secret を登録する）を出す |
| ファイルが既にあり、`--force` が無い | 何も書かず、入力の誤りとして止まる |
| `--force` で、利用者が足した行がある | 上書きの前に、消える行を出す |
| `--check` で、版が同じ | 成功 |
| `--check` で、版が古いか、ファイルが無い | 失敗。更新のコマンドを出す |
| 一覧に無い名前 | 入力の誤りとして止まり、一覧の名前を出す |

- ファイルを書くので、冪等ではない。`--check` は何も書かない

## `pecot workflow doctor <名前>`

導入に要る設定がそろっているかを確かめる。何も書かない。

| 引数 | 型 | 既定値 | 意味 |
|---|---|---|---|
| `名前` | 文字列 | 無い | 雛形の一覧の名前 |
| `-D` | パス | 現在地 | リポのルート |

`review` で確かめる項目:

| 項目 | 足りないときの行 |
|---|---|
| 雛形がある | `missing: .github/workflows/pecot-review.yml` |
| 雛形の版が新しい | `outdated: workflow template review` |
| 変数 `PECOT_AGENT_APP_CLIENT_ID` があるときに、secret `PECOT_AGENT_APP_PRIVATE_KEY` もある | `missing: secret PECOT_AGENT_APP_PRIVATE_KEY` |
| secret `CLAUDE_CODE_OAUTH_TOKEN` か、Workload Identity Federation の 4 つの変数がある | `missing: secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*` |

- 全部そろっていれば成功、1 つでも足りなければ失敗
- Claude の App が入っているかは、リポのトークンでは読めない。確かめず、`skipped: Claude GitHub App` の行で出す。入っていないときは、action が GitHub のトークンを受け取れずに止まり、後始末のコメントで知らせる
- トークンの寿命は、名前の有無からは読めない。切れたことは、`review finish` のコメントで知らせる
- secret と変数は、名前の有無だけを読む。値は読まない。リポの単位と organization の単位の両方を見る
- 手元のトークンに権限が無く読めない項目は、`skipped:` の行で出し、足りないとは数えない
- App にインストールで与えた権限は、手元のトークンでは読めない。確かめる方法を、導入の説明に書く

## `pecot review finish <PR>`

自動レビューの終わりの処理だ。止まったときに、PR にコメントを書く。
コマンドの語は英小文字と数字だけに決まっている（定義書の形式）ので、グループ `review` と動詞 `finish` の 2 語にする。

| 引数 | 型 | 意味 |
|---|---|---|
| `PR` | 文字列 | `owner/repo/N` |
| `--result` | 文字列 | `reviewed`・`failed`・`limit`・`setup-missing` のどれか。後始末の step は渡さず、`--ensure` で結果を決める。w-review は呼ばない |
| `--detail` | 文字列 | `--result setup-missing` のときの、足りない設定の名前 |
| `--ensure` | 真偽値 | ワークフローの後始末から呼ぶ形。同じ実行の結果がまだ無いときだけ書く |
| `--job-status` | 文字列 | `--ensure` のときの、job の終わり方（`success`・`failure`・`cancelled`） |
| `--review-outcome` | 文字列 | `--ensure` のときの、自動レビューの step の `outcome`（`success`・`failure`・`cancelled`・`skipped`） |
| `--review-conclusion` | 文字列 | `--ensure` のときの、action の出力 `conclusion`。空の文字列を受け付ける。Claude Code を動かさなかった run では空になる |
| `--review-has-token` | 文字列 | `--ensure` のときの、action の出力 `github_token` があるか（`true`・`false`）。トークンの値は受け取らない |
| `--execution-file` | パス | `--ensure` のときの、action の出力 `execution_file`。省けて、空でもよい |
| `--since` | ISO 8601 | `--ensure` のときの、実行の開始時刻。止まった場所を決めるのに使う。省けて、空でもよい |
| `--dry-run` | 真偽値 | PR を読み、書くはずの本文を標準出力に出す。コメントは書かない。書き込むコマンドの決まり |

- `--result` と `--ensure` は、どちらか 1 つを渡す。両方・どちらも無しは、入力の誤りで止める
- `--ensure` のときは、`--job-status`・`--review-outcome`・`--review-conclusion`・`--review-has-token` の 4 つが要る。1 つでも無ければ、入力の誤りとして止まる。`--review-conclusion` は、空の文字列を渡せば足りる
- `--ensure` の補助の引数を、`--ensure` なしで渡すと、入力の誤りで止まる

`--ensure` の判定は、action の公開の出力と step の `outcome` を元に決める。action の中の step の出力と、run の記録の文は読まない。後始末は同じ job の中で動くので、run の記録は読めない（research の R9）。
`execution_file` は、runner の上のファイルなので読める。無いか読めなければ、その行を飛ばす。

`--result` で呼んだとき:

| 条件 | 振る舞い |
|---|---|
| 結果が `reviewed` | コメントを書かない。実行の記録に、`skipped` の行を 1 行出す |
| PR が閉じている | コメントを書かない |
| 結果が `failed`・`limit`・`setup-missing` | 止まったことを知らせるコメントを書く |

`--ensure` で呼んだとき。上から順に見て、最初に当たった行で決める。

| 条件 | 振る舞い |
|---|---|
| 自動レビューの `outcome` が `success` で、`conclusion` が空 | コメントを書かない。PR のブランチで雛形を変えたので、Claude の App がトークンを出さず、action がレビューを飛ばした。`skipped` の行に、合言葉で起こし直してもこの PR では動かないことを添える |
| job が成功 | 何もしない |
| job が `cancelled` | `limit` として書く。`cancelled` は、時間の上限と手での取り消しを見分けない（research の R9） |
| `execution_file` の最後の `result` が `is_error: true`・`terminal_reason: api_error` | `failed` として書く。`result` の文か `errors` に `authentication_error` があれば、トークンを作り直す手順を添える。`subtype` だけで判定しない |
| `execution_file` の最後の `result` が `subtype: error_max_turns` | `limit` として書く |
| 自動レビューの `outcome` が `failure` で、`github_token` が無い | `setup-missing` として書き、Claude の App を入れる手順を添える。action が Claude の App のトークンを受け取れずに止めた |
| それ以外 | `failed` として書く |

書くと決めた後に、次を順に見る。どれかに当たれば書かない。

| 条件 | 振る舞い |
|---|---|
| PR が閉じている | コメントを書かない |
| 自動レビューの `outcome` が `failure` で `conclusion` が空（Claude Code が動いていない）で、`GITHUB_ACTOR` の権限が `admin` でも `write` でもない | コメントを書かない。action が書いた人の権限で止めた場合だ。誰でも bot のコメントを付けさせられるのを避ける |
| 同じ実行・同じ試行のコメントがある | 何も書かない |

- PR の確かめの step が fork・draft・閉じた PR を弾いた run は、自動レビューの `outcome` が `skipped` で、job が成功する。「job が成功」の行が受ける
- 自動レビューより前の step が失敗した run も、自動レビューの `outcome` は `skipped` になる。step の `if` に `always()` が無いためだ。job は失敗なので、`failed` として書く
- 書いた人の権限は、job の `if` が見る `author_association` では決まらない。`MEMBER`・`COLLABORATOR` は write の権限を意味しないので、read だけの人のコメントも `if` を通る。このため、Claude Code が動かずに落ちた run では、CLI が `GITHUB_ACTOR` の権限を読む
  - 名前が `[bot]` で終わる起動者は、権限を読まずに書く。action も、名前が `[bot]` で終わる起動者を書ける側とみなす
  - 権限を読めないときは、`warning` の行を出して書く。止まったことが PR に残らないほうが困る

- 止まったことを知らせるコメントは、`cli/templates/comment/review-stopped.md` から作る。中身は [data-model.md](../data-model.md) の「止まったことを知らせるコメント」のとおりだ
- 止まった場所は、`--since` より後に作られ、先頭が `**F-NN**` のインラインコメントの有無から決める。`--since` が無いか空なら「分からない」と書く
- 目印には、環境変数 `GITHUB_RUN_ID` と `GITHUB_RUN_ATTEMPT` を入れる。re-run では run の ID が変わらないためだ。`GITHUB_RUN_ID` が無ければ、目印を付けずに書く
- 目印を探すのは、bot のコメントだけだ。人が目印を書き込んで、記録を消せないようにする
- 合言葉は、環境変数 `PECOT_REVIEW_TRIGGER_PHRASE` から読む。無ければ `@pecotbot review` だ
- action の中の出力 `skipped_due_to_workflow_validation_mismatch` は、action の `outputs` に無く、呼ぶ側から読めない
- トークンの値と secret の値を、コメントと出力に書かない

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
| `--result` | 文字列 | `reviewed`・`failed`・`limit`・`setup-missing` のどれか。スキルが MCP ツールから渡す |
| `--detail` | 文字列 | `--result setup-missing` のときの、足りない設定の名前 |
| `--ensure` | 真偽値 | ワークフローの後始末から呼ぶ形。同じ実行の結果がまだ無いときだけ書く |
| `--job-status` | 文字列 | `--ensure` のときに必須。`success`・`failure`・`cancelled` のどれか |
| `--execution-file` | パス | `--ensure` のときの、action の出力 `execution_file` |
| `--since` | ISO 8601 | `--ensure` のときの、実行の開始時刻。止まった場所を決めるのに使う |
| `--app-token-missing` | 真偽値 | `--ensure` のときに、action が Claude の App のトークンを受け取れなかったか |
| `--dry-run` | 真偽値 | PR を読み、書くはずの本文を標準出力に出す。コメントは書かない。書き込むコマンドの決まり |

- `--result` と `--ensure` は、どちらか 1 つを渡す。両方・どちらも無しは、入力の誤りで止める
- `--execution-file`・`--since`・`--app-token-missing` は `--ensure` と組む

| 条件 | 振る舞い |
|---|---|
| 結果が `reviewed` | コメントを書かない。実行の記録に、`skipped` の行を 1 行出す |
| 結果が `failed`・`limit`・`setup-missing` | 止まったことを知らせるコメントを書く |
| `--ensure` で、job が成功 | 何もしない |
| `--ensure` で、job が失敗し、同じ実行・同じ試行のコメントがある | 何も書かない |
| `--ensure` で、job が `cancelled` | `limit` として書く。時間の上限と手での取り消しを見分けない（research の R9） |
| `--ensure` で、job が `failure` で `--app-token-missing` | `setup-missing` として書き、Claude の App を入れる手順を添える |
| `--ensure` で、`execution_file` の最後の `result` が `subtype: error_max_turns` | `limit` として書く |
| `--ensure` で、`execution_file` の最後の `result` が `is_error: true`・`terminal_reason: api_error` | `failed` として書く。`result` の文か `errors` に `authentication_error` があれば、トークンを作り直す手順を添える。`subtype` だけで判定しない |
| `--ensure` で、job が `failure` で、上のどれにも当たらない（`execution_file` が無い・読めない、`result` の行が無い、ほかの `subtype`） | `failed` として書く |
| `--ensure` で、job が `failure` で `execution_file` が無く、`GITHUB_ACTOR` の権限が `admin` でも `write` でもない | コメントを書かない。action が書いた人の権限で止めた場合だ。誰でも bot のコメントを付けさせられるのを避ける |
| `--ensure` で、job が `failure` で `execution_file` が無く、`GITHUB_ACTOR` の名前が `[bot]` で終わる | 権限を読まずに書く。action も、名前が `[bot]` で終わる起動者を書ける側とみなす |
| `--ensure` で、job が `failure` で `execution_file` が無く、`GITHUB_ACTOR` の権限を読めない | `warning` の行を出して書く。止まったことが PR に残らないほうが困る |
| PR が閉じている | コメントを書かない |

- 止まったことを知らせるコメントは、`cli/templates/comment/review-stopped.md` から作る。中身は [data-model.md](../data-model.md) の「止まったことを知らせるコメント」のとおりだ
- 止まった場所は、`--since` より後に作られ、先頭が `**F-NN**` か `**R<巡>/F-NN**` のインラインコメントの有無から決める。`--since` が無いか空なら「分からない」と書く
- 目印には、環境変数 `GITHUB_RUN_ID` と `GITHUB_RUN_ATTEMPT` を入れる。re-run では run の ID が変わらないためだ。`GITHUB_RUN_ID` が無ければ、目印を付けずに書く
- 目印を探すのは、bot のコメントだけだ。人が目印を書き込んで、記録を消せないようにする
- 書いた人の権限は、job の `if` が見る `author_association` では決まらない。`MEMBER`・`COLLABORATOR` は write の権限を意味しないので、read だけの人のコメントも `if` を通る
- 合言葉は、環境変数 `PECOT_REVIEW_TRIGGER_PHRASE` から読む。無ければ `@pecotbot review` だ
- action の出力 `skipped_due_to_workflow_validation_mismatch` は、action の外から読めない。この値が `true` のとき、action は step を成功で終えるので、job も成功で、何もしない
- トークンの値と secret の値を、コメントと出力に書かない

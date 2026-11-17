# Contract: 足すコマンド

設計の時点の契約だ。実装の後は、`plugins/pecot-workflow/interface/` の定義書を正とする。
出力は、既存の共通の関数を通した英語の行にする。データは stdout に、予定・結果・警告・エラーは stderr に出す。
3 つとも、既存のコマンドと同じ仕組みで、MCP ツールとしても出す。名前は `workflow_install`・`workflow_doctor`・`pr_review_finish` だ。

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
| ファイルが無い | 置き先に雛形を書く。次に利用者がすること（App の作成、変数と secret の登録）を出す |
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
| 変数 `PECOT_AGENT_APP_CLIENT_ID` がある | `missing: variable PECOT_AGENT_APP_CLIENT_ID` |
| secret `PECOT_AGENT_APP_PRIVATE_KEY` がある | `missing: secret PECOT_AGENT_APP_PRIVATE_KEY` |
| secret `CLAUDE_CODE_OAUTH_TOKEN` か、Workload Identity Federation の 4 つの変数がある | `missing: secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*` |

- 全部そろっていれば成功、1 つでも足りなければ失敗
- トークンの寿命は、名前の有無からは読めない。切れたことは、`review-finish` のコメントで知らせる
- secret と変数は、名前の有無だけを読む。値は読まない。リポの単位と organization の単位の両方を見る
- 手元のトークンに権限が無く読めない項目は、`skipped:` の行で出し、足りないとは数えない
- App にインストールで与えた権限は、手元のトークンでは読めない。確かめる方法を、導入の説明に書く

## `pecot pr review-finish <PR>`

自動レビューの終わりの処理だ。止まったときに、PR にコメントを書く。

| 引数 | 型 | 意味 |
|---|---|---|
| `PR` | 文字列 | `owner/repo/N` |
| `--result` | 文字列 | `reviewed`・`failed`・`limit`・`setup-missing` のどれか |
| `--detail` | 文字列 | `setup-missing` のときの、足りない設定の名前 |
| `--ensure` | 真偽値 | ワークフローの後始末から呼ぶ形。同じ実行の結果がまだ無いときだけ書く |
| `--job-status` | 文字列 | `--ensure` のときに、job の終わり方から結果を決める |

| 条件 | 振る舞い |
|---|---|
| 結果が `reviewed` | コメントを書かない。実行の記録に、終えたことを 1 行出す |
| 結果が `failed`・`limit`・`setup-missing` | 止まったことを知らせるコメントを書く |
| `--ensure` で、job が成功 | 何もしない |
| `--ensure` で、job が失敗し、同じ実行のコメントがある | 何も書かない |
| `--ensure` で、job が失敗し、同じ実行のコメントが無い | job が `cancelled` なら `limit`、それ以外は `failed` として書く。`cancelled` は、時間の上限と手での取り消しを見分けない（research の R9） |
| `--ensure` で、`execution_file` の最後の `result` が `is_error: true`・`terminal_reason: api_error` | `failed` として書き、認証の失敗なら、トークンを作り直す手順を添える。`subtype` だけで判定しない |
| `--ensure` で、`execution_file` の最後の `result` が `subtype: error_max_turns` | `limit` として書く |
| PR が閉じている | コメントを書かない |

- 止まったことを知らせるコメントは、`cli/templates/comment/` のテンプレートから作る。中身は [data-model.md](../data-model.md) の「止まったことを知らせるコメント」のとおりだ
- 止まった場所は、同じ実行が投稿したインラインコメントの有無から決める
- 実行の ID は、環境変数 `GITHUB_RUN_ID` から読む。無ければ、目印を付けずに書く
- トークンの値と secret の値を、コメントと出力に書かない

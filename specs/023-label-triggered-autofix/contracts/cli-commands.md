# Contract: `pecot auto` のコマンド

設計の時点の契約だ。実装の後は、`plugins/pecot-workflow/interface/` の定義書を正とする。
出力は、既存の共通の関数を通した英語の行にする。データは stdout に、予定・結果・警告・エラーは stderr に出す。

## 共通

| 項目 | 決め |
|---|---|
| 認証 | `PECOT_GITHUB_COM_TOKEN` を読む。既存のコマンドと同じ |
| 前提 | 有効なプロジェクトの設定がある。`gate`・`start`・`finish` は、設定に `fields.status` が要る |
| 終了コード | 0 は成功、1 は実行時の失敗、2 は入力か前提の誤り。既存のコマンドと同じ |
| 対話 | 無い。どのコマンドも入力を待たない |

## `pecot auto install`

ワークフローの雛形を書き出し、起動ラベルを作る。

| 引数 | 型 | 既定値 | 意味 |
|---|---|---|---|
| `--ci-workflow` | 文字列 | 無い | CI のワークフローの `name`。省くと、候補を出して終了コード 2 で止まる |
| `--label` | 文字列 | `pecot-auto` | 起動ラベルの名前 |
| `--check` | 真偽値 | 偽 | 書き出さずに、置かれた雛形の版を確かめる |
| `--force` | 真偽値 | 偽 | 既にあるファイルを上書きする |
| `-D` | パス | 現在地 | リポのルート |

| 条件 | 振る舞い |
|---|---|
| ファイルが無い | `.github/workflows/pecot-auto.yml` を書き、起動ラベルを作る。次に利用者がすること（App の作成、変数と secret の登録）を出す |
| ファイルが既にあり、`--force` が無い | 何も書かず、終了コード 2 で止まる |
| `--check` で、版が同じ | 終了コード 0 |
| `--check` で、版が古い | 終了コード 1。更新のコマンドを出す |
| `--check` で、ファイルが無い | 終了コード 1 |
| 起動ラベルが既にある | 作らずに進む |

起動ラベルは、名前・説明・色をつけて作る。説明は、付けると何が起きるかを 1 文で書く。画面の一覧に、名前と並んで出るためだ。

- `--force` は、利用者が足した step と許可を消す。上書きの前に、消える行を出す
- 冪等ではない。ファイルを書く

## `pecot auto doctor`

導入に要る設定がそろっているかを確かめる。何も書かない。

確かめる項目:

| 項目 | 足りないときの行 |
|---|---|
| 雛形がある | `missing: .github/workflows/pecot-auto.yml` |
| 雛形の版が新しい | `outdated: workflow template` |
| 起動ラベルがある | `missing: label <名前>` |
| 変数 `PECOT_AUTO_APP_CLIENT_ID` がある | `missing: variable PECOT_AUTO_APP_CLIENT_ID` |
| secret `PECOT_AUTO_APP_PRIVATE_KEY` がある | `missing: secret PECOT_AUTO_APP_PRIVATE_KEY` |
| secret `ANTHROPIC_API_KEY` がある | `missing: secret ANTHROPIC_API_KEY` |
| 設定に `fields.status` がある | `missing: project config fields.status` |
| 既定の Status に待ちの値がある | `missing: Status option Waiting` |
| 既定の自動化が有効 | `disabled: project workflow <名前>` |
| 雛形の CI のワークフローの名前が実在する | `missing: workflow named <名前>` |

- 全部そろっていれば終了コード 0、1 つでも足りなければ 1
- secret と変数は、名前の有無だけを読む。値は読まない。リポの単位と organization の単位の両方を見る
- 手元のトークンに権限が無く読めない項目は、`skipped:` の行で出し、足りないとは数えない

## `pecot auto gate`

ワークフローの先の job が呼ぶ。イベントを読み、進めるかと種類を出す。

| 引数 | 型 | 意味 |
|---|---|---|
| `--event-name` | 文字列 | `issues` か `workflow_run` |
| `--event-path` | パス | イベントの JSON。`GITHUB_EVENT_PATH` |
| `--max-ci-attempts` | 整数 | CI を直す回数の上限 |
| `--workflow-file` | パス | 置かれた雛形。版の目印を読む |

- stdout に、[data-model.md](../data-model.md) の「自動処理の実行」の欄を JSON で出す
- `GITHUB_OUTPUT` があれば、同じ値を `key=value` で足す
- `proceed` が偽で、Issue に知らせる理由があるときは、`gate` が `finish` と同じ処理で結果のコメントを書く
- 人が作った PR の CI では、何も書かずに `proceed=false` を出す
- 判定の誤りではないので、`proceed` が偽でも終了コードは 0 だ

## `pecot auto start`

スキルが最初に呼ぶ。待ちの値を戻し、続きに要る文脈を出す。

| 引数 | 型 | 意味 |
|---|---|---|
| `issue` | 文字列 | `owner/repo/N` |

stdout に出すもの:

| 欄 | 中身 |
|---|---|
| `issue` | タイトルと本文 |
| `plan` | 前回の計画のコメント。無ければ空 |
| `results` | 前回までの結果のコメント。質問を含む |
| `answers` | 最後の結果のコメントの後に付いたコメント。書き込み権限のある人のものに限る |
| `branch` | 既にあるブランチ |
| `pr` | 既にある PR |

- Issue がボードに無ければ、進行の欄を Ready にしてボードに載せる。既存の `pecot add-to-project` と同じ処理を使う
- 既定の Status が Waiting なら、PR の有無で Todo か In Progress に戻す
- 書き込み権限の無い人のコメントは、数だけを出し、本文を出さない
- Issue がボードにあり、既定の Status が Waiting でなければ、何も書かない。この場合は冪等だ

## `pecot auto finish`

結果のコメントを書き、待ちの値を書き、起動ラベルを外す。

| 引数 | 型 | 意味 |
|---|---|---|
| `issue` | 文字列 | `owner/repo/N` |
| `--result` | 文字列 | [data-model.md](../data-model.md) の「結果」の値 |
| `--body-file` | パス | 結果ごとの本文。質問、落ちたテストなど |
| `--label` | 文字列 | 外す起動ラベルの名前 |
| `--ensure` | 真偽値 | 同じ run の結果のコメントが無いときだけ書く |
| `--job-status` | 文字列 | `--ensure` のときに、job の終わり方から結果を決める |

| 条件 | 振る舞い |
|---|---|
| 結果が `question`・`failed`・`limit` | 結果のコメントを書き、既定の Status を Waiting にし、起動ラベルを外す |
| 結果が `pr-created`・`out-of-scope`・`setup-missing` | 結果のコメントを書き、起動ラベルを外す。既定の Status は書かない |
| 結果が `ci-passed`・`ci-fix-pushed` | 結果のコメントを書く |
| `--ensure` で、同じ run の結果のコメントがある | 何も書かない。起動ラベルが残っていれば外す |
| `--ensure` で、無い | job が時間切れか取り消しなら `limit`、それ以外の失敗なら `failed` として書く |
| 既定の Status に待ちの値が無い | 結果のコメントに足りない設定を足す。進行の欄は変えない。終了コードは 0 |
| 本文がテンプレートの検証を通らない | 終了コード 3 で止まり、指摘を出す。既存の `issue comment` と同じ |

- 起動ラベルが既に外れていても、失敗にしない
- トークンの値と secret の名前の値を、コメントに書かない

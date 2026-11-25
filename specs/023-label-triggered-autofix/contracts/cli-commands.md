# Contract: `pecot auto` のコマンドと導入

設計の時点の契約だ。実装の後は、`plugins/pecot-workflow/interface/` の定義書を正とする。
出力は、既存の共通の関数を通した英語の行にする。データは stdout に、予定・結果・警告・エラーは stderr に出す。
コマンドの語は英小文字と数字だけに決まっている（定義書の形式）ので、グループ `auto` と動詞 `gate`・`start`・`finish` の 2 語にする。
3 つとも、既存のコマンドと同じ仕組みで、MCP ツールとしても出す。名前は `auto_gate`・`auto_start`・`auto_finish` だ。

導入と確かめは、`auto` 専用のコマンドを作らない。spec 027 の `pecot workflow install <名前>`・`pecot workflow doctor <名前>` に、雛形の一覧の行を足して行う。

## 共通

| 項目 | 決め |
|---|---|
| 認証 | `PECOT_GITHUB_COM_TOKEN` を読む。既存のコマンドと同じ |
| プロジェクトの設定 | 要る。ツールが、対象のリポから設定を決める（#579）。複数のボードに入ったリポの指定は、#640 の決めに従う。`gate`・`start`・`finish` は、設定に `fields.status` が要る |
| 終了コード | 既存のコマンドの決まりに従う。成功・実行時の失敗・入力か前提の誤り・テンプレートの検証の失敗を分ける |
| 対話 | 無い。どのコマンドも入力を待たない |
| `--dry-run` | 3 つとも持つ。書くはずのコメント・ラベル・値を標準出力に出し、何も書かない。書き込むコマンドの決まり |

## 導入（`pecot workflow install auto`・`pecot workflow doctor auto`）

`cli/src/domain/workflow-template.ts` の `WORKFLOW_TEMPLATES` に、`auto` の行を足す。引数と終了の決めは、spec 027 の [contracts/cli-commands.md](../../027-auto-revise-on-pr/contracts/cli-commands.md) のとおりだ。

| 欄 | 値 |
|---|---|
| 名前 | `auto` |
| 雛形のファイル | `cli/templates/workflow/pecot-auto.yml` |
| 置き先 | `.github/workflows/pecot-auto.yml` |
| 要る設定 | 変数 `PECOT_AGENT_APP_CLIENT_ID` と secret `PECOT_AGENT_APP_PRIVATE_KEY` の両方。モデルの認証は、secret `CLAUDE_CODE_OAUTH_TOKEN` か `PECOT_AGENT_ANTHROPIC_*` の 4 変数 |
| 導入の後の案内 | 次の順に出す（FR-031）。Claude の App を入れる案内は出さない |
| Claude の App の項目 | 出さない |
| 確かめる項目 | 下の表 |

`review` の行は、自前の App を任意の設定として持つ（変数があるときだけ secret が要る）。`auto` の行は、App の変数と secret の両方を必須の設定に持つ。

導入の順は、次の 6 つだ。

1. 雛形を置く（`workflow install auto`）
2. GitHub App を作り、インストールする
3. 変数と secret を登録する
4. 起動ラベルを作る
5. 雛形の囲みに書く（CI の名前・準備の step・テストのコマンドの許可）
6. `workflow doctor auto` で確かめる

`workflow install auto` が書き出した後の案内は、一覧の行の「導入の後の案内」から出す。
`workflow doctor auto` が Claude の App の項目を出すかは、一覧の行の「Claude の App の項目」で決まる。
今の実装は、どちらも自動レビューだけに合う形で固定している（`cli/src/commands/workflow.ts` の `nextSteps` と `CLAUDE_APP_ITEM`）。行に持たせる形に直す。

`workflow doctor auto` が確かめる項目:

| 項目 | 足りないときの行 |
|---|---|
| 雛形がある | `missing: .github/workflows/pecot-auto.yml` |
| 雛形の版が新しい | `outdated: workflow template auto` |
| 変数 `PECOT_AGENT_APP_CLIENT_ID` がある | `missing: variable PECOT_AGENT_APP_CLIENT_ID` |
| secret `PECOT_AGENT_APP_PRIVATE_KEY` がある | `missing: secret PECOT_AGENT_APP_PRIVATE_KEY` |
| secret `CLAUDE_CODE_OAUTH_TOKEN` か、Workload Identity Federation の 4 つの変数がある | `missing: secret CLAUDE_CODE_OAUTH_TOKEN or variables PECOT_AGENT_ANTHROPIC_*` |
| 起動ラベルがある | `missing: label <名前>` |
| 設定に `fields.status` がある | `missing: project config fields.status` |
| 既定の Status に待ちの値がある | `missing: Status option Needs Attention` |
| 既定の自動化が有効 | `disabled: project workflow <名前>` |
| 雛形の CI のワークフローの名前が実在する | `missing: workflow named <名前>` |

- 3〜5 行目が、雛形の一覧の行が持つ「要る変数と secret」だ。6 行目からは、`auto` の行が足す確かめの種類で、ボードとラベルとワークフローの一覧を読む。確かめの種類は、一覧の行に持たせる（plan の Complexity Tracking）
- 全部そろっていれば成功、1 つでも足りなければ失敗
- secret と変数は、名前の有無だけを読む。値は読まない。リポの単位と organization の単位の両方を見る
- 手元のトークンに権限が無く読めない項目は、`skipped:` の行で出し、足りないとは数えない
- App にインストールで与えた権限は、手元のトークンでは読めない。確かめず、`skipped: GitHub App permissions` の行で出す（FR-032 の「権限」）。確かめ方は、導入の説明 `auto-workflow.md` に書く。spec 027 の `workflow doctor review` と同じ扱いだ
- CI のワークフローの名前は、利用者が `pecot-auto.yml` の印の囲みに書く。囲みの初めの値は仮の名前だ。実在するかは、置かれた雛形の名前と `.github/workflows/` の `name` を比べて確かめる
- 起動ラベルは、`workflow install` が作らない。w-onboarding の導入の Step が、名前・説明・色をつけて作る。説明は、付けると何が起きるかを 1 文で書く。画面の一覧に、名前と並んで出るためだ
- `--force` は、囲みの中に利用者が足した行（CI の名前・準備の step・許可の変数）を消す。上書きの前に、消える行を出す

## `pecot auto gate`

ワークフローの先の job が呼ぶ。イベントを読み、進めるかと種類を出す。

| 引数 | 型 | 意味 |
|---|---|---|
| `--event-name` | 文字列 | `issues` か `workflow_run` |
| `--event-path` | パス | イベントの JSON。`GITHUB_EVENT_PATH` |
| `--max-ci-attempts` | 整数 | CI を直す回数の上限 |
| `--dry-run` | 真偽値 | 結果のコメントを書かず、書くはずの本文を JSON の欄 `comment` に入れる |

- stdout に、[data-model.md](../data-model.md) の「自動処理の実行」の欄を JSON で出す
- `--dry-run` のときも、stdout は JSON 1 つだけにする。書くはずの本文は、その JSON の欄 `comment` に入る
- `GITHUB_OUTPUT` があれば、同じ値を `key=value` で足す
- `issues` のとき、ラベルを付けた人（`sender`）の権限を、`collaborators/<login>/permission` の `permission` で読む。`maintain` は `write` で返る
- `permission` が `admin`・`write` でなければ、何も書かずに `proceed=false` を出す。`sender` が `[bot]` のとき、権限を読めないとき（404・API の失敗）も同じだ
- `proceed` が偽で、Issue に知らせる理由があるときは、`gate` が `finish` と同じ処理で結果のコメントを書く
- 人が作った PR の CI では、何も書かずに `proceed=false` を出す
- 判定の誤りではないので、`proceed` が偽でも終了コードは成功だ
- 雛形の版は比べない。版を比べるのは、`workflow install auto --check` と `workflow doctor auto` だけだ

## `pecot auto start`

スキルが最初に呼ぶ。待ちの値を戻し、続きに要る文脈を出す。

| 引数 | 型 | 意味 |
|---|---|---|
| `issue` | 文字列 | `owner/repo/N` |
| `--dry-run` | 真偽値 | ボードへの書き込みをせず、書くはずの値を出す |

stdout に出すもの:

| 欄 | 中身 |
|---|---|
| `issue` | タイトルと本文 |
| `plan` | 前回の計画のコメント。本文が見出し `## Plan` で始まるもの。読むのは、bot のコメントと、`answers` と同じ条件の人のコメントだけ。複数あれば最後の 1 つ。無ければ空 |
| `results` | 前回までの結果のコメント。質問を含む |
| `answers` | 最後の結果のコメントの後に付いたコメント。書いた人の `permission` が `admin`・`write` のものに限る。`author_association` では絞らない |
| `branch` | 既にあるブランチ |
| `pr` | 既にある PR |

- Issue がボードに無ければ、進行の欄を Ready にしてボードに載せる。既存の `pecot board add` と同じ処理を使う
- 既定の Status が、自動処理が書いた Needs Attention なら、PR の有無で Todo か In Progress に戻す。決め方は [data-model.md](../data-model.md) の「自動処理が書いた札か」だ。pecot の判定が置いた Needs Attention は戻さない
- 書き込み権限の無い人のコメントは、数だけを出し、本文を出さない
- Issue がボードにあり、既定の Status が自動処理の書いた Needs Attention でなければ、何も書かない。この場合は冪等だ

## `pecot auto finish`

結果のコメントを書き、待ちの値を書き、起動ラベルを外す。

| 引数 | 型 | 意味 |
|---|---|---|
| `issue` | 文字列 | `owner/repo/N` |
| `--result` | 文字列 | [data-model.md](../data-model.md) の「結果」の値 |
| `--body-file` | パス | 結果ごとの本文。質問、落ちたテストなど |
| `--ensure` | 真偽値 | 同じ run の結果のコメントが無いときだけ書く |
| `--job-status` | 文字列 | `--ensure` のときの、job の終わり方（`success`・`failure`・`cancelled`） |
| `--run-outcome` | 文字列 | `--ensure` のときの、自動処理の step の `outcome`（`success`・`failure`・`cancelled`・`skipped`） |
| `--execution-file` | パス | `--ensure` のときの、action の出力 `execution_file`。省けて、空でもよい |
| `--dry-run` | 真偽値 | コメント・ボード・ラベルに書かず、書くはずの内容を出す |

| 条件 | 振る舞い |
|---|---|
| 結果が `question`・`failed`・`limit` | 結果のコメントを書き、既定の Status を Needs Attention にし、起動ラベルを外す |
| 結果が `pr-created`・`out-of-scope`・`setup-missing` | 結果のコメントを書き、起動ラベルを外す。既定の Status は書かない |
| 結果が `ci-passed`・`ci-fix-pushed` | 結果のコメントを書く |
| `--ensure` で、同じ run・同じ試行の結果のコメントがある | コメントは書かない。起動ラベルが残っていれば外し、結果が待ちの値を書くもの（`question`・`failed`・`limit`）なら、札も書き直す |
| `--ensure` で、無い | 下の表の順で結果を決めて書く |
| 既定の Status に待ちの値が無い | 結果のコメントに足りない設定を足す。進行の欄は変えない。終了は成功 |
| 本文がテンプレートの検証を通らない | テンプレートの検証の失敗として止まり、指摘を出す。既存の `issue_comment` と同じ |

`--ensure` の結果の決め方は、spec 027 の `review finish --ensure` と同じ形だ（spec 027 の research の R9）。上から順に見て、最初に当たった行で決める。

| 条件 | 結果 |
|---|---|
| job が成功 | 何も書かない。結果のコメントは、スキルが `--result` で書いている |
| job が `cancelled` | `limit`。時間の上限と手での取り消しは見分けない |
| `execution_file` の最後の `result` が `subtype: error_max_turns` | `limit` |
| それ以外の失敗 | `failed` |

- `execution_file` は runner の上のファイルなので読める。無いか読めなければ、その行を飛ばす
- 補助の引数は、`--ensure` なしで渡すと入力の誤りで止まる。`--ensure` のときは、`--job-status` と `--run-outcome` が要る
- `--result` と `--ensure` は、どちらか 1 つを渡す。両方・どちらも無しは、入力の誤りで止める
- 外す起動ラベルの名前は、環境変数 `PECOT_AUTO_LABEL` から読む。無ければ `pecot-auto` だ。引数では渡さない
- 結果のコメントの目印に入れる run と試行は、環境変数 `GITHUB_RUN_ID` と `GITHUB_RUN_ATTEMPT` から作る。`GITHUB_RUN_ID` が無ければ、目印を付けずに書く
- 目印を探すのは、bot のコメントだけだ
- 起動ラベルが既に外れていても、失敗にしない
- トークンの値と secret の名前の値を、コメントに書かない

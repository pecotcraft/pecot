# Data Model: ラベルを契機にした自動処理

自動処理は、自前の保存先を持たない。状態は、GitHub の Issue・ラベル・ボードと、利用者のリポのファイルに置く。
コマンドの入出力は [contracts/cli-commands.md](contracts/cli-commands.md) にある。

## 実体と関係

```text
導入先のリポ
├── ワークフローの雛形（1 つ）          .github/workflows/pecot-auto.yml（`workflow install auto` が書く）
├── プロジェクトの設定（1 つ）          .pecot/config/projects/<名前>.json
└── Issue *
    ├── 起動ラベル（0 か 1）
    ├── 計画のコメント（0 か 1）         既存の plan のテンプレート
    ├── 結果のコメント *                 自動処理の実行 1 回につき 1 つ
    ├── ブランチ（0 か 1）               feat/<説明>/<Issue番号>
    ├── PR（0 か 1）
    └── ボードのカード（1 つ）
        ├── 進行の欄                     pecot が動かす
        └── 既定の Status                既定の自動化と、待ちの値だけ pecot が動かす
```

## 自動処理の実行

1 つの Issue に対する 1 回の run を指す。保存はしない。`auto gate` がイベントから組み立てる。

| 欄 | 型 | 決め |
|---|---|---|
| `issue` | 文字列 | `owner/repo/N` の形 |
| `number` | 整数 | Issue の番号。同時実行のグループが使う |
| `kind` | `start`・`resume`・`ci-fix`・`ci-passed` | 下の表で決まる |
| `proceed` | 真偽値 | 偽なら、エージェントを起こさない |
| `reason` | 文字列 | `proceed` が偽のときの理由。英語の 1 行 |
| `branch` | 文字列 | 既にあるブランチ。無ければ空 |
| `pr` | 整数 | 既にある PR の番号。無ければ 0 |
| `ci_attempts` | 整数 | これまでに CI を直した回数 |

種類は、次の表で決まる。

| 契機 | 条件 | `kind` | `proceed` |
|---|---|---|---|
| `issues: labeled` | 計画のコメントもブランチも無い | `start` | 真 |
| `issues: labeled` | 計画のコメントかブランチがある | `resume` | 真 |
| `issues: labeled` | 対象外（下の表） | — | 偽 |
| `workflow_run` | CI が落ち、直した回数が上限より少ない | `ci-fix` | 真 |
| `workflow_run` | CI が落ち、直した回数が上限に達した | `ci-fix` | 偽 |
| `workflow_run` | CI が通った | `ci-passed` | 偽 |
| `workflow_run` | Issue に、同じブランチで PR を作ったという目印が無い | — | 偽。何も書かない |

対象外の条件（FR-013）は、次の表のとおりだ。

| 条件 | 判定に使うもの |
|---|---|
| Issue が closed | Issue の state |
| Epic・Tracker | Issue Type と、タイトルの `[Epic]`・`[Tracker]` |
| sub-issue を持つ | sub-issue の数 |
| PR に付いたラベル | イベントの `issue.pull_request` |
| 進行の欄が Backlog・Pending・Archived | 進行の欄の値 |
| 進行の欄が Blocked | 進行の欄の値。理由のコメントに、待っている前提を書く |
| 人が着手している | 進行の欄が Active か In Review で、Issue に自動処理の結果のコメントが 1 つも無い |
| ラベルを付けた人に書き込み権限が無い | `sender` の `collaborators/<login>/permission` の `role_name` が、`admin`・`maintain`・`write` のどれでもない。何も書かずに止める |

- 書き込み権限の無い人が付けた起動ラベルは、何も書かずに止めるので、ラベルは残る

進めるのは 3 つの場合だけだ。

| 場合 | 扱い |
|---|---|
| 進行の欄が Ready | そのまま進める |
| ボードに無い | `pecot auto start` が Ready でボードに載せてから進める |
| Active か In Review で、自動処理の結果のコメントがある | 起動し直しとして進める |

Backlog と Pending は、ボードの上にしか無い値だ。ボードに無い Issue は、そのどちらでもない。Epic・Tracker は、上の表の別の行で止まる。
理由のコメントには、今の進行の欄の値と、`w-ready` で Ready に置く手順を書く。

変更の大きさと、ほかのリポにまたがるかは、`gate` では決まらない。スキルが計画の時点で判断する。

## 結果

自動処理の実行の終わり方を指す。結果のコメントの種類と、ボードの書き込みを決める。

| 結果 | 意味 | 進行の欄 | 既定の Status | 起動ラベル |
|---|---|---|---|---|
| `pr-created` | PR を作った。CI の結果を待つ | In Review（`pr create` が書く） | 書かない | 外す |
| `ci-passed` | PR の CI が通った | In Review のまま | 書かない | — |
| `ci-fix-pushed` | CI の失敗を直して push した | In Review のまま | 書かない | — |
| `question` | 質問を書いて止まった | Active のまま | 待ちの値 | 外す |
| `out-of-scope` | 対象外で止まった | 変えない | 書かない | 外す |
| `failed` | テストや検証を通せずに止まった | 変えない | 待ちの値 | 外す |
| `limit` | ターン・時間・CI を直す回数の上限で止まった | 変えない | 待ちの値 | 外す |
| `setup-missing` | 設定が足りずに止まった | 変えない | 書かない | 外す |

- `out-of-scope` と `setup-missing` は、着手していないので待ちの値を書かない
- 進行の欄を書くのは、既存の `session_start`（MCP ツール）と `pr_create` だけだ。`auto` のコマンドは書かない

## 既定の Status の遷移

pecot が書くのは、太い矢印の 2 つだけだ。

```text
Todo ──(PR の連携: 既定の自動化)──> In Progress ──(クローズ: 既定の自動化)──> Done
 │  ▲                                  │  ▲
 │  └──(start: PR が無い)              │  └──(start: PR がある)
 ▼                                     ▼
Needs Attention <──(finish: question・failed・limit)──
```

| 書く時点 | 書くコマンド | 前の値 | 後の値 |
|---|---|---|---|
| 人の対応を待って終わる | `auto finish` | Todo または In Progress | Needs Attention |
| 起動し直す。PR が無い | `auto start` | Needs Attention | Todo |
| 起動し直す。PR がある | `auto start` | Needs Attention | In Progress |

前の値が Needs Attention でなければ、`auto start` は何も書かない。

### 自動処理が書いた札か

`auto start` が戻すのは、自動処理が書いた `Needs Attention` だけだ。pecot の判定（`board_sync` など）が置いた `Needs Attention` は戻さない。

| 決め | 内容 |
|---|---|
| 決め方 | 今の札が `Needs Attention` で、Issue の最後の結果のコメントが、待ちの値を書く結果（`question`・`failed`・`limit`）の目印を持つとき、自動処理が書いたとする |
| 渡す先 | 既存の判定 `decideBoardMove` の入力 `labelWrittenByAutomation`（`cli/src/domain/board-move.ts`）。今は、呼ぶ側 3 か所が `false` 固定だ |
| 見る目印 | bot のコメントの目印だけ。人が目印を書き込んで、札を戻させないようにする |

## 結果のコメント

Issue に残すコメント。テンプレートは `cli/templates/comment/auto-result.md` に置く。

| 欄 | 決め |
|---|---|
| 目印 | 本文の先頭の HTML コメント。`<!-- pecot-auto: result=<結果> run=<run の ID> attempt=<試行> branch=<ブランチ> -->`。`run` と `attempt` は、環境変数 `GITHUB_RUN_ID` と `GITHUB_RUN_ATTEMPT` から作る |
| 見出し | 結果を 1 行で書く |
| 本文 | 結果ごとに要るものだけを書く。質問、落ちたテスト、落ちているチェック、足りない設定 |
| 実行の記録 | run の URL |
| 次の手 | 人がすることを 1 行で書く。答えを書いて起動ラベルを付け直す、など |

- CI を直した回数は、`result=ci-fix-pushed` の目印を持つコメントの数で数える
- 同じ run・同じ試行の目印を持つコメントが既にあれば、`auto finish --ensure` は何も書かない
- 目印を探すのは、bot のコメントだけだ。人が目印を書き込んで、記録を消せないようにする

## プロジェクトの設定に足すキー

`.pecot/config/projects/<名前>.json` の `project.fields.status` は、実装済みだ（#376・#404）。今あるキーは次のとおりだ。

| 欄 | 型 | 決め |
|---|---|---|
| `status.id` | 文字列 | 既定の Status のフィールドの ID |
| `status.options.needs_attention` | 文字列 | 待ちの値 `Needs Attention` の選択肢の ID |
| `status.options.todo` | 文字列 | 選択肢の ID |

足すのは `status.options.in_progress` だけだ。`auto start` が、PR のある Issue の札を In Progress に戻すのに要る。`LABEL_CONFIG_KEYS` にも `In Progress` を足す。

- `status` が無い設定は、今までどおり読める。`auto` のコマンドだけが、`pecot project init` の打ち直しを求める
- 選択肢は名前で探す。利用者が既定の Status の値の名前を変えていると見つからない。そのときは、見つからない名前を出して止まる

## 雛形の一覧の `auto` の行

`cli/src/domain/workflow-template.ts` の `WORKFLOW_TEMPLATES` に足す行だ。欄は、spec 027 の data-model の「雛形の一覧」に、`auto` が足す 3 つを加えたものだ。

| 欄 | 値 |
|---|---|
| 名前 | `auto` |
| 雛形のファイル | `cli/templates/workflow/pecot-auto.yml` |
| 置き先 | `.github/workflows/pecot-auto.yml` |
| 要る変数と secret | 下の「エージェント用の認証」のうち、App の変数と secret の両方と、モデルの認証 |
| 確かめの種類（足す） | 起動ラベル・設定の `fields.status`・待ちの値・ボードの既定の自動化・CI のワークフローの名前（[contracts/cli-commands.md](contracts/cli-commands.md)） |
| 導入の後の案内（足す） | App の作成、変数と secret の登録、起動ラベルの作成、CI の名前の記入 |
| Claude の App の項目を出すか（足す） | 出さない |

## エージェント用の認証

名前は、spec 027 の data-model の「エージェント用の認証」と同じだ。この自動処理は自前の App を必須にする。

| 名前 | 種類 | この自動処理での扱い |
|---|---|---|
| `PECOT_AGENT_APP_CLIENT_ID` | 変数 | 必須 |
| `PECOT_AGENT_APP_PRIVATE_KEY` | secret | 必須 |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | モデルの認証。既定 |
| `PECOT_AGENT_ANTHROPIC_*`（4 つ） | 変数 | secret が無いときの Workload Identity Federation |

## ワークフローの雛形が持つ値

| 値 | 既定値 | 決まる時点 |
|---|---|---|
| 版の目印 | `# pecot-workflow-template: auto <版>`。CLI の持つ版 | 書き出しのとき |
| 起動ラベルの名前 | 変数 `PECOT_AUTO_LABEL`。既定 `pecot-auto` | 利用者が変えられる |
| CI のワークフローの名前 | 仮の名前 | 利用者が、印の囲みの中に書く |
| ターンの上限 | 変数 `PECOT_AUTO_MAX_TURNS`。既定 80 | 利用者が変えられる |
| 時間の上限 | 変数 `PECOT_AUTO_TIMEOUT_MINUTES`。既定 30 分 | 利用者が変えられる |
| CI を直す回数の上限 | 変数 `PECOT_AUTO_MAX_CI_ATTEMPTS`。既定 3 | 利用者が変えられる |
| 複数のボードに入ったリポでの指定 | #640 が決める変数 | #640 の決めで足す |
| 利用者の準備の step | 空 | 利用者が足す |
| 利用者のテストのコマンドの許可 | 空。`PECOT_AUTO_EXTRA_ALLOWED_TOOLS` | 利用者が足す |

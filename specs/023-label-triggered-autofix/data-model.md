# Data Model: ラベルを契機にした自動処理

自動処理は、自前の保存先を持たない。状態は、GitHub の Issue・ラベル・ボードと、利用者のリポのファイルに置く。
コマンドの入出力は [contracts/cli-commands.md](contracts/cli-commands.md) にある。

## 実体と関係

```text
導入先のリポ
├── ワークフローの雛形（1 つ）          .github/workflows/pecot-auto.yml
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

1 つの Issue に対する 1 回の run を指す。保存はしない。`pecot auto gate` がイベントから組み立てる。

| 欄 | 型 | 決め |
|---|---|---|
| `issue` | 文字列 | `owner/repo/N` の形 |
| `kind` | `start`・`resume`・`ci-fix`・`ci-passed` | 下の表で決まる |
| `proceed` | 真偽値 | 偽なら、エージェントを起こさない |
| `reason` | 文字列 | `proceed` が偽のときの理由。英語の 1 行 |
| `branch` | 文字列 | 既にあるブランチ。無ければ空 |
| `pr` | 整数 | 既にある PR の番号。無ければ 0 |
| `ci_attempts` | 整数 | これまでに CI を直した回数 |
| `template_outdated` | 真偽値 | 置かれた雛形の版が、CLI の持つ版より古い |

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
| 人が着手している | 進行の欄が Active か In Review で、Issue に自動処理の結果のコメントが 1 つも無い |

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
- 進行の欄を書くのは、既存の `pecot create-branch` と `pecot pr create` だけだ。`pecot auto` のコマンドは書かない

## 既定の Status の遷移

pecot が書くのは、太い矢印の 2 つだけだ。

```text
Todo ──(PR の連携: 既定の自動化)──> In Progress ──(クローズ: 既定の自動化)──> Done
 │  ▲                                  │  ▲
 │  └──(start: PR が無い)              │  └──(start: PR がある)
 ▼                                     ▼
Waiting <──(finish: question・failed・limit)──
```

| 書く時点 | 書くコマンド | 前の値 | 後の値 |
|---|---|---|---|
| 人の対応を待って終わる | `pecot auto finish` | Todo または In Progress | Waiting |
| 起動し直す。PR が無い | `pecot auto start` | Waiting | Todo |
| 起動し直す。PR がある | `pecot auto start` | Waiting | In Progress |

前の値が Waiting でなければ、`start` は何も書かない。

## 結果のコメント

Issue に残すコメント。テンプレートは `cli/templates/comment/auto-result.md` に置く。

| 欄 | 決め |
|---|---|
| 目印 | 本文の先頭の HTML コメント。`<!-- pecot-auto: result=<結果> run=<run の ID> branch=<ブランチ> -->` |
| 見出し | 結果を 1 行で書く |
| 本文 | 結果ごとに要るものだけを書く。質問、落ちたテスト、落ちているチェック、足りない設定 |
| 実行の記録 | run の URL |
| 次の手 | 人がすることを 1 行で書く。答えを書いて起動ラベルを付け直す、など |
| 雛形の更新 | 雛形が古いときだけ、更新のコマンドを 1 行で書く |

- CI を直した回数は、`result=ci-fix-pushed` の目印を持つコメントの数で数える
- 同じ run の目印を持つコメントが既にあれば、`finish --ensure` は何も書かない

## プロジェクトの設定に足すキー

`.pecot/config/projects/<名前>.json` の `project.fields` に、`status` を足す。

| 欄 | 型 | 決め |
|---|---|---|
| `status.id` | 文字列 | 既定の Status のフィールドの ID |
| `status.options.todo` | 文字列 | 選択肢の ID |
| `status.options.in_progress` | 文字列 | 選択肢の ID |
| `status.options.done` | 文字列 | 選択肢の ID |
| `status.options.waiting` | 文字列 | 待ちの値の選択肢の ID |

- `status` が無い設定は、今までどおり読める。`pecot auto` のコマンドだけが、`pecot project init` の打ち直しを求める
- 選択肢は名前で探す。利用者が既定の Status の値の名前を変えていると見つからない。そのときは、見つからない名前を出して止まる

## ワークフローの雛形が持つ値

| 値 | 既定値 | 決まる時点 |
|---|---|---|
| 版の目印 | CLI の持つ版 | 書き出しのとき |
| 起動ラベルの名前 | `pecot-auto` | 書き出しのとき。利用者が変えられる |
| CI のワークフローの名前 | 無い | 書き出しのとき。利用者が選ぶ |
| プロジェクトの設定の名前 | 有効な設定の名前 | 書き出しのとき |
| App の変数と secret の名前 | `PECOT_AUTO_APP_CLIENT_ID`・`PECOT_AUTO_APP_PRIVATE_KEY` | 固定 |
| モデルの認証の secret の名前 | `ANTHROPIC_API_KEY` | 固定 |
| ターンの上限 | 80 | 利用者が変えられる |
| 時間の上限 | 30 分 | 利用者が変えられる |
| CI を直す回数の上限 | 3 | 利用者が変えられる |
| 利用者の準備の step | 空 | 利用者が足す |
| 利用者のテストのコマンドの許可 | 空 | 利用者が足す |

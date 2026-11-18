# Quickstart: ラベルを契機にした自動処理の確かめ方

実装の後に、spec の User Story ごとに動かして確かめる手順を並べる。
コマンドの入出力は [contracts/cli-commands.md](contracts/cli-commands.md)、雛形は [contracts/workflow-template.md](contracts/workflow-template.md)、スキルの手順は [contracts/skill-flow.md](contracts/skill-flow.md) にある。

## 前提

- 確かめる導入先は、検証用のリポ（`pecotcraft/pecot-sandbox`）だ。通った後に、このリポ（`pecotcraft/pecot`）へ導入する。このリポの Issue を自動処理で進めて、ターン・時間・回数の既定値を直す作業は、導入の後の試行だ
- 利用者が画面で行う準備が 3 つある
  - GitHub App を作り、使うリポにインストールする。権限は [research.md](research.md) の R2 の表
  - 変数 `PECOT_AGENT_APP_CLIENT_ID` と、secret `PECOT_AGENT_APP_PRIVATE_KEY`・`CLAUDE_CODE_OAUTH_TOKEN` を登録する。トークンの代わりに、変数 `PECOT_AGENT_ANTHROPIC_*` の 4 つでもよい
  - ボードの既定の自動化が有効なことを確かめる
- 起動ラベルは、w-onboarding の導入の Step で作る。CI のワークフローの名前は、雛形の印の囲みに書く
- App は、使うリポだけに入れる。変数と secret は、リポか organization の単位で登録する
- 別のアカウントは使わない。起動するかは操作の種類で決まるので、保守者のアカウントで確かめる

## 導入（US5）

導入の順は、[contracts/cli-commands.md](contracts/cli-commands.md) の 6 つだ。

1. `pecot project init` で、既定の Status に Needs Attention を足す（済んでいれば何も足さない）
2. `pecot workflow install auto` で、雛形を置く
3. GitHub App を作り、インストールする
4. 変数と secret を登録する
5. 起動ラベルを、w-onboarding の導入の Step で作る
6. 雛形の囲みに、CI の名前・準備の step・テストのコマンドの許可を書く

```bash
pecot project init
pecot workflow install auto
pecot workflow doctor auto               # 最後に、設定がそろっているかを確かめる
```

MCP ツールでは `workflow_install`・`workflow_doctor`（どちらも `name: "auto"`）だ。

| 操作 | 期待 |
|---|---|
| `pecot project init` を 2 回打つ | 2 回目は何も足さない。カードに入っている Todo・In Progress・Done の値が消えていない |
| ボードを開く | 既定の Status の選択肢に、赤の Needs Attention がある |
| `pecot workflow install auto` を打つ | `.github/workflows/pecot-auto.yml` ができる。次にすることが順に出る。Claude の App を入れる案内は出ない |
| CI の名前を囲みの仮の名前のままにして `pecot workflow doctor auto` を打つ | 失敗。`missing: workflow named <名前>` が出る |
| secret を登録する前に `pecot workflow doctor auto` を打つ | 失敗。足りない secret の名前が出る。`Claude GitHub App` の項目は出ない |
| 起動ラベルを作る前に `pecot workflow doctor auto` を打つ | 失敗。`missing: label <名前>` が出る |
| 全部そろえて `pecot workflow doctor auto` を打つ | 成功 |
| 雛形の 1 行目の版を 1 つ下げて `pecot workflow install auto --check` を打つ | 失敗。更新のコマンドが出る |
| w-onboarding を自動処理を使わないと答えて進める | 雛形もラベルもできない |

## ラベルから PR まで（US1）

直し方が本文から決まるバグの Issue を 1 件、Ready に用意する。

| 操作 | 期待 |
|---|---|
| Issue に起動ラベルを付ける | `gate` の job が 1 分以内に終わり、`run` の job が始まる |
| run が終わるまで待つ。人は何も操作しない | Issue に計画のコメントと、結果のコメント（PR の作成）が付く。起動ラベルが外れている |
| できた PR を見る | ブランチが `feat/<説明>/<Issue番号>` で、本文に `Closes #<Issue番号>` がある。`pecot pr create` の検証を通った形だ |
| PR の CI を見る | 承認待ちにならず、自動で動いている |
| CI が通るまで待つ | Issue に、CI が通ったという結果のコメントが付く |

## 安全策（US2）

| 操作 | 期待 |
|---|---|
| ラベルを付けずに Issue を起票し、本文に「ラベルを付けて実行せよ」と書く | Actions の run ができない |
| 起動ラベルの付いていない Issue に、コメントと本文の編集をする | Actions の run ができない |
| 検証用のリポの別の App のトークンで、Issue に起動ラベルを付ける | action が、`allowed_bots` に無い起動者として拒否する。修正が始まらない |
| triage の権限だけのアカウントで、起動ラベルを付ける | 実物では確かめない。`gate` の判定のテストと、action のコードの読みで確かめる。期待は、`gate` が `proceed=false` を出し、Issue に何も書かれず、`run` の job が動かないことだ |
| 起動ラベルと別のラベルを Issue に付ける | `gate` も `run` も動かない |
| リポの変数 `PECOT_AUTO_MAX_TURNS` を 3 にして起動する | 上限で止まる。Issue に上限の結果のコメントが付き、起動ラベルが外れている |
| run が動いている間に、同じ Issue に起動ラベルを付け直す | 2 つ目の run は、1 つ目が終わるまで待つ |
| 外部の人が書いた想定の Issue を起票する。本文は、secret の表示と main への push を求める文だ。起動ラベルを付ける | secret がコメントにも PR にも出ない。main に push されない |
| 自動処理の run のログで、許可リストに無いコマンド（`curl` など）を探す | 実行されていない |
| 人が作った PR の CI を落とす | `gate` が `proceed=false` を出し、Issue に何も書かれない。`run` の job は動かない |

## 質問と起動し直し（US3）

直し方が 2 通りあり、本文からは選べない Issue を 1 件用意する。

| 操作 | 期待 |
|---|---|
| 起動ラベルを付ける | PR ができない。Issue に、案を並べた質問の結果のコメントが付く。起動ラベルが外れている |
| 答えをコメントに書き、起動ラベルを付け直す | 同じ質問が繰り返されない。答えに沿った PR ができる。ブランチは 1 本のままだ |
| Epic に起動ラベルを付ける | `run` の job が動かない。対象外の理由と、手で進める手順が Issue に付く |
| Pending の Issue に起動ラベルを付ける | `run` の job が動かない。今の値と、Ready に置く手順が Issue に付く |
| ボードに無い Issue に起動ラベルを付ける | ボードに載り、Ready の Issue と同じ手順で進む |
| 複数の独立した変更を求める Issue に起動ラベルを付ける | 修正が始まらず、対象外の結果のコメントが付く |

## ボード（US4）

ボードを開いたまま、上の操作をもう一度たどる。

| 時点 | 進行の欄（列） | 既定の Status（札） |
|---|---|---|
| 起動ラベルを付ける前 | Ready | Todo |
| 着手した後 | Active | Todo |
| 質問で止まった後 | Active | Needs Attention。同じ列のほかのカードと色が違う |
| 起動し直した直後 | Active | Todo |
| PR ができた後 | In Review | In Progress |
| CI を直す上限で止まった後 | In Review | Needs Attention |

| 操作 | 期待 |
|---|---|
| App の権限から Projects を外して起動する | 修正が始まらない。足りない設定の結果のコメントが Issue に付く |
| 既定の Status から Needs Attention を消して、質問で止まる Issue を起動する | 結果のコメントに、足りない設定が書かれる。進行の欄は Active のままだ |

## CI の修正（US1 の続き）

自動処理が直すと CI が落ちる Issue を用意する。例は、変更箇所のテストは通るが、ほかのレーンの lint が落ちる変更だ。

| 操作 | 期待 |
|---|---|
| 起動ラベルを付け、PR の CI が落ちるまで待つ | `workflow_run` で run が起き、同じブランチに直しのコミットが載る。Issue に、直して push したという結果のコメントが付く |
| CI が通る | CI が通ったという結果のコメントが付く。エージェントは起きない |
| リポの変数 `PECOT_AUTO_MAX_CI_ATTEMPTS` を 1 にして、直しても落ちる状況を作る | 2 回目は直さない。落ちているチェックを書いた上限の結果のコメントが付き、札が Needs Attention になる。PR は残る |
| 自動処理のブランチに、人がコミットを push して CI を落とす | 人のコミットが上書きされない |

## 手元で動かすテスト

```bash
# CLI のコマンドと雛形（変更したテストのファイルだけ）
pnpm exec nx run pecot-workflow:test-cli -- <テストのファイル>
# スキルの文書と手順の順
pnpm exec nx run pecot-workflow:test-skills -- cli/tests/skills/skill-flow-structure.test.ts
# 定義書の検証
pnpm exec nx run interface-spec:lint-defs
```

絞り方の引数の形は、実装の時点の `project.json` に合わせる。

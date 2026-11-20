# Implementation Plan: Issue にラベルを付けると、GitHub Actions が pecot の手順で直して PR まで作る

**Branch**: `023-label-triggered-autofix` | **Date**: 2026-11-11（2026-11-18 に spec 027 の共通の部分に合わせて改訂） | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/023-label-triggered-autofix/spec.md`

## Summary

pecot-workflow に、無人で Issue から PR まで進める仕組みを足す。
利用者のリポに置くワークフローの雛形が、起動ラベルを契機に claude-code-action を動かす。
action は pecot-workflow のプラグインを入れ、新しいスキル `w-auto` を起動する。
スキルは、ブランチの作成・計画の投稿・修正・テスト・PR の作成を、人を待たずに進める。
PR の CI が落ちると、`workflow_run` で別の run が起き、上限の回数まで直す。
「必ず起きること」は CLI に寄せる。新しい `pecot auto` の 3 つのコマンド（`gate`・`start`・`finish`）が、判定・結果のコメント・待ちの値・起動ラベルを扱う。3 つは MCP ツールとしても出る。
ボードの進行の欄は、今の CLI のとおりに動く。着手で Active、PR の作成で In Review になる。
人の対応を待って止まった Issue は、既定の Status に足す待ちの値（`Needs Attention`）で示す。
GitHub のトークンは、利用者が作る GitHub App の 1 本を使う。名前は共通の `PECOT_AGENT_APP_*` で、発行のときに job に要る権限へ絞る。ボードの更新と、PR の CI の自動起動を満たす。
導入は、spec 027 が作った `pecot workflow install`・`doctor` で行う。雛形の一覧に `auto` の行を足し、w-onboarding の流れから `pecot workflow install auto` と `pecot workflow doctor auto` で進める。

## Technical Context

| 項目 | 内容 |
|---|---|
| Language/Version | TypeScript（pecot-workflow の `cli/`）、GitHub Actions の YAML（雛形）、Markdown（スキル） |
| Primary Dependencies | 既存の CLI の依存。雛形が使う action は、claude-code-action v1、`actions/checkout`、`actions/setup-node`、`actions/create-github-app-token`（v3.3.0 以上。`permission-organization-projects` と出力 `app-slug` を持つ） |
| Storage | 利用者のリポのファイル（`.github/workflows/pecot-auto.yml`、`.pecot/config/projects/*.json`）と、GitHub の Issue のコメント・ラベル・ボード |
| Testing | vitest（CLI と雛形。`cli/src/**/tests/`・`cli/tests/`）、スキルの文書のテスト（`cli/tests/skills/`）、定義書の lint と `verifies`、検証用のリポでの CUJ |
| Target Platform | GitHub Actions の ubuntu の runner（自動処理）と、利用者の PC（導入） |
| Project Type | 配布するプラグイン（CLI・スキル・テンプレート） |
| Performance Goals | `gate` の job は、エージェントを起こさずに 1 分以内に終わる。1 ファイルの修正は、1 回の run の上限（30 分・80 ターン）に収まる。上限は、リポの変数で変えられる |

**前提**: 複数のボードに入ったリポでの指定は、#640 が決める。#640 はまだ開いていて、変数の名前が決まっていない。この自動処理はボードに書くので、決まった変数を雛形に足す。tasks の依存にも書く。

**Constraints**:

- w-quick・w-active・w-pr の文と、既存のコマンドの振る舞い・終了コードを変えない
- 検証を迂回しない。`--no-verify` と、テンプレートの検証を外すオプションを使わない
- エージェントは既定の Status に触れない。書くのは `auto start` と `auto finish` だけだ
- 雛形は、このリポ固有の名前を持たない。CI のワークフローの名前は、利用者が印の囲みの中に書く。App の変数の名前は共通の `PECOT_AGENT_APP_*` だ
- プラグインの版は固定できない。雛形と CLI の版のずれは、版の目印で知らせる
- 認証・版の目印・囲みの印・起動者の確かめ・許可と拒否のツール・上限の書き方は、spec 027 が決めた共通の形に従う
- ルート直下にディレクトリを足さない

**Scale/Scope**:

- CLI のコマンド 3 つ（定義書の項目 3 つと、vitest のテスト）
- 雛形の一覧の `auto` の行と、`doctor` の確かめの種類の追加（起動ラベル・既定の Status・待ちの値・ボードの既定の自動化・CI の名前）
- `workflow install`・`doctor` の、導入の後の案内と Claude の App の項目の出し分け
- スキル 1 本、コメントのテンプレート 1 つ、ワークフローの雛形 1 つ
- 既定の Status の待ちの値と設定の `fields.status` は、実装済みだ（#376・#404）。足すのは、設定のキー `status.options.in_progress` と、札を自動処理が書いたかの受け渡し（`labelWrittenByAutomation`）だ
- 文書は、導入の説明 `auto-workflow.md`（新規）と、`skills.md`・`commands.md`・`auth-config.md`・`w-onboarding/SKILL.md`・`.claude/rules/github-workflows.md` の修正だ
- `board-status.md`・`spec-driven-workflow.md` の In Review と、`board_url` のスクリプトは済んでいる

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

2026-11-18 の改訂で、`.specify/memory/constitution.md` の 4.0.0 の原則 I〜IX に合わせて書き直した。

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. ライブラリ優先 | 合格 | 判定と状態の決め（種類・結果・待ちの値を書くか）は `cli/src/domain/` のモジュールに置く。`commands/` と MCP ツールの入口には処理を書かない。新しい nx project は作らない |
| II. CLI インタフェース | 合格 | 3 つのコマンドは、引数・標準入力・ファイルでテキストを受け取り、標準出力に出す。構造のあるデータは JSON で出す。CLI と MCP サーバが同じ処理を呼び、結果は定義書の `outputSchema` と一致させる |
| III. テストファースト | 合格 | `gate` の判定・結果のコメントの数え方・選択肢の追加（`id` を保つこと）は、失敗する入力のテストを先に書き、Red を確かめる。利用者の承認は、この計画の承認で兼ねる。公開面の振る舞いは定義書に項目で書き、テストに `verifies` でつなぐ |
| IV. 標準準拠と不適合の是正 | 合格 | 下の「標準との対照」のとおり。残す不適合は無い。実機の確かめで差が出たら、その場でユーザーに伝えて判断を仰ぐ |
| V. 品質の自動チェック | 合格 | 新しいコードは、既存の lint・strict の型チェック・knip の対象に入る。雛形は actionlint と vitest で確かめる。`--no-verify` を使わない |
| VI. 層の分離 | 合格 | 判定と状態の決めは `cli/src/domain/` に、GitHub とファイルの I/O は `cli/src/infra/` に置く。`commands/` は引数と出力だけを持つ。層の向きは、既存の eslint の設定が止める |
| VII. シンプルさ | 条件つき合格 | 新しい nx project は作らず、pecot-workflow の中だけに置く。コマンドを 3 つ足す理由は Complexity Tracking に書く。user 所有のボード、GitHub Copilot CLI での無人の実行、レビュー指摘への対応、ラベル以外の契機は作らない |
| VIII. 抽象化しない | 合格 | claude-code-action・`actions/create-github-app-token`・GitHub の API を、包む層を作らずに直接使う。雛形を書き出す仕組みは、spec 027 の `workflow install` をそのまま使う |
| IX. 統合を先にするテスト | 合格 | モックは HTTP とファイルの境界だけにし、期待は出力の行と API に渡す値で比べる。単体テストの後に、検証用のリポ（`pecotcraft/pecot-sandbox`）で実際の Issue を使って CUJ を流す。このリポへの導入は、その後に行う |

Phase 1 の設計の後も、同じ判定になる。

### 標準との対照

読んだ仕様は、claude-code-action の `v1.0.278` の README・docs・`action.yml`・ソース・examples と、`actions/create-github-app-token` の v3.3.0、GitHub Actions の公式の文書だ。
出典は [research.md](research.md) と、spec 027 の research にある。

| 項目 | 標準の形 | この計画 | 判定 |
|---|---|---|---|
| 契機 | `issues: labeled` と、CI の結果を受ける `workflow_run`。公式の例 `ci-failure-auto-fix.yml` がある | 同じ 2 つだけ。`pull_request_target` は使わない | 適合 |
| `workflow_run` の `on` | `on` には式を書けない | CI の名前は、利用者が印のコメントで囲んだ `workflow_run.workflows` の行に書く。`gate` は式を `on` に置かない | 適合 |
| job の `if` | 使える context は `github`・`needs`・`vars`・`inputs` | 起動ラベルと上限は `vars` と式の `\|\|` で読む。`env` は読まない | 適合 |
| `timeout-minutes` | 式を受け付ける。変数の値は文字列 | `fromJSON(vars.PECOT_AUTO_TIMEOUT_MINUTES \|\| '30')` | 適合 |
| action の版 | full-length の commit SHA で固定する | SHA で固定し、版をコメントに書く | 適合 |
| job の権限 | `permissions` を最小にする | `gate` は `contents: read`、`run` は `contents: read` と `id-token: write`。書き込みは、発行のときに `permission-*` で絞った App のトークンで行う | 適合 |
| 起動者の確かめ | action が actor の write を確かめる。`allowed_non_write_users` は使わない | `gate` が `sender` の権限を読み、action の確かめも重ねる | 適合 |
| bot の許可 | `allowed_bots` に名前を列挙する。`*` を使わない。`<slug>` と `<slug>[bot]` のどちらでも通る | 発行の step の出力 `app-slug` を渡す | 適合 |
| 権限のモード | 厳密にするときは `--permission-mode default` を明示する。`allowed_bots` を置くと既定が auto にならない | 明示する | 適合 |
| 上限と許可リスト | `claude_args` の `--max-turns`・`--allowedTools`。古い入力は使わない | `claude_args` に書く | 適合 |
| スキルの起動 | `prompt` に `/スキル名 引数` を書く | 同じ形 | 適合 |
| `prompt` の中身 | 外部の人が書ける文を式で埋め込まない | 種類・リポの名前・Issue の番号だけ | 適合 |
| モデルの認証 | トークンと Workload Identity Federation を同時に渡さない | secret `CLAUDE_CODE_OAUTH_TOKEN`。無ければ `PECOT_AGENT_ANTHROPIC_*` の 4 変数。`anthropic_api_key` は渡さない | 適合 |
| 書き換えのツール | 公式の文書は、許可と拒否の規則で道具を絞る | 共通の決まりは書き換えのツールを拒否に書く。この自動処理は直すのが仕事なので、`Edit`・`Write` を許す。ほかの拒否（`Agent`・`AskUserQuestion`・`WebFetch`・`WebSearch`・`Bash(git clone:*)`・`Read(//proc/**)`）は共通の決まりと同じ | 共通の決まりと違う。仕様の範囲の中の選択 |
| 同時実行 | 公式の PR 向けの例は `cancel-in-progress: true` | `false`。途中で取り消すと、計画のコメントだけが残る | 例と違う。仕様の範囲の中の選択 |
| 雛形の導入 | 雛形を書き出す標準は無い。spec 027 の共通の形に従う | 一覧の行を足し、`workflow install`・`doctor` で行う。独自の `auto install` は作らない | 適合 |

`Edit`・`Write` を許すので、境界は許可リストでなく、App の権限・保護されたブランチの ruleset・`--permission-mode default` で規則の無いコマンドを拒むことだ（FR-029）。

## Project Structure

### Documentation (this feature)

```text
specs/023-label-triggered-autofix/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli-commands.md
│   ├── skill-flow.md
│   └── workflow-template.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
plugins/pecot-workflow/
├── cli/
│   ├── src/
│   │   ├── commands/
│   │   │   ├── auto.ts                  # 新規。gate・start・finish
│   │   │   ├── workflow.ts              # 導入の後の案内と Claude の App の項目を、一覧の行で出し分ける
│   │   │   ├── board-judgment.ts        # labelWrittenByAutomation を、結果のコメントの目印から渡す（issue-create.ts・issue-dependency.ts も同じ）
│   │   │   └── registry.ts              # 3 つのコマンドの登録。MCP ツールもここから出る
│   │   ├── domain/                      # 判定・結果・待ちの値。workflow-template.ts の一覧に auto の行と確かめの種類を足す。board-move.ts の LABEL_CONFIG_KEYS に In Progress を足す
│   │   └── infra/                       # GitHub の既定の Status・ラベル・権限の読み書き、結果のコメントの検索
│   ├── templates/
│   │   ├── comment/auto-result.md       # 新規。結果のコメント
│   │   └── workflow/pecot-auto.yml      # 新規。ワークフローの雛形
│   └── tests/
│       ├── interface/                   # コマンドの振る舞いのテスト。workflow-install.test.ts・review-finish.test.ts と同じ並び
│       └── skills/skill-flow-structure.test.ts  # w-auto の Step の順を足す
├── interface/
│   ├── generated.json                   # 書き出し直す
│   └── authored.yaml                    # 3 つの項目と振る舞いの項目
├── skills/
│   ├── w-auto/SKILL.md                  # 新規
│   ├── w-onboarding/SKILL.md            # 導入の手順と、起動ラベルを作る Step を足す
│   └── w-help/
│       ├── SKILL.md                     # スキルの表
│       └── references/
│           ├── auto-workflow.md         # 新規。導入の説明
│           └── skills.md・commands.md・auth-config.md   # 修正。board-status.md は、既定の Status との関係が足りなければ足す
└── README.md                            # スキルの表

.github/workflows/pecot-auto.yml         # このリポへの導入。雛形から書き出したもの
.claude/rules/github-workflows.md        # workflow の一覧に pecot-auto.yml を足す
.nx/version-plans/                       # PR ごとの version plan
```

**Structure Decision**: 新しいコードは pecot-workflow の中だけに置く。判定は `cli/src/domain/` に、雛形は `cli/templates/workflow/` に置く。雛形は配布物なので、`.github/workflows/` には書き出した結果だけを置く。自動レビューの雛形と同じ並びだ。

## 実装の段階と PR

| 段階 | 中身 | 対応 |
|---|---|---|
| 1 | 設定のキー `in_progress` と、札を自動処理が書いたかの受け渡し。待ちの値・`fields.status`・ボードの説明は実装済み | FR-042〜FR-044 |
| 2 | `auto gate`・`start`・`finish` と、結果のコメントのテンプレート。足りない設定を Issue に書く経路 | FR-008・FR-011〜FR-013・FR-021・FR-038〜FR-041 |
| 3 | スキル `w-auto` の、始める・続ける の手順。進行の欄は手で回すときと同じ規則で動かす | US1・US3・FR-002〜FR-007・FR-009・FR-010・FR-014・FR-018 |
| 4 | ワークフローの雛形と、雛形の一覧の `auto` の行。検証用のリポでの導入 | US2・FR-001・FR-015〜FR-017・FR-020・FR-022〜FR-029 |
| 5 | CI を直す手順。雛形の `workflow_run` の契機と、スキルの CI を直す種類 | FR-035〜FR-037 |
| 6 | 一覧の行の確かめの種類と、導入の後の案内の出し分け。`workflow install auto`・`doctor auto` と、w-onboarding・認証の説明への導入の手順 | US5・FR-019・FR-030〜FR-034 |
| 7 | 検証用のリポ（`pecotcraft/pecot-sandbox`）で CUJ を通し、その後このリポへ導入する。このリポでの試行で、ターン・時間・回数の既定値を直すのは、導入の後だ | SC-001〜SC-011 |

段階 4 までで、ラベルから PR までが通る。段階 5 は、その上に CI の修正を足す。
段階 4 の雛形には、#640 が決める変数を足す。

## Complexity Tracking

| 足すもの | 要る理由 | より単純な案を採らない理由 |
|---|---|---|
| `pecot auto` の 3 つのコマンド | 結果のコメントと起動ラベルを外すことは、エージェントがターンの上限で切られても起きなければならない。対象外と上限の判定は、毎回同じ結果でなければならない | スキルの文だけで書くと、上限で切られたときに何も残らない。判定も実行ごとに揺れる |
| ワークフローの 2 つの job と 2 つの契機 | installation token が 1 時間で切れる。CI を同じ job で待てない | 1 つの job で待つ形は、CI の時間と直す回数の積が期限に当たる |
| 既定の Status への書き込み | 画面で比べた結果、止まった Issue に気づけるのは、札の色が変わる形だけだった | ラベルの札は目に入らず、進行の欄に値を足すと列と既存のボードの移行に広がる |
| 雛形の一覧の行の、確かめの種類と案内の出し分け | `auto` は、変数と secret のほかに、起動ラベル・既定の Status・待ちの値・ボードの既定の自動化・CI の名前を確かめる（FR-032）。導入の後の案内と Claude の App の項目も、自前の App が必須なので `review` と違う | 今の `workflow install`・`doctor` は自動レビューだけに合う。そのままだと、Claude の App を入れるよう誤って案内する。`auto` 専用の導入のコマンドは、共通の形を作り直すことになる |

# Implementation Plan: PR を作ると、GitHub Actions の上で w-revise のレビューが始まる

**Branch**: `027-auto-revise-on-pr` | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/027-auto-revise-on-pr/spec.md`

## Summary

pecot-workflow に、PR の作成で w-revise のレビューを始める仕組みを足す。pecot の最初のクラウドのエージェントだ。
利用者のリポに置くワークフローの雛形が、`pull_request` を契機に claude-code-action を動かす。
action は pecot-workflow のプラグインを入れ、`/pecot-w:w-revise --unattended <PR>` を起動する。
w-revise は、w-reviewer の定義を読んで自分で diff を見て、指摘をインラインコメントと `review-findings` で投稿して終わる。
採否・修正・resolve は行わない。続きは、人が端末の w-revise を起こすと、自動レビューの指摘を引き継いで進む。
GitHub のトークンは、既定では Claude の App のものだ。書き込みを持つので、エージェントに書き換えのツールを渡さないことで、リポの内容を守る。権限を絞りたい利用者は、自前の App を置ける。
「必ず起きること」は CLI に寄せる。新しい `pecot pr review-finish` が、止まったときのコメントを書く。
導入は、w-onboarding の流れから `pecot workflow install review` と `pecot workflow doctor review` で進める。
認証の名前・雛形を置いて確かめるコマンド・雛形の書き方の決まりは、後に続く自動処理（spec 023）が使える共通の形で作る。

## Technical Context

| 項目 | 内容 |
|---|---|
| Language/Version | TypeScript（pecot-workflow の `cli/`）、GitHub Actions の YAML（雛形）、Markdown（スキル） |
| Primary Dependencies | 既存の CLI の依存。雛形が使う action は、claude-code-action v1、`actions/checkout`、`actions/setup-node`、`actions/create-github-app-token` |
| Storage | 利用者のリポのファイル（`.github/workflows/pecot-review.yml`）と、GitHub の PR のコメント・スレッド |
| Testing | vitest（CLI と雛形）、スキルの文書のテスト（`cli/tests/skills/`）、定義書の lint、検証用のリポでの CUJ |
| Target Platform | GitHub Actions の ubuntu の runner（自動レビュー）と、利用者の端末（導入と引き継ぎ） |
| Project Type | 配布するプラグイン（CLI・スキル・テンプレート） |
| Performance Goals | 対象外の PR は、job の `if` で落ち、runner を使わない。1 回の自動レビューは、上限の既定値（30 分・60 ターン）に収まる。上限は、リポの変数で変えられる |

**Constraints**:

- w-revise の手で回す流れ（Step 1〜6 の順と、人に採否を聞くこと）を変えない
- 自動レビューは、リポの内容を変えない。エージェントに `Bash`・`Edit`・`Write` を渡さない。自前の App を置いたときは、発行するトークンに Contents の write を渡さない
- 指摘の採番・投稿先・コメントの形を、手で回すときと変えない。テンプレートの検証を迂回しない
- 雛形は、このリポ固有の名前を持たない
- プラグインの版は固定できない。雛形と CLI の版のずれは、版の目印で知らせる
- ルート直下にディレクトリを足さない
- 確かめは、検証用のリポで流す（spec 026）

**Scale/Scope**:

- CLI のコマンド 3 つ（`workflow install`・`workflow doctor`・`pr review-finish`）と、定義書の項目
- スキルの変更 2 本（w-revise・w-onboarding）、コメントのテンプレート 1 つ、ワークフローの雛形 1 つ
- 文書 3 か所（w-help の `review-workflow.md` の新規、`auth-config.md`・スキルの表の修正）
- spec 023 の成果物の修正（FR-033）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 合格 | 雛形の一覧・版の比べ方・結果の決め方は `cli/src/domain/` に置く。ファイルと GitHub の読み書きは `cli/src/infra/` を通す。`commands/` は引数と出力だけを持つ。層の向きは既存の eslint の設定が止める |
| II. TDD | 合格 | `--ensure` の結果の決め方・版の比べ方・雛形の `if` の式は、失敗する入力のテストを先に書く。期待は、出力の行と API に渡す値で比べる。モックは HTTP とファイルの境界だけにする。公開面の振る舞いは定義書に書き、テストに `verifies` でつなぐ。単体テストの後に、検証用のリポで実際の PR を使って確かめる |
| III. コード品質 | 合格 | 新しいコードは、既存の lint・strict の型チェック・knip の対象に入る。雛形は actionlint と vitest で確かめる |
| IV. YAGNI | 条件つき合格 | コマンドを 3 つ足す。理由は Complexity Tracking に書く。修正まで進める形・push のたびの起動・コメントでの呼び出し・board sync の雛形の移行は作らない。雛形の一覧は、初版では 1 行だけだ |
| V. 本体優先 | 合格 | speckit 成果物は新規の一式を作る。spec 023 の成果物は、FR-033 の整合の修正だけを行う。ユーザーが Clarifications で決めた作業だ |
| VI. 標準準拠 | 合格 | 下の「標準との対照」のとおり。残す不適合は無い。段階 1 の実機の確かめで差が出たら、その場でユーザーに伝えて判断を仰ぐ |

Phase 1 の設計の後も、同じ判定になる。

### 標準との対照

読んだ仕様は、claude-code-action の `v1.0.276` の README・docs・`action.yml`・ソース・examples と、GitHub Actions の公式の文書だ。出典は [research.md](research.md) にある。

| 項目 | 標準の形 | この計画 | 判定 |
|---|---|---|---|
| 契機 | PR の中身を扱う処理は `pull_request`。`pull_request_target` で PR の中身を扱わない | `pull_request` だけ | 適合 |
| fork の判定 | `github.event.pull_request.head.repo.full_name == github.repository` | 同じ式 | 適合 |
| action の版 | full-length の commit SHA で固定する | SHA で固定し、版をコメントに書く | 適合 |
| job の権限 | `permissions` を最小にする | `contents: read`・`pull-requests: write`・`id-token: write`。`id-token` は Claude の App のトークンの引き換えに要る | 適合 |
| 起動者の確かめ | action が actor の write を確かめる。`allowed_non_write_users` は使わない | action に任せる | 適合 |
| bot の許可 | `allowed_bots` に名前を列挙する。`*` を使わない | 利用者が名前を列挙する | 適合 |
| 権限のモード | 厳密にするときは `--permission-mode default` を明示する | 明示する | 適合 |
| 上限と許可リスト | `claude_args` の `--max-turns`・`--allowedTools`。古い入力は使わない | `claude_args` に書く | 適合 |
| スキルの起動 | `prompt` に `/スキル名 引数` を書く | 同じ形 | 適合 |
| `prompt` の中身 | 外部の人が書ける文を式で埋め込まない | リポの名前と PR の番号だけ | 適合 |
| インラインコメントの投稿 | 公式の PR レビューの例は、action に同梱の MCP ツール `mcp__github_inline_comment__create_inline_comment` を使う | 雛形の許可リストに同じツールを入れる。`gh api` は許可しない。スキルは、投稿の手段を書かない | 適合 |
| 同時実行 | 公式の PR 向けの例は `cancel-in-progress: true` | `false` | 例と違う。仕様の範囲の中の選択 |

インラインコメントの投稿は、ユーザーの判断（2026-11-16）で、スキルに手段を書かない形にした。スキルは、何をどの形で投稿するかだけを決める。端末では今の `gh api` の手順で、人のいない実行では action のツールで投稿する（research の R4）。

`cancel-in-progress` は、どちらの値も GitHub の仕様が認める。途中で取り消すと、インラインコメントだけが残るので `false` にする（research の R6）。

## Project Structure

### Documentation (this feature)

```text
specs/027-auto-revise-on-pr/
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
│   │   │   ├── workflow.ts              # 新規。install・doctor
│   │   │   ├── pr-review-finish.ts      # 新規
│   │   │   └── registry.ts              # 3 つのコマンドの登録。MCP ツールもここから出る
│   │   ├── domain/                      # 雛形の一覧、版の比べ方、結果の決め方
│   │   └── infra/                       # 雛形の読み書き、変数・secret の読み取り
│   ├── templates/
│   │   ├── comment/review-stopped.md    # 新規。止まったことを知らせるコメント
│   │   └── workflow/pecot-review.yml    # 新規。ワークフローの雛形
│   └── tests/
│       └── review-workflow-template.test.ts  # 新規。雛形の形と、文書との一致
├── interface/
│   ├── generated.json                   # 書き出し直す
│   └── authored.yaml                    # 3 つの項目と振る舞いの項目
├── skills/
│   ├── w-revise/SKILL.md                # --unattended の分岐と、引き継ぎの分岐
│   ├── w-onboarding/SKILL.md            # 自動レビューを入れるかを選ぶ Step
│   └── w-help/
│       ├── SKILL.md                     # 参照の表
│       └── references/
│           ├── review-workflow.md       # 新規。導入の説明と、自動処理に共通の決まり
│           └── auth-config.md           # エージェント用の認証の名前
├── cli/tests/skills/                    # w-revise の文書のテスト
└── README.md

.github/workflows/pecot-review.yml       # このリポへの導入。雛形から書き出したもの
.nx/version-plans/                       # PR ごとの version plan
specs/023-label-triggered-autofix/       # FR-033 の整合の修正
```

**Structure Decision**: 新しいコードは pecot-workflow の中だけに置く。雛形は `cli/templates/workflow/` に置き、`.github/workflows/` には書き出した結果だけを置く。board sync の雛形と同じ並びだ。

## 実装の段階と PR

| 段階 | 中身 | 対応 |
|---|---|---|
| 1 | 設計を左右する点を、検証用のリポで先に確かめる。人のいない実行で w-reviewer が起きるか、プラグインの hooks が止めないか、絞ったトークンで MCP ツールが動くか、job の `concurrency` と `if` の関係 | research の「実装で確かめること」 |
| 2 | ワークフローの雛形と、そのテスト | US2、FR-001〜FR-004・FR-016・FR-017・FR-020〜FR-027 |
| 3 | `pecot workflow install`・`doctor` と、雛形の一覧。認証の名前と、雛形の書き方の決まり | US5、FR-019・FR-028・FR-030・FR-031 |
| 4 | `pecot pr review-finish` と、止まったことを知らせるコメントのテンプレート | FR-012・FR-018 |
| 5 | w-revise の Step 3 を「何を投稿するか」と「端末での投稿の手順」に分け、`--unattended` の分岐を足す | US1、FR-005〜FR-011・FR-013・FR-015 |
| 6 | w-revise の引き継ぎの分岐 | US3、FR-014 |
| 7 | w-onboarding の Step と、w-help の導入の説明 | US4、FR-029・FR-032 |
| 8 | 検証用のリポで quickstart を通し、ターンと時間の既定値を直す。その後、このリポへ導入する | SC-001〜SC-009 |
| 9 | spec 023 の成果物を、共通の部分を使う形に直す | FR-033 |

段階の番号は、tasks.md のフェーズの番号と同じだ。
段階 1・2・4・5 で、PR の作成から指摘の投稿までが通る。雛形は手で写して置く。段階 6 は、その上に端末での続きを足す。段階 3 と 7 は、導入のコマンドと手順を足す。
段階 1 の結果で設計が変わるときは、research と contracts を直してから、次の段階へ進む。

ほかの Epic との関係:

| Epic | 関係 |
|---|---|
| #456（spec 026、試験環境） | 段階 1 と段階 8 は、検証用のリポと、直したプラグインを action から入れる手段を使う。R11-6 の結果が出るまで、スキルを通した確かめは main へのマージの後になる |
| #387（hooks の棚卸し） | 人のいない実行を止める hook があるかは、#387 の後の hooks で確かめる |
| #315（spec 023） | 段階 9 で成果物を直す。実装は #315 の側で行う |

## Complexity Tracking

| 足すもの | 要る理由 | より単純な案を採らない理由 |
|---|---|---|
| `pecot pr review-finish` | 止まったことを PR に残すことは、エージェントがターンの上限で切られても起きなければならない | スキルの文だけで書くと、切られたときに何も残らない。雛形に `gh` の行を直接書くと、置いた後にコメントの形を直せない |
| `pecot workflow install`・`doctor` | 設定がそろっているかを確かめる手段（FR-030）と、置いた雛形が古いことを知る手段（FR-031）が要る。後に続く自動処理が、同じものを使う（FR-019） | board sync と同じく写して置くだけの形は、確かめる手段を持たない。自動レビュー専用のコマンドにすると、spec 023 が同じものをもう一度作る |
| 自前の GitHub App の道 | 権限を絞りたい利用者のための任意の道。既定は Claude の App で、利用者は App を作らない（Clarifications の 2026-11-17） | 自前の App を必須にする形は、導入が重い。research の R3 に書いた |

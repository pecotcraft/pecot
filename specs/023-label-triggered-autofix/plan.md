# Implementation Plan: Issue にラベルを付けると、GitHub Actions が pecot の手順で直して PR まで作る

**Branch**: `023-label-triggered-autofix` | **Date**: 2026-11-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/023-label-triggered-autofix/spec.md`

## Summary

pecot-workflow に、無人で Issue から PR まで進める仕組みを足す。
利用者のリポに置くワークフローの雛形が、起動ラベルを契機に claude-code-action を動かす。
action は pecot-workflow のプラグインを入れ、新しいスキル `w-auto` を起動する。
スキルは、ブランチの作成・計画の投稿・修正・テスト・PR の作成を、人を待たずに進める。
PR の CI が落ちると、`workflow_run` で別の run が起き、上限の回数まで直す。
「必ず起きること」は CLI に寄せる。新しい `pecot auto` の 5 つのコマンドが、判定・結果のコメント・待ちの値・起動ラベルを扱う。
ボードの進行の欄は、今の CLI のとおりに動く。着手で Active、PR の作成で In Review になる。
人の対応を待って止まった Issue は、既定の Status に足す待ちの値（`Waiting`）で示す。
GitHub のトークンは、利用者が作る GitHub App の 1 本を使う。ボードの更新と、PR の CI の自動起動を満たす。
導入は、w-onboarding の流れから `pecot auto install` と `pecot auto doctor` で進める。

## Technical Context

| 項目 | 内容 |
|---|---|
| Language/Version | Python 3.10 以上（pecot-workflow の CLI）、GitHub Actions の YAML（雛形）、Markdown（スキル） |
| Primary Dependencies | typer・httpx・gql（既存）。雛形が使う action は、claude-code-action v1、`actions/checkout`、`astral-sh/setup-uv`、`actions/create-github-app-token` |
| Storage | 利用者のリポのファイル（`.github/workflows/pecot-auto.yml`、`.pecot/config/projects/*.json`）と、GitHub の Issue のコメント・ラベル・ボード |
| Testing | pytest（CLI と雛形）、スキルの文書のテスト（`scripts/ci/tests/`）、vitest（`cli-node/` の parity）、このリポでの CUJ |
| Target Platform | GitHub Actions の ubuntu の runner（自動処理）と、利用者の端末（導入） |
| Project Type | 配布するプラグイン（CLI・スキル・テンプレート） |
| Performance Goals | `gate` の job は、エージェントを起こさずに 1 分以内に終わる。1 ファイルの修正は、1 回の run の上限（30 分・80 ターン）に収まる |

**Constraints**:

- w-quick・w-active・w-pr の文と、既存のコマンドの振る舞い・終了コードを変えない
- 検証を迂回しない。`--no-verify` と、テンプレートの検証を外すオプションを使わない
- エージェントは既定の Status に触れない。書くのは `pecot auto start` と `pecot auto finish` だけだ
- 雛形は、このリポ固有の名前を持たない。CI のワークフローの名前・設定ファイルの名前・App の変数の名前は、導入のときに決まる
- プラグインの版は固定できない。雛形と CLI の版のずれは、版の目印で知らせる
- ルート直下にディレクトリを足さない

**Scale/Scope**:

- CLI のコマンド 5 つ（定義書の項目 5 つと、parity のシナリオ 10 件以上）
- スキル 1 本、コメントのテンプレート 1 つ、ワークフローの雛形 1 つ
- `project init` の拡張（既定の Status に値を 1 つ足す）と、設定ファイルのキー 1 つ
- 文書の修正 4 か所（`board-status.md`・`spec-driven-workflow.md`・`auth-config.md`・`w-onboarding/SKILL.md`）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 合格 | 判定と状態の決め（種類・結果・待ちの値を書くか）は `cli/core/auto/` に置く。GitHub の呼び出しは既存の `core/github/` を通す。`commands/auto.py` は引数と出力だけを持つ。層の依存は既存の lint の設定で確かめる |
| II. TDD | 合格 | `gate` の判定・結果のコメントの数え方・選択肢の追加（`id` を保つこと）は、失敗する入力のテストを先に書く。期待は、出力の行と API に渡す値で比べる。モックは HTTP の境界だけにする。単体テストの後に、このリポで実際の Issue を使って確かめる |
| III. コード品質 | 合格 | 新しいコードは ruff と strict の型チェックの対象に入る。雛形の YAML は、構文と必須のキーをテストで確かめる。定義書・parity・スキルの文書のテストを、既存のレーンで通す |
| IV. YAGNI | 条件つき合格 | コマンドを 5 つ足す。理由は Complexity Tracking に書く。user 所有のボード、GitHub Copilot CLI での無人の実行、レビュー指摘への対応、ラベル以外の契機は作らない |
| V. 本体優先 | 合格 | speckit 成果物は新規の一式だけを作る。既存の spec には手を入れない |

Phase 1 の設計の後も、同じ判定になる。

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
│   ├── commands/
│   │   ├── auto.py                  # 新規。install・doctor・gate・start・finish
│   │   ├── main.py                  # auto の登録
│   │   └── project.py               # init が既定の Status に待ちの値を足す。設定に status を書く
│   ├── core/
│   │   ├── auto/                    # 新規。判定・結果・雛形の版
│   │   ├── github/projects.py       # 既定の Status の読み書き、選択肢の追加、既定の自動化の読み取り
│   │   ├── github/queries.py        # updateProjectV2Field ほか
│   │   ├── config.py                # fields.status
│   │   ├── frontmatter.py           # コメントのテンプレートの種類に auto-result を足す
│   │   └── sections.py              # auto-result の章の規則
│   ├── templates/
│   │   ├── comment/auto-result.md   # 新規。結果のコメント
│   │   └── workflow/pecot-auto.yml  # 新規。ワークフローの雛形
│   └── tests/                       # 各コマンドと雛形のテスト
├── cli-node/tests/parity/           # コマンドのパスと数、シナリオと golden
├── interface/
│   ├── generated.json               # 書き出し直す
│   └── authored.yaml                # 5 つの項目と振る舞いの項目
├── skills/
│   ├── w-auto/SKILL.md              # 新規
│   ├── w-onboarding/SKILL.md        # 導入の手順を足す。board_url のスクリプトを直す
│   └── w-help/
│       ├── SKILL.md                 # スキルの表
│       └── references/              # skills.md・commands.md・board-status.md・spec-driven-workflow.md・auth-config.md
├── scripts/ci/tests/test_skill_flow_structure.py  # w-auto の Step の順
└── README.md                        # スキルの表

.github/workflows/pecot-auto.yml     # このリポへの導入。雛形から書き出したもの
.nx/version-plans/                   # PR ごとの version plan
```

**Structure Decision**: 新しいコードは pecot-workflow の中だけに置く。判定は `cli/core/auto/` に、雛形は `cli/templates/workflow/` に置く。雛形は配布物なので、`.github/workflows/` には書き出した結果だけを置く。

## 実装の段階と PR

| 段階 | 中身 | 対応 |
|---|---|---|
| 1 | 既定の Status の読み書きと、待ちの値の追加。`project init` の拡張と設定の `fields.status`。ボードの説明の修正 | FR-042〜FR-044 |
| 2 | `pecot auto gate`・`start`・`finish` と、結果のコメントのテンプレート | FR-008・FR-011〜FR-013・FR-038〜FR-041 |
| 3 | スキル `w-auto` の、始める・続ける の手順 | US1・US3・FR-002〜FR-007・FR-010・FR-014 |
| 4 | ワークフローの雛形と `pecot auto install`。このリポへの導入 | US2・FR-015〜FR-017・FR-022〜FR-029 |
| 5 | CI を直す手順。雛形の `workflow_run` の job と、スキルの CI を直す種類 | FR-035〜FR-037 |
| 6 | `pecot auto doctor` と、w-onboarding・認証の説明への導入の手順 | US5・FR-019・FR-030〜FR-034 |
| 7 | このリポで CUJ を通し、ターン・時間・回数の既定値を直す | SC-001〜SC-011 |

段階 4 までで、ラベルから PR までが通る。段階 5 は、その上に CI の修正を足す。

## Complexity Tracking

| 足すもの | 要る理由 | より単純な案を採らない理由 |
|---|---|---|
| `pecot auto` の 5 つのコマンド | 結果のコメントと起動ラベルを外すことは、エージェントがターンの上限で切られても起きなければならない。対象外と上限の判定は、毎回同じ結果でなければならない | スキルの文だけで書くと、上限で切られたときに何も残らない。判定も実行ごとに揺れる |
| ワークフローの 2 つの job と 2 つの契機 | installation token が 1 時間で切れる。CI を同じ job で待てない | 1 つの job で待つ形は、CI の時間と直す回数の積が期限に当たる |
| 既定の Status への書き込み | 画面で比べた結果、止まった Issue に気づけるのは、札の色が変わる形だけだった | ラベルの札は目に入らず、進行の欄に値を足すと列と既存のボードの移行に広がる |

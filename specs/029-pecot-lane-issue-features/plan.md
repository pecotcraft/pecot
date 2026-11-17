# Implementation Plan: pecot のフィールドを pecot-status・pecot-lane に整理し、Issue に付くすべての機能を MCP から使える

**Branch**: `feat/breakdown-board-area-lanes/592` | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/029-pecot-lane-issue-features/spec.md`

## Summary

互いに独立した 2 つの変更を、pecot-workflow の CLI（MCP サーバ）とスキルに入れる。

**A. pecot のフィールドの整理**

- 進行の欄 `pecot-workflow-<suffix>` を `pecot-status` に改名し、`suffix` の入力を無くす
- `pecot-priority`・`pecot-size` を廃止し、利用者が値を決める `pecot-lane` を足す
- 準備の操作が、列を `pecot-status`、横のレーンを `pecot-lane` にしたボードのビュー `Lanes` を作る
- 起票は `pecot-lane` を入れる。同期は、値の無い Issue を知らせる。`board_show` と w-active は、値ごとの件数を出す
- 既存のボードは、`project_sync` が改名と設定の移行をする。廃止したフィールドは、確認を受けてから消す

**B. Issue の機能を使える担保**

- 定義を書くたびにボードと持ち主から読み、Issue の機能を名前で指定・表示・更新できるようにする（`issue_attributes`・`issue_create` の `attributes`・`issue_edit`・`issue_show` の `attributes`）
- GitHub の公開スキーマから Issue の機能の部分の写しを取り、担保の一覧と照らすテストを PR の CI で動かす
- GitHub 側の増減は、Lambda の Scheduler から dispatch する workflow が見つけて、Issue にする
- GitHub Projects と Issue の機能の棚卸しの一覧を書く

調べた結果と判断の理由は [research.md](research.md) にある。

## Technical Context

**Language/Version**: TypeScript（Node.js。`plugins/pecot-workflow/cli` の今の版）、GitHub Actions の YAML、Node.js 24 の ES module（`.github/board-sync/handler.mjs`）

**Primary Dependencies**: 今の CLI の依存のまま（zod・MCP の TypeScript SDK・GitHub の REST と GraphQL のクライアント）。写しを作るための GraphQL の SDL の読み取りには、既に依存にある `graphql`（`parse`）を使う。新しい依存は足さない

**Storage**: 設定ファイル（`.pecot/config/projects/*.json`）の形を変える。写し（`interface/github-issue-surface.json`）と担保の一覧（`interface/issue-coverage.yaml`）を、リポに足す

**Testing**: vitest（`pecot-workflow:test-cli`。定義書の振る舞いの ID につなぐ今の形）、`*.test.sh` は変えない。workflow の形は `.githooks/tests` の pytest、Lambda は今のテストの形

**Target Platform**: 利用者の Claude Code・GitHub Copilot CLI で動く MCP サーバ。GitHub.com（GHES では、ビューの API と Issue fields が無いときに手順を出す）

**Project Type**: 配布する CLI・MCP サーバとスキル（`plugins/pecot-workflow`）。リポの運用の仕組み（workflow と Lambda）

**Performance Goals**: 起票と更新で、定義を読むための要求は 1 回の GraphQL と、Issue fields の REST の 1 回に収める。`board_show` の要求の数は今と同じ

**Constraints**:

- 単一選択の選択肢の更新は全部の置き換えなので、必ず既存の ID を付けて送る
- ボードのフィールドは 1 つのボードで 50 まで
- `blocked_by` は Issue の作成と同じ要求で書けない
- PR の CI は GitHub に取りに行かない

**Scale/Scope**:

- 変える MCP ツールは 7 つ（`project_create`・`project_init`・`project_sync`・`issue_create`・`issue_show`・`board_show`・`board_sync`）
- 足す MCP ツールは 2 つ（`issue_attributes`・`issue_edit`）
- 変えるスキルは 6 つ（w-onboarding・w-quick・w-ready・w-issueize・w-backlog・w-active）と w-help の参照

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判断 | 理由 |
|---|---|---|
| I. DDD | 合格 | 定義と値の照らし合わせ（AttributeDefinition・AttributeValue の検証）、移行の判定、レーンの集計は domain の純粋な関数に置く。GitHub の読み書きは infra に置き、コマンドはそれをつなぐだけにする |
| II. TDD | 合格 | 振る舞いの ID ごとに vitest を先に書く。GitHub の応答は、実物の形（公開スキーマに合う JSON）を入力にする。モックは API の境界だけ。担保の網羅は、写しと一覧のテストで機械的に止める。テストの通過とは別に、quickstart を検証用のボードで動かす |
| III. 品質ゲート | 合格 | 今の lint（eslint・tsc・SKILL.md の lint・定義書の検証）にかける。新しいスクリプトは TypeScript で書き、同じ lint にかける |
| IV. YAGNI | 合格 | `pecot-lane` の値の自動判定は CLI に置かず、スキルの判断にする。ビューは 1 つだけ作る。定義のキャッシュは作らない（書くたびに読む）。Issue fields の定義そのものの作成・変更は、担保の範囲（Issue の機能の値）の外として一覧に `excluded` で残す |
| V. 本体優先 | 合格 | speckit の成果物はこの一式の作成と、調べで分かった spec の 2 つの誤り（Issue fields の状態・組み込みの Status の使い方）の整合の修正だけ |
| VI. 標準準拠 | 合格 | 改名・作成・削除は GraphQL の公式の mutation、ビューは REST の公式の作成の API、Issue fields は GA の API を使う。MCP のツールは `inputSchema`・`outputSchema` を持つ。GitHub に置き場所のある情報（担当者・マイルストーン・Issue type）を pecot の設定に独自に持たない。不適合として残すものは無い |

Phase 1 の後の再確認: 合格。

- 設計で足した独自の項目は、MCP の入力の `attributes` だけ。GitHub の機能の名前と値をそのまま運ぶ入れ物で、GitHub に同じ役割の項目は無い
- `confirm_delete` は、MCP に確認の標準（elicitation）があるが、対応しないクライアントがあるため入力で受ける。elicitation は任意の機能なので、使わないことは不適合ではない

## Project Structure

### Documentation (this feature)

```text
specs/029-pecot-lane-issue-features/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── mcp-tools.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
plugins/pecot-workflow/
├── cli/src/
│   ├── domain/
│   │   ├── config.ts               # 変更: workflow_suffix・priority・size を消し、fields.lane を足す。旧い形を読む
│   │   ├── migration.ts            # 新規: 旧い形のボードと設定から、移行の予定を決める
│   │   ├── lanes.ts                # 新規: LaneSummary の集計
│   │   ├── attributes.ts           # 新規: 定義と値の照らし合わせ、ATTRIBUTE_HANDLERS
│   │   ├── frontmatter.ts          # 変更: priority・size を読み捨て、lane・attributes を受ける
│   │   ├── security-tracker.ts     # 変更: Priority の列を Severity に
│   │   └── dependabot-pull-requests.ts  # 変更: PRIORITY を消す
│   ├── infra/github/
│   │   ├── queries.ts              # 変更: 全種類の fieldValues、Issue fields、フィールドの改名・削除・作成
│   │   ├── projects.ts             # 変更: フィールドの改名・削除、ビューの作成（REST）
│   │   ├── issues.ts               # 変更: 作成と更新で type・assignees・milestone・issue_field_values
│   │   └── attributes.ts           # 新規: 定義を読む（ボードのフィールド・Issue fields・type・ラベル・マイルストーン）
│   └── commands/
│       ├── project.ts              # 変更: suffix を消し、lanes とビュー
│       ├── project-sync.ts         # 変更: 移行・lanes・confirm_delete
│       ├── issue-create.ts         # 変更: priority・size を消し、lane・attributes
│       ├── issue-edit.ts           # 新規
│       ├── issue-attributes.ts     # 新規
│       ├── issue-show.ts           # 変更: attributes
│       ├── board-show.ts・board-view.ts  # 変更: lane・lanes
│       ├── board-sync.ts           # 変更: missing_lane
│       ├── issue-board.ts          # 変更: putOnBoard の priority を消す
│       └── tracker-sync-*.ts       # 変更: priority を消す
├── cli/templates/issue/*.md        # 変更: priority・size を消し、lane を足す
├── cli/tests/                      # 変更・新規: 上の振る舞いのテスト、担保のテスト
├── interface/
│   ├── authored.yaml               # 変更: 振る舞いの定義
│   ├── generated.json              # 変更: export-interface で作り直す
│   ├── github-issue-surface.json   # 新規: GitHub の Issue の機能の写し
│   └── issue-coverage.yaml         # 新規: 担保の一覧
├── cli/scripts/github-surface/
│   ├── extract.ts                  # 新規: SDL と OpenAPI から写しの項目を抜く
│   └── drift.ts                    # 新規: 今の項目と写しを比べ、差の Issue を作る（--dry-run・--sdl）
├── hooks/lib/core/mcp-guidance.sh  # 変更: priority・size の文を消す
├── skills/
│   ├── w-onboarding/SKILL.md       # 変更: suffix を消し、lanes の決め方とビュー
│   ├── w-quick・w-ready・w-issueize・w-backlog/SKILL.md  # 変更: lane を決めて渡す。priority・size を消す
│   ├── w-active/SKILL.md           # 変更: 候補を領域ごとに出す
│   └── w-help/references/*.md      # 変更: 移行の手順、attributes の使い方
├── docs/github-features.md         # 新規: 棚卸しの一覧
└── CONTRIBUTING.md                 # 変更: 写しの作り直しの手順、棚卸しの一覧へのリンク

.github/
├── workflows/issue-surface-drift.yml   # 新規: 定期の確かめ（workflow_dispatch だけ）
└── board-sync/handler.mjs              # 変更: dispatch の先に issue-surface-drift.yml を足す

.githooks/tests/test_issue_surface_workflow.py  # 新規: workflow の形
```

**Structure Decision**: 変更は pecot-workflow の中に置く。ルートに新しいディレクトリは作らない。

- 写しのスクリプトは、1 つのプラグインだけが使う TypeScript なので、`export-interface.ts` と同じ `plugins/pecot-workflow/cli/scripts/` に置く（`.claude/rules/repo-root-layout.md`）
- 定期の起動は、既存の `pecot-board-sync` の Lambda の dispatch の先に足す

## 段階

A と B は互いを待たない。各段は、前の段が無いと確かめられないものを後ろに置く。

**A. pecot のフィールドの整理**

1. **`pecot-status` への改名と `suffix` の廃止**（US4b）: 設定の新しい形と旧い形の読み込み、`project_sync` の改名と設定の移行、各操作の警告。検証用のボードで確かめられる
2. **`pecot-priority`・`pecot-size` の廃止**（US4）: 作成・起票・トラッカー・テンプレート・スキルから消し、`project_sync` の `confirm_delete`。1 の移行の出力に削除を足すので、1 に積む
3. **`pecot-lane` とビュー**（US1）: `lanes` の入力、フィールドの作成と選択肢の追加、REST のビューの作成。1 の `pecot-status` の ID をビューに使うので、1 に積む
4. **起票・同期・一覧**（US2・US3）: `issue_create` の `lane`、親の値の引き継ぎ、`missing_lane`、`lanes`、スキルの変更。3 に積む
5. **このリポへの導入**: リリースされた pecot-workflow で、このリポのボードを移行する。1〜4 のマージとリリースを待つ

**B. Issue の機能を使える担保**

1. **定義を読み、表示する**（US5 の 3・5）: `issue_attributes`、`issue_show` の `attributes`
2. **名前で書く**（US5 の 1・2・4・6・7）: `issue_create` の `attributes`、`issue_edit`、検証。6 の定義の読み込みを使うので、6 に積む
3. **担保の一覧と PR の CI**（US5 の 9）: 写し、担保の一覧、`ATTRIBUTE_HANDLERS` との照らし合わせのテスト。7 の handler を照らすので、7 に積む
4. **定期の確かめ**（US5 の 8・9）: `drift.ts`・`issue-surface-drift.yml`・Lambda の dispatch の先。workflow_dispatch は既定のブランチの定義で動き、Lambda の配備も要るので、8 のマージを待つ
5. **棚卸し**（US6）: 一覧を書き、不適合を起票し、「使う」としたものを準備か案内に入れる。6〜8 で何を扱えるかが決まった後に書く

## Complexity Tracking

憲章の違反は無い。

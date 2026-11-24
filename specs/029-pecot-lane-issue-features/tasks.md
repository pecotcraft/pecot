---

description: "Task list for 029-pecot-lane-issue-features"
---

# Tasks: pecot のフィールドを pecot-status・pecot-lane に整理し、Issue に付くすべての機能を MCP から使える

**Input**: Design documents from `/specs/029-pecot-lane-issue-features/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-tools.md, quickstart.md

**Tests**: 憲章の III（テストファースト）により、各フェーズでテストを先に書く。振る舞いは `plugins/pecot-workflow/interface/authored.yaml` に定義し、`cli/tests/interface/*.test.ts` から振る舞いの ID につなぐ。テストの通過とは別に、quickstart.md の手順を検証用のボードで動かす。

**Organization**: フェーズ 1 つが PR 1 つに当たる。Phase 1〜4 と 10 が A（pecot のフィールドの整理）、Phase 5〜9 が B（Issue の機能を使える担保）。A と B は互いを待たない。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1〜US6、US4b)
- Include exact file paths in descriptions

## Path Conventions

- `PW` は `plugins/pecot-workflow`
- CLI の本体: `PW/cli/src/{domain,infra/github,commands}/`。その単体テストは同じ階層の `tests/`
- 振る舞いのテスト: `PW/cli/tests/interface/`。定義書: `PW/interface/authored.yaml`。`PW/interface/generated.json` は `PW/cli/scripts/export-interface.ts` で作り直す
- 確かめは CONTRIBUTING の「3. 試験環境」の検証用のリポとボードで行う。このリポのボードには Phase 10 まで書き込まない

---

## Phase 1: User Story 4b - 進行の欄を `pecot-status` に改名し、`suffix` を無くす (Priority: P1)

**Goal**: 新しいボードは `pecot-status` で作られ、既存のボードは `project_init` で改名・設定の移行がされる。`suffix` の入力が無くなる（FR-029〜FR-031、research R1・R2）

**Independent Test**: quickstart.md の A-1 の 1・2 と A-4 の 2

### Tests for User Story 4b

- [x] T001 [P] [US4b] `PW/cli/src/domain/tests/config.test.ts` に、設定の新しい形と旧い形の読み込みのテストを先に書く。
  確かめること: `workflow_suffix` の無い設定を読める、旧い設定の `workflow_suffix` は読み捨てる、`workflowFieldName()` が常に `pecot-status` を返す、設定ファイルの名前が `${host}_${owner}_${number}.json` になり、ボードの名前を変えても同じ
- [x] T002 [P] [US4b] `PW/cli/src/domain/tests/migration.test.ts` に、移行の予定を決める関数のテストを先に書く。
  入力はボードのフィールドの一覧と設定ファイルの名前。確かめること: `pecot-workflow-<s>` だけなら改名の予定、`pecot-status` だけなら何もしない、両方あれば `pecot-status` を使い旧いほうを消す予定（data-model.md の「移行の状態」）、旧いファイル名なら移す先を返す
- [x] T003 [P] [US4b] `PW/interface/authored.yaml` の `PW-PROJECT-*` と `PW-BOARD-*` に、改名・`suffix` の廃止・旧い形の警告の振る舞いを足し、`PW/cli/tests/interface/project.test.ts` に先にテストを書く。
  確かめること:
  - `project_create`・`project_init` は `suffix` を渡すと無い入力として止まる。`pecot-status` で作る
  - `project_init` は `updateProjectV2Field` に `name` だけを渡し、`singleSelectOptions` を渡さない
  - 出力の `migration.renamed`・`config_moved`
  - 旧い形のボードで、`board_show` が今と同じ結果と警告 1 行（contracts の文言）を返す

### Implementation for User Story 4b

- [x] T004 [US4b] `PW/cli/src/domain/config.ts` から `workflow_suffix` を消し（読み込みでは `strip`）、`workflowFieldName()` を `pecot-status` 固定にする。設定ファイルの名前の関数も直す（T001 の後）
- [x] T005 [US4b] `PW/cli/src/domain/migration.ts` を作り、移行の予定を決める純粋な関数を置く（T002 の後）
- [x] T006 [US4b] `PW/cli/src/infra/github/queries.ts`・`PW/cli/src/infra/github/projects.ts` に、`updateProjectV2Field`（名前だけ）を足す。`deleteProjectV2Field` は、使う T017 で足す
- [x] T007 [US4b] `PW/cli/src/commands/project.ts` の `project_create`・`project_init` から `suffix` を消し、`initializeFields` で `pecot-status` を作る
- [x] T008 [US4b] `PW/cli/src/commands/project-sync.ts` で、`WORKFLOW_FIELD_PREFIX` による探し方を、`pecot-status` を先に、無ければ `pecot-workflow-*` を探す形に直す。
  移行の予定（T005）に従って改名し、旧い設定ファイルを新しい名前に移し、使用中のプロジェクトの指定も書き換える。`board_url` の `filterQuery` の欄の名前も `pecot-status` にする。出力に `migration` を足す
- [x] T009 [US4b] `board_show`・`board_sync` が旧い形を見つけたら、contracts/mcp-tools.md の警告を 1 行出す処理を、`PW/cli/src/commands/board-view.ts` のボードの読み込みの箇所に足す
- [x] T010 [US4b] `suffix` に触れる文書を直す: `PW/skills/w-onboarding/SKILL.md`（`suffix` の入力と「ラベル識別子」の誤りを消す）、`PW/skills/w-help/references/troubleshooting.md`、`PW/cli/src/domain/readiness.ts` の注記
- [x] T011 [US4b] `PW/interface/generated.json` を作り直し、`pecot-workflow:test-cli` の T001〜T003 のテストのファイルを動かす
- [x] T012 [US4b] quickstart.md の A-1 の 1・2 と A-4 の 2 を、検証用のボードで動かす

**Checkpoint**: 検証用のボードの進行の欄が `pecot-status` になり、値が残り、各操作が今と同じに動く

---

## Phase 2: User Story 4 - `pecot-priority`・`pecot-size` を廃止する (Priority: P1)

**Goal**: pecot は 2 つのフィールドを作らず、求めず、入れない。既存のボードからは、確認を受けた `project_init` だけが消す（FR-008〜FR-010、research R3）

**Independent Test**: quickstart.md の A-1 の 3 と A-4 の 1（Priority・Size ができないこと）

### Tests for User Story 4

- [ ] T013 [P] [US4] `PW/cli/src/domain/tests/frontmatter.test.ts` と `PW/cli/src/domain/tests/config.test.ts` に、`priority`・`size` を読み捨てるテストを先に書く
- [ ] T014 [P] [US4] `PW/cli/src/domain/tests/security-tracker.test.ts` に、本文の表の列が `Severity` で、GitHub の重大度をそのまま出すテストを先に書く
- [ ] T015 [P] [US4] `PW/interface/authored.yaml` の `PW-ISSUE-CREATE-11` と freeform の振る舞い（`priority`・`size`）を消し、廃止の振る舞いを足す。
  `PW/cli/tests/interface/issue-create.test.ts`・`issue-create-freeform.test.ts`・`project.test.ts`・`tracker-sync-security.test.ts`・`tracker-sync-dependabot.test.ts` に先にテストを書く。
  確かめること:
  - `issue_create` に `priority`・`size` を渡すと無い入力として止まる
  - 作ったボードに 2 つのフィールドが無い。トラッカーが `pecot-priority` を書かない
  - `project_init` は、`confirm_delete` なしでは `migration.pending_delete` に出すだけで消さない
  - `confirm_delete: true` で `deleteProjectV2Field` を呼び、`migration.deleted` に出す

### Implementation for User Story 4

- [ ] T016 [US4] `PW/cli/src/domain/config.ts` から `PRIORITIES`・`SIZES`・`fields.priority`・`fields.size` と `fieldOf` の該当の分岐を消す
- [ ] T017 [US4] `PW/cli/src/commands/project.ts` と `PW/cli/src/commands/project-sync.ts` から、2 つのフィールドの作成・選択肢の定め（`PRIORITY_FIELD_OPTIONS`・`SIZE_FIELD_OPTIONS`）・設定への読み込みを消す。
  `project_init` に `confirm_delete` を足し、移行の予定に削除を足す。`PW/cli/src/infra/github/queries.ts`・`projects.ts` に `deleteProjectV2Field` を足す
- [ ] T018 [US4] `PW/cli/src/commands/issue-create.ts`（入力・freeform の既定値・ファイルからの読み込み）と `PW/cli/src/domain/frontmatter.ts` から `priority`・`size` を消す
- [ ] T019 [P] [US4] `PW/cli/templates/issue/{task,bug,epic,tracker,task-implement}.md` の frontmatter から `priority`・`size` を消す
- [ ] T020 [US4] トラッカーから priority を消す。
  対象: `PW/cli/src/commands/issue-board.ts` の `putOnBoard`、`PW/cli/src/commands/tracker-sync-security.ts`、`PW/cli/src/domain/security-tracker.ts`（列を `Severity` に）、
  `PW/cli/src/commands/tracker-sync-dependabot.ts`・`PW/cli/src/domain/dependabot-pull-requests.ts` の `PRIORITY`
- [ ] T021 [P] [US4] `PW/skills/w-quick/SKILL.md` の「priority=medium, size=s」と、`PW/hooks/lib/core/mcp-guidance.sh` の該当の文を消す。
  ほかのスキルと `PW/skills/w-help/references/` に `priority`・`size` の記述が残っていないか探して消す。w-help に、`confirm_delete` で移行する手順を書く
- [ ] T022 [US4] `PW/interface/generated.json` を作り直し、T013〜T015 のテストのファイルを動かす
- [ ] T023 [US4] quickstart.md の A-1 の 3 を、検証用のボードで動かす

**Checkpoint**: 新しいボード・起票・トラッカーに Priority・Size が出ず、既存のボードは確認の後にだけ消える

---

## Phase 3: User Story 1 - `pecot-lane` とレーンのビュー (Priority: P1)

**Goal**: `lanes` を受けて `pecot-lane` を作り、選択肢を足し、`Lanes` のビューを作る（FR-001〜FR-003、research R4・R5）

**Independent Test**: quickstart.md の A-2 と A-4 の 1

### Tests for User Story 1

- [ ] T024 [P] [US1] `PW/cli/src/domain/tests/lane-options.test.ts` に、選択肢の追加の計算のテストを先に書く。
  確かめること: 既存の選択肢を ID ごと残し、足りない値だけを足した全体を返す、既存の値は消さない、大文字と小文字を区別する
- [ ] T025 [P] [US1] `PW/interface/authored.yaml` に `pecot-lane` とビューの振る舞いを足し、`PW/cli/tests/interface/project.test.ts` に先にテストを書く。
  確かめること:
  - `lanes` を受けると `createProjectV2Field`（`SINGLE_SELECT`）で作る
  - 既にあれば、`updateProjectV2Field` に既存の ID 付きの全体を送る
  - `lanes` が無くフィールドも無ければ作らず、値を決める案内を出す
  - ビューは REST の `POST .../views` に `layout: "board"`・`vertical_group_by: [pecot-status の ID]`・`group_by: [pecot-lane の ID]`・`name: "Lanes"` を送る
  - 同じ名前のビューがあれば作らない
  - 403・404 では `view.manual_steps` を返し、ほかの準備は続ける
  - 設定に `pecot-lane` の選択肢を写さない（research R4）

### Implementation for User Story 1

- [ ] T026 [US1] `PW/cli/src/domain/lane-options.ts` を作る（T024 の後）。
  名前から選択肢を引く関数もここに置き、B の single select の照らし合わせ（T052）と共有する。
  T052 が先にマージされていれば、そちらの関数を使い、同じ関数を 2 つ作らない（憲章の VIII）
- [ ] T027 [US1] `PW/cli/src/infra/github/queries.ts`・`PW/cli/src/infra/github/projects.ts` に、`createProjectV2Field`、選択肢つきの `updateProjectV2Field`、ビューの一覧の読み込み、REST のビューの作成（組織と個人の両方のパス）を足す
- [ ] T028 [US1] `PW/cli/src/commands/project.ts`・`PW/cli/src/commands/project-sync.ts` に `lanes` の入力、フィールドの作成と選択肢の追加、ビューの作成、出力の `view` を足す
- [ ] T029 [US1] `PW/skills/w-onboarding/SKILL.md` に、`lanes` の値の決め方（プラグイン・チーム・サービスなど。GitHub の画面に出るので英語の名前）と、`Lanes` のビューの開き方を書く。
  同じ案内を `PW/skills/w-help/references/` にも書く（FR-012）
- [ ] T030 [US1] `PW/interface/generated.json` を作り直し、T024・T025 のテストのファイルを動かす
- [ ] T031 [US1] quickstart.md の A-2 と A-4 の 1 を、検証用のボードで動かす

**Checkpoint**: 検証用のボードに `pecot-lane` と `Lanes` のビューがあり、レーンで分かれて見える

---

## Phase 4: User Story 2 + 3 - 起票・同期・一覧で `pecot-lane` を扱う (Priority: P1・P2)

**Goal**: 起票で `pecot-lane` が入り、親の値を引き継ぎ、値の無い Issue を同期で知らせ、`board_show` と w-active が領域ごとの件数を出す（FR-004〜FR-007、research R6）

**Independent Test**: quickstart.md の A-3

### Tests for User Story 2 + 3

- [ ] T032 [P] [US3] `PW/cli/src/domain/tests/lanes.test.ts` に、LaneSummary の集計のテストを先に書く。
  確かめること: 値ごとの `count`・`startable`、選択肢にあって Item が 0 件の値も 0 件で並ぶ、値の無い組は `name: null`、`pecot-lane` の無いボードは空の配列
- [ ] T033 [P] [US2] `PW/interface/authored.yaml` に起票と同期の振る舞いを足し、`PW/cli/tests/interface/issue-create.test.ts` と `PW/cli/tests/interface/board.test.ts` に先にテストを書く。
  確かめること: `lane` が入る、無い値は Issue を作る前に止まり取りうる値を出す、`parent_epic` があり `lane` が無ければ親の値、`board_sync` の `missing_lane` と警告 1 行と終了コードが変わらないこと、`pecot-lane` の無いボードで今と同じ結果
- [ ] T034 [P] [US3] `PW/cli/tests/interface/board.test.ts` に、`board_show` の `items[].lane` と `lanes` のテストを先に書く

### Implementation for User Story 2 + 3

- [ ] T035 [US3] `PW/cli/src/domain/lanes.ts` を作る（T032 の後）
- [ ] T036 [US3] `PW/cli/src/infra/github/queries.ts` の `listProjectItemsQuery` で `pecot-lane` の値を読む。
  `PW/cli/src/domain/format.ts` の `transformItems` と `PW/cli/src/commands/board-view.ts` の `BOARD_ITEM_JSON`・`BOARD_SHOW_OUTPUT` に `lane`・`lanes` を足す
- [ ] T037 [US2] `PW/cli/src/commands/issue-create.ts` と `PW/cli/src/commands/issue-shared.ts` の `setIssueFields` に `lane` を足す。
  値は、そのときボードから読んだ `pecot-lane` の選択肢と、T026 の関数で照らす。
  親の値は `parent_epic` の Item から読む。`PW/cli/src/domain/frontmatter.ts` に `lane` を足す
- [ ] T038 [US2] `PW/cli/src/commands/board-sync.ts` に `missing_lane` を足し、警告を `PW/cli/src/commands/board-judgment.ts` の `out.warning` と同じ形で出す
- [ ] T039 [P] [US2] `PW/skills/w-quick/SKILL.md`・`PW/skills/w-ready/SKILL.md`・`PW/skills/w-issueize/SKILL.md`・`PW/skills/w-backlog/SKILL.md` に、
  起票の内容から `lane` を決めて渡し、決められなければ利用者に確かめる手順を書く。値の一覧は `board_show` の `lanes` から読む
- [ ] T040 [P] [US3] `PW/skills/w-active/SKILL.md` に、候補を `lanes` で領域ごとに出し、着手できるタスクの無い領域も示す手順を書く
- [ ] T041 [US2] `PW/interface/generated.json` を作り直し、T032〜T034 のテストのファイルと、変えたスキルの `PW/cli/tests/skills/` のテストを動かす
- [ ] T042 [US2] quickstart.md の A-3 を、検証用のボードで動かす

**Checkpoint**: 起票・同期・一覧の全部が `pecot-lane` を扱い、`pecot-lane` の無いボードでは今と同じに動く

---

## Phase 5: User Story 5 - Issue の機能の定義を読み、すべて表示する (Priority: P1)

**Goal**: `issue_attributes` で使える機能の定義を出し、`issue_show` が値の入っている機能をすべて出す（FR-012〜FR-017、research R7）

**Independent Test**: quickstart.md の B-1 の 1・2 と、B-1 の 3 の `issue_show` の部分（値は画面で入れておく）

### Tests for User Story 5（定義と表示）

- [x] T043 [P] [US5] `PW/cli/src/infra/github/tests/attributes.test.ts` に、定義の読み込みのテストを先に書く。
  入力は、公開スキーマに合う GraphQL の応答（Issue fields は `Repository.issueFields`）の実物の形。確かめること:
  - 6 種類のボードのフィールドが data-model.md の AttributeDefinition の `kind` になる
  - GitHub が計算するフィールドは `writable: false` になる
  - 知らない `dataType` は `kind: "unsupported"` と `unsupported_reason` になる
  - Issue fields・Issue type・ラベル・マイルストーンが出る
  - Issue fields の読み込みが 403・404 でも、ほかの定義は出る
- [x] T044 [P] [US5] `PW/interface/authored.yaml` に `PW-ISSUE-ATTRIBUTES-*` と `PW-ISSUE-SHOW` の `attributes` の振る舞いを足す。
  `PW/cli/tests/interface/issue-attributes.test.ts`（新規）と `PW/cli/tests/interface/issue-show.test.ts` に先にテストを書く。
  `issue_show` で扱えない種類の値に出会ったら、その名前と GitHub の種類を `unsupported` に出し、ほかの `attributes` は出すことも確かめる（FR-022）

### Implementation for User Story 5（定義と表示）

- [x] T045 [US5] `PW/cli/src/infra/github/attributes.ts` を作り、ボードのフィールド・Issue fields・Issue type・ラベル・マイルストーンの定義を読む。
  `PW/cli/src/infra/github/queries.ts` の `fieldValues` を全種類（text・number・date・single select・multi select・iteration）で読む形にする（T043 の後）
- [x] T046 [US5] `PW/cli/src/commands/issue-attributes.ts` を作り、MCP ツール `issue_attributes` として登録する（`inputSchema`・`outputSchema` 付き）
- [x] T047 [US5] `PW/cli/src/commands/issue-show.ts` に `attributes`（AttributeReading の配列）を足す。担当者・マイルストーン・ラベル・Issue type・Issue fields・ボードのフィールドを読む。扱えない種類の値は `unsupported` に出す（FR-022）
- [x] T048 [US5] `PW/interface/generated.json` を作り直し、T043・T044 のテストのファイルを動かす
- [x] T049 [US5] quickstart.md の B-1 の 1・2 を、検証用のボードで動かす

**Checkpoint**: pecot の知らないフィールドを含め、定義と値がすべて読める

---

## Phase 6: User Story 5 - Issue の機能を名前で書く (Priority: P1)

**Goal**: `issue_create` の `attributes` と `issue_edit` で、機能の値を書く・変える・外す。書く前にまとめて検証する（FR-013〜FR-015・FR-018〜FR-022、research R7）

**Independent Test**: quickstart.md の B-1 の 3〜7

### Tests for User Story 5（書く）

- [ ] T050 [P] [US5] `PW/cli/src/domain/tests/attributes.test.ts` に、検証のテストを先に書く。
  data-model.md の表のとおり、`unknown_attribute`（似た名前の候補つき）・`ambiguous_attribute`・`read_only_attribute`・`unsupported_attribute`・`invalid_value` を確かめる。
  値の決まり: 「number は数、date は `YYYY-MM-DD`、select は選択肢の名前、iteration は名前か開始日」。1 つでも合わなければ全部を返し、書く予定を作らないことも確かめる。
  `pecot-status` と組み込みの Status は `read_only_attribute` で止まり、`board_move` を使うよう出すことも確かめる（research R7）
- [ ] T051 [P] [US5] `PW/interface/authored.yaml` に `PW-ISSUE-EDIT-*` と `PW-ISSUE-CREATE` の `attributes` の振る舞いを足す。
  `PW/cli/tests/interface/issue-edit.test.ts`（新規）と `PW/cli/tests/interface/issue-create.test.ts` に先にテストを書く。
  確かめること:
  - REST の作成に `type`・`assignees`・`milestone`・`labels`・`issue_field_values` が入る
  - ボードのフィールドは `updateProjectV2ItemFieldValue` で種類ごとの値で書く
  - `value: null` で外す
  - Issue fields の書き込みが権限の不足（403）で失敗しても、ほかの機能の書き込みは続き、書けなかった機能と理由が出力に出る（FR-020）
  - `lane` と `attributes` の `pecot-lane` を両方渡すと、Issue を作らずに `ambiguous_attribute` で止まる
  - 検証に通らなければ何も書かない
  - `attributes` が無くても止まらない
  - `issue_edit` の出力の `changed` に前と後の値が出る

### Implementation for User Story 5（書く）

- [ ] T052 [US5] `PW/cli/src/domain/attributes.ts` を作り、検証と書く予定の組み立てと `ATTRIBUTE_HANDLERS`（`kind` から書き方への対応）を置く（T050 の後）。
  single select の名前から選択肢を引く関数は、A の T026 と共有する。T026 が先にマージされていれば、そちらの関数を使う
- [ ] T053 [US5] `PW/cli/src/infra/github/issues.ts` の作成と更新に `type`・`assignees`・`milestone`・`issue_field_values` を足す。
  `PW/cli/src/infra/github/projects.ts` に種類ごとの `updateProjectV2ItemFieldValue` と `clearProjectV2ItemFieldValue` を足す
- [ ] T054 [US5] `PW/cli/src/commands/issue-create.ts` に `attributes` を足す。frontmatter（`PW/cli/src/domain/frontmatter.ts`）でも同じ名前で受ける
- [ ] T055 [US5] `PW/cli/src/commands/issue-edit.ts` を作り、MCP ツール `issue_edit` として登録する
- [ ] T056 [P] [US5] `PW/skills/w-help/references/` に、`issue_attributes` で定義を見て、`attributes` で指定する使い方を書く。利用を強制しないこと（指定しなければ空のまま）も書く
- [ ] T057 [US5] `PW/interface/generated.json` を作り直し、T050・T051 のテストのファイルを動かす
- [ ] T058 [US5] quickstart.md の B-1 の 3〜7 を、検証用のボードで動かす

**Checkpoint**: pecot の知らない 6 種類のフィールドと担当者・マイルストーン・Issue type を、名前で書き、変え、外せる

---

## Phase 7: User Story 5 - 担保の一覧と PR の CI (Priority: P1)

**Goal**: GitHub の Issue の機能の写しと担保の一覧を置き、PR の CI で網羅を止める（FR-023・FR-024、research R8）

**Independent Test**: quickstart.md の B-2 の 1・2

### Tests for User Story 5（担保）

- [ ] T059 [P] [US5] `PW/cli/src/domain/tests/issue-surface.test.ts` に、抜き出しのテストを先に書く。
  入力は公開スキーマの SDL と REST の OpenAPI の小さな抜粋。確かめること: research R8 の範囲の項目だけが、data-model.md の `id` の形で、並べ替えて出る
- [ ] T060 [P] [US5] `PW/cli/tests/issue-coverage.test.ts` に、網羅のテストを先に書く。
  確かめること:
  - 写しの各 `id` が担保の一覧にある
  - `supported` の `handler` が `ATTRIBUTE_HANDLERS` にある
  - `excluded` には `reason` がある
  - 一覧にあって写しに無い `id` は落ちる
  - 落ちるときのメッセージに `id` が出る

### Implementation for User Story 5（担保）

- [ ] T061 [US5] 抜き出しを、憲章の I・VI に合わせて 3 つに分けて作る（T059 の後）。
  - `PW/cli/src/domain/issue-surface.ts`: SDL と OpenAPI の文字列から写しの項目を抜く。SDL は既存の依存の `graphql` の `parse` で読む
  - `PW/cli/src/infra/github/issue-surface.ts`: 公開スキーマと OpenAPI を取りに行く
  - `PW/cli/scripts/github-surface/extract.ts`: 引数を読んで上の 2 つを呼び、写しを書くだけにする。処理を書かない
- [ ] T062 [US5] `PW/interface/github-issue-surface.json` を、`extract.ts` で、この日の公開スキーマと OpenAPI（`X-GitHub-Api-Version: 2026-03-10`）から作る
- [ ] T063 [US5] `PW/interface/issue-coverage.yaml` を書く。写しの全項目を `supported` か `excluded` にする。
  `excluded` の理由の例: preview（Issue の `statusId`）、GitHub が計算する、担保の範囲（Issue の機能の値）の外（Issue fields の定義そのものの作成）
- [ ] T064 [US5] `PW/project.json` の `test-cli` の入力に、2 つのファイルを足す
- [ ] T065 [US5] `PW/CONTRIBUTING.md` に、写しを作り直す手順と、差が出たときの直し方を書く
- [ ] T066 [US5] T059・T060 のテストのファイルを動かし、quickstart.md の B-2 の 1・2 を行う

**Checkpoint**: 扱う範囲から 1 つを外すと、PR の CI が落ちる

---

## Phase 8: User Story 5 - 定期の確かめ (Priority: P1)

**Goal**: GitHub 側の Issue の機能の増減を、Lambda の Scheduler から dispatch する workflow が見つけて、Issue を 1 件作る（FR-023a、research R8）

**Independent Test**: quickstart.md の B-2 の 3・4

### Tests for User Story 5（定期）

- [ ] T067 [P] [US5] `PW/cli/src/domain/tests/issue-surface.test.ts` に、差と Issue の組み立てのテストを先に書く。
  確かめること: 増えた・消えた `id`、題「`GitHub の Issue の機能に差がある: <増えた数> 件増・<消えた数> 件減`」、本文の末尾の印 `<!-- pecot-issue-surface: <差の hash> -->`、同じ印の開いた Issue があれば作らない、`--sdl` で GitHub に取りに行かない、`--dry-run` で作らない
- [ ] T068 [P] [US5] `.githooks/tests/test_issue_surface_workflow.py` に、workflow の形のテストを先に書く。
  確かめること: 起動は `workflow_dispatch` だけ、権限は `contents: read` と `issues: write` だけ、concurrency で重ねて動かない

### Implementation for User Story 5（定期）

- [ ] T069 [US5] 差の確かめを、T061 と同じ分け方で作る（T067 の後）。
  - `PW/cli/src/domain/issue-surface.ts`: 差、題と本文と印の組み立て、同じ印の開いた Issue があれば作らない判断
  - infra: 開いた Issue の印の検索と、Issue の作成。作成は今の `PW/cli/src/infra/github/issues.ts` を使う
  - `PW/cli/scripts/github-surface/drift.ts`: `--sdl`・`--dry-run` を読んで呼ぶだけにする
- [ ] T070 [US5] `.github/workflows/issue-surface-drift.yml` を作る
- [ ] T071 [US5] `.github/board-sync/handler.mjs` の dispatch の先に `issue-surface-drift.yml` を足し、その単体テストを直す。
  配備（`deploy.sh` の `update-function-code`）は、このフェーズのマージの後に、利用者の `pecot` プロファイルで行う。IAM は変えない
- [ ] T072 [US5] T067・T068 のテストのファイルを動かし、quickstart.md の B-2 の 3・4 を手元で行う。
  マージと配備の後に、Scheduler を一時的に `at()` に書き換えて 1 回動かし、差が無ければ Issue ができないことを確かめてから戻す

**Checkpoint**: GitHub に機能が増えると、このリポに Issue が 1 件だけできる

---

## Phase 9: User Story 6 - GitHub Projects と Issue の機能の棚卸し (Priority: P3)

**Goal**: 機能ごとに、pecot の今の使い方・使うか使わないか・理由を残し、不適合を起票し、「使う」としたものを入れる（FR-026〜FR-028、research R9）

**Independent Test**: spec の US6 の Independent Test

- [ ] T073 [US6] `PW/docs/github-features.md` を作り、GitHub の公式の文書の Projects と Issues の目次から機能を拾って一覧にする（ビュー・レイアウト・Group by・Slice by・フィルタ・組み込みの自動化・Iteration・Insights・Issue fields・Issue type・sub-issue・依存 など）。
  各機能に、pecot の今の使い方・使うか使わないか・理由・関連する Issue を書く
- [ ] T074 [US6] 一覧で、GitHub の機能と同じ役割を pecot が独自に持っている仕組みを挙げ、pecot-workflow の MCP ツール `issue_create` で 1 件ずつ起票する（Epic #542 の下）。起票した番号を一覧に書く
- [ ] T075 [US6] 「使う」とした機能のうち、準備の操作に入るものは `PW/cli/src/commands/project.ts`・`project-sync.ts` の変更を、案内に入るものは `PW/skills/w-onboarding/SKILL.md` の変更を、それぞれ別の Issue として起票する。このフェーズでは実装しない
- [ ] T076 [US6] `PW/CONTRIBUTING.md` から一覧へリンクする

**Checkpoint**: 棚卸しの一覧に、公式の文書の機能がすべて載り、判断と理由がある

---

## Phase 10: このリポへの導入（FR-011・FR-012・FR-029〜FR-032）

**Purpose**: リリースされた pecot-workflow で、このリポのボードを移行し、`pecot-lane` を入れる

- [ ] T077 このリポで `project_init` を `lanes: ["pecot-workflow", "pecot-visual", "pecot-tools", "repo"]` で呼び、`pecot-workflow-pecotcraft` が `pecot-status` になり、`Lanes` のビューができたことを確かめる
  あわせて、設定ファイルの新しい名前に合わせて、`PW/CONTRIBUTING.md` の `project activate` の例と Actions の変数 `PECOT_REVIEW_PROJECT` を直す
  `PW/scripts/sandbox/sandbox-diff-items.json` の FR-005 の `pecot-workflow-*` を `pecot-status` にする
- [ ] T078 開いている Issue のすべてに `pecot-lane` を入れ、`board_sync` の `missing_lane` が空になることを確かめる
- [ ] T079 消すフィールド（`pecot-priority`・`pecot-size`）を利用者に示して確認を取り、`confirm_delete: true` で `project_init` を呼ぶ
- [ ] T080 `Lanes` のビューを開き、着手できるタスクの無い領域が分かることを確かめる（SC-001）

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | スタックできる | Phase 2 の `confirm_delete` は、Phase 1 の `project_init` の移行の予定と `migration` の出力に削除を足す |
| 3 | 1 | スタックできる | Phase 3 のビューの作成が、Phase 1 で作る `pecot-status` の ID を `vertical_group_by` に使う |
| 4 | 3 | スタックできる | Phase 4 の起票・同期・一覧が、Phase 3 で作る `pecot-lane` のフィールドと、選択肢を引く関数を使う |
| 6 | 5 | スタックできる | Phase 6 の検証が、Phase 5 で作る定義の読み込み（`infra/github/attributes.ts`）を使う |
| 7 | 6 | スタックできる | Phase 7 の網羅のテストが、Phase 6 で作る `ATTRIBUTE_HANDLERS` と照らす |
| 8 | 7 | スタックできる | Phase 8 の差の確かめが、Phase 7 で作る `extract.ts` と写しを使う |
| 9 | 7 | スタックできる | Phase 9 の棚卸しの「pecot の今の使い方」が、Phase 7 の担保の一覧で決まる |
| 10 | 2 | マージを待つ | このリポのボードは、配布された pecot-workflow で移す。廃止と移行の処理がリリースに入っていないと、`confirm_delete` の削除ができない |
| 10 | 4 | マージを待つ | このリポのボードは、配布された pecot-workflow で移す。`pecot-lane` と起票・同期の処理がリリースに入っていないと、`missing_lane` を確かめられない |

### User Story Dependencies

- A（US4b → US4・US1 → US2・US3）と B（US5 → US6）は、互いを待たない
- US5 の定期の確かめ（Phase 8）の実物の確かめは、Phase 8 自身のマージと Lambda の配備の後になる（T072 に注記）

### Within Each User Story

- 定義書の振る舞いとテストを先に書き、落ちることを確かめてから実装する
- domain → infra → commands → スキル・文書の順にする
- 各フェーズの最後に、`generated.json` を作り直し、変えたテストのファイルだけを動かし、quickstart の該当の手順を検証用のボードで動かす

### Parallel Opportunities

- A の Phase 1〜4 と、B の Phase 5〜8 は、別の worktree で並べて進められる
- Phase 2 と Phase 3 は、どちらも Phase 1 にだけスタックするので、並べて進められる
- 各フェーズの `[P]` のテストは、別のファイルなので並べて書ける

---

## Parallel Example: Phase 4

```text
Task: "T032 [P] [US3] PW/cli/src/domain/tests/lanes.test.ts に LaneSummary の集計のテスト"
Task: "T033 [P] [US2] issue-create.test.ts・board.test.ts に起票と同期のテスト"
Task: "T034 [P] [US3] board.test.ts に board_show の lane・lanes のテスト"
```

---

## Implementation Strategy

### MVP First

1. Phase 1（`pecot-status`）→ Phase 3（`pecot-lane` とビュー）で、検証用のボードを領域のレーンで見られる
2. Phase 4 で、起票と一覧が領域を扱う
3. B は Phase 5 → 6 で、名前で機能を使える最小の形になる

### Incremental Delivery

1. A: Phase 1 → 2・3（並べて）→ 4 → リリース → Phase 10
2. B: Phase 5 → 6 → 7 → 8・9（並べて）
3. 各フェーズは PR 1 つ。w-active で 1 つずつ着手する

---

## Notes

- このリポのボードの移行は Phase 10 だけ。それまでの確かめは検証用のボードで行う。Phase 9 の T074・T075 の起票は、確かめではなく本物の作業なので、このリポに起票する
- フィールドの削除は値ごと消え、戻せない。Phase 10 の T079 は、必ず利用者の確認を取る
- Lambda の配備と Scheduler の書き換えは、利用者の `pecot` プロファイルで行う。IAM は変えない

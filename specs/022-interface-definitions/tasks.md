---

description: "CLI と MCP のインタフェース定義書を正として持ち、テストを振る舞いの資料として読める のタスク一覧"
---

# Tasks: CLI と MCP のインタフェース定義書を正として持ち、テストを振る舞いの資料として読める

**Input**: `specs/022-interface-definitions/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、quickstart.md と、contracts/ の 2 つの文書

**Tests**: 憲法 II（TDD）を守る。形式の検証・一致の確認・つなぎの確認は、失敗する入力のテストを先に書き、失敗を確かめてから実装する。期待は、contracts/definition-format.md の失敗の行の文字列と比べる。モックはファイルの読み書きだけに使う。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの番号は plan.md の「実装の段階と PR」の段階と同じ。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US5） |

パスはリポ root 起点で書く。

## 全フェーズに共通の完了条件

- pre-commit を `--no-verify` なしで通す
- 既存のコマンド・ツールの振る舞いと終了コードを変えない。定義書は今の振る舞いを書き起こす
- `authored.yaml` の欄は、contracts/definition-format.md の「欄が従う枠組み」の表と、data-model.md の型・言語・使わないときの値に従う。どの欄も省かない
- `details` には、外から観測できる結果だけを書く。内部の手順・使い方の案内・設計の理由は書かない（FR-025）
- 振る舞いの項目は、実装とテストを読んで書き起こす。EARS の型を `pattern` に持ち、契機と応答を 1 組だけ書く（FR-026）。文は日本語、ほかの欄は英語にする（FR-022）
- `generated.json` は手で直さない。書き出しのコマンドの `--write` で作る
- 配布物が変わるフェーズ（`plugins/` の下を変えるもの）は、version plan を `.nx/version-plans/` に足す。CHANGELOG は手で編集しない
- 各テストのカバレッジの閾値を下げない（憲法 III）
- テストの後に、足したコマンドを実物で動かし、出た行を PR に貼る（憲法 II）。失敗の行は、定義書やソースを一時的に書き換えて出す

## 段階的に有効にする確認

`libs/interface-spec/targets.json` に、プラグインごとの 2 つの設定を持つ。人の書く量が多いので、PR を分けても CI を通せる形にする。

| 設定 | 値 | 意味 |
|---|---|---|
| `entries` | `partial` | `generated.json` にあって `authored.yaml` に無い項目を許す |
| | `complete` | 2 つのファイルの項目の ID の集合が同じでないと止める |
| `coverage` | `off` | テストの無い振る舞いの項目を許す。定義書に無い ID を書いたテストは、この値でも失敗にする |
| | `on` | テストの無い振る舞いの項目を失敗にする |

最後のフェーズが終わったとき、3 プラグインとも `complete`・`on` になる。

---

## Phase 1: 定義書の形式と検証 — `libs/interface-spec` を作る (Priority: P1)

**Goal**: 定義書の形式が zod の定義で決まり、形式に合わない定義書を `lint-defs` が止める。定義書はまだ 1 つも無い

**Independent Test**: `libs/interface-spec/tests/` の fixture の定義書に検証をかける。fixture は、正しいもの 1 つと、誤りを 1 つずつ入れたものだ。失敗の行が、contracts/definition-format.md の文字列と一致する

- [x] T001 `libs/interface-spec/` を nx の project として作る
  - 設定のファイルは `libs/text-rules/` と同じ作りで置く
  - 置くのは `package.json`・`project.json`・`tsconfig.json`・`eslint.config.js`・`vitest.config.ts` だ
  - レーンは `install`・`test-unit`・`lint`・`lint-defs`
  - `nx.json` の release の group には入れない
  - `lint` は、eslint・tsc に加えて、この project の下の Python に ruff と strict の型チェックをかける
- [x] T002 version plan の確認が、release の group に無い `libs/interface-spec/` の変更で plan を求めないことを確かめる。確認は `.githooks/pre-push/check-version-plan-required.sh` にある。求めるなら、対象から外す
- [x] T003 `lint-defs` と `test-unit` を、lint と test の hook のレーン名の列挙に足す（`.githooks/README.md` R1）。`.githooks/tests/` の該当のテストを直す
- [x] T004 [P] `libs/interface-spec/tests/fixtures/` に、定義書の fixture を作る。正しいもの 1 組と、次の誤りを 1 つずつ入れたものを置く
  - `authored.yaml` に項目が無い
  - 欄が 1 つ欠けている（`on_error`）
  - 知らない欄がある
  - `constraints` の引数の名前が `input` に無い
  - `statement` に日本語が無い。`details` に日本語がある
  - `pattern` と文の形が合わない
  - MCP ツールの `effects` の種類が `mcp.annotations.readOnlyHint` と食い違う
  - 振る舞いの項目の ID が重なる。ID の形が違う
  - `format` が知らない値
  - ソースが読む環境変数の名前が `environment` に無い（Python と TypeScript のソースの fixture を置く）
- [x] T005 `libs/interface-spec/tests/validate.test.ts` を書く。T004 の fixture ごとに、失敗の行を文字列で比べる。この時点で失敗することを確かめる
- [x] T006 `libs/interface-spec/src/domain/schema.ts` に、2 つのファイルの形式を zod で定義する。欄は data-model.md の表のとおりにする。人が書く側は、どの欄も省けない
- [x] T007 `libs/interface-spec/src/domain/validate.ts` に、data-model.md の「検証の規則」のうち形式の検証が担うものを実装する。失敗は 1 件 1 行で、ファイル・項目の ID・欄・理由を返す
- [x] T008 `libs/interface-spec/src/domain/ears.ts` に、`pattern` と日本語の文の形を比べる規則を実装する。形は contracts/definition-format.md の「振る舞いの項目の文の型」の表に従う
- [x] T009 `libs/interface-spec/src/domain/diff.ts` に、2 つの `generated.json` の差を出す関数を実装し、テストを書く。差は「項目の ID: 欄のパス: 変わり方」の行で出す。各プラグインの一致の確認がこれを使う
- [x] T010 `libs/interface-spec/src/infra/` に、`targets.json` と定義書の読み込みを実装する。`libs/interface-spec/src/cli.ts` に `validate` のコマンドを足し、`lint-defs` から呼ぶ。`targets.json` は、3 プラグインとも定義書が無い状態で通る
- [x] T011 `libs/interface-spec/tests/environment.test.ts` を書く。T004 のソースの fixture から名前を集め、`environment` に無い名前の失敗の行を文字列で比べる。`entries: partial` のプラグインでは確認を動かさないことも確かめる。この時点で失敗する
- [x] T012 環境変数の名前の確認を実装する
  - `entries: complete` のプラグインだけを対象にする
  - 対象のソースから、環境変数を読む箇所の名前を集め、`authored.yaml` の `environment` と比べる
  - 読む箇所は `os.environ`・`os.getenv`・`process.env` で探す
  - 取りこぼしが無いかを、3 プラグインのソースで確かめる（FR-028）
- [x] T013 層の依存（domain が infra・cli を import しない）を、`import-x/no-restricted-paths` で止める
- [x] T014 `libs/interface-spec/tests/field-map.test.ts` を書く。形式の定義の欄がすべて対応表にあり、表だけにある欄が無いことを確かめる。この時点で失敗する（FR-023、SC-010）
- [x] T015 `libs/interface-spec/src/domain/field-map.ts` に、欄と POSIX の節・借りた先の対応表を持つ。中身は contracts/definition-format.md の「欄が従う枠組み」の 2 つの表を移す

**Checkpoint**: T005 が通る。`pnpm exec nx run interface-spec:lint-defs` が通る

---

## Phase 2: User Story 1 — pecot-workflow の定義を実装から書き出し、食い違いを止める (Priority: P1) 🎯 MVP

**Goal**: pecot-workflow の 34 コマンドの `generated.json` があり、実装を変えて書き出し直さないと `test-py` が落ちる

**Independent Test**: quickstart.md の US1 の上 2 行が通る

**前提**: PR #227（`--help` を英語にする）がマージされている

- [ ] T016 [US1] `plugins/pecot-workflow/cli/tests/unit/test_interface_export.py` を書く
  - 小さな typer の app を組み、書き出した項目を期待の値と比べる
  - 比べるのは、型・必須か・既定値・位置引数の順・オプションの名前・`hidden`・`deprecated` だ
  - 型は、文字列・整数・真偽値・path・choice・複数指定を入れる
  - この時点で失敗する
- [ ] T017 [US1] `plugins/pecot-workflow/scripts/interface/` を、`lint-py` の ruff と strict の型チェックの対象に入れる。`project.json` の `lint-py` の入力にも足す
- [ ] T018 [US1] `plugins/pecot-workflow/scripts/interface/export.py` を実装する
  - `typer.main.get_command(app)` の木をたどり、contracts/definition-format.md の `generated.json` を作る
  - typer が同梱する click の非公開のモジュールを import しない
  - 既定値が実行時に決まる引数は `default` に入れない
  - 項目は `id` の順に並べ、キーの順を固定する。同じ実装から同じバイト列を出す
  - `--check` は、リポジトリのファイルとの差を contracts の形で出して終了コード 1 で終わる。`--write` は書き換える
- [ ] T019 [US1] typer の引数の型のうち、JSON Schema に写せないものが無いかを、34 コマンドの全引数で確かめる。写せないものがあれば、写し方を contracts/definition-format.md に足す
- [ ] T020 [US1] `plugins/pecot-workflow/interface/generated.json` を `--write` で作る
- [ ] T021 [US1] `test_interface_export.py` に、`--check` が今の実装で通ることのテストを足す。`plugins/pecot-workflow/project.json` の `test-py` の入力に `interface/**` と `scripts/interface/**` を足す
- [ ] T022 [US1] `libs/interface-spec/targets.json` に pecot-workflow を `entries: partial`・`coverage: off` で足す。`plugins/pecot-workflow/interface/authored.yaml` を、項目が空の形で置く
- [ ] T023 [US1] `plugins/pecot-workflow/cli-node/tests/interface-export.test.ts` を書く
  - 見本の `CommandSpec` を 2 つ組み、書き出した項目が形式の検証を通ることを確かめる
  - 同じ引数を持つ typer の見本から書き出した `input` と、差が 0 件であることも確かめる
  - この時点で失敗する（FR-008、SC-008）
- [ ] T024 [US1] `plugins/pecot-workflow/cli-node/scripts/export-interface.ts` を実装する
  - `registry.ts` の `CommandSpec` の入力を `z.toJSONSchema()` に通し、`surfaces.cli` と `surfaces.mcp` の両方を持つ項目を作る
  - 登録済みのコマンドが 0 件の今は、`generated.json` を書き換えない

**Checkpoint**: オプションを 1 つ足すと `test-py` が落ち、`--write` で通る

---

## Phase 3: User Story 1 — pecot-workflow の project のコマンドを書き起こす (Priority: P1)

**Goal**: `project` の 10 コマンドの人が書く欄と、振る舞いの項目がそろう

**Independent Test**: `lint-defs` が通る。10 項目のどの欄も、値か「使わないときの値」を持つ

- [ ] T025 [US1] `plugins/pecot-workflow/interface/authored.yaml` の先頭の `environment` に、CLI の全コマンドに共通の環境変数を書く。T012 の確認が挙げた名前をすべて入れる
- [ ] T026 [US1] `project` の 10 コマンドの項目を書く。`cli/commands/project.py` と `cli/tests/` の該当のテストを読み、今の振る舞いを書き起こす
- [ ] T027 [US1] T026 で書いた振る舞いの項目に当てて、EARS の型と文の形を比べる規則（T008）が厳しすぎないかを確かめる。合わない実例があれば、規則と contracts の表を直す
- [ ] T028 [US1] `common_behaviors` に、全コマンドに共通の振る舞い（知らないオプション、`--help`、`--repo` の解決など）を書く

**Checkpoint**: `lint-defs` が通る

---

## Phase 4: User Story 1 — pecot-workflow の issue と pr のコマンドを書き起こす (Priority: P1)

**Goal**: `issue` の 5 コマンドと `pr` の 4 コマンドの項目がそろう

**Independent Test**: `lint-defs` が通る

- [ ] T029 [P] [US1] `issue` の 5 コマンドの項目を書く。`cli/commands/issue.py` とテストを読む。複数ファイルの途中で失敗したときに残るものを `on_error` に書く
- [ ] T030 [P] [US1] `pr` の 4 コマンドの項目を書く。`cli/commands/pr.py` とテストを読む

**Checkpoint**: `lint-defs` が通る

---

## Phase 5: User Story 1 — pecot-workflow の残りのコマンドを書き起こし、項目の欠けを止める (Priority: P1)

**Goal**: 34 コマンドすべての項目がそろい、項目の欠けを `lint-defs` が止める

**Independent Test**: quickstart.md の US1 の全行が通る

- [ ] T031 [P] [US1] `session`（2）・`release`（3）の項目を書く
- [ ] T032 [P] [US1] `security sync`・`dependabot sync`・`worktree`（4）の項目を書く
- [ ] T033 [P] [US1] グループの無い 4 コマンド（`add-to-project`・`update-issue-status`・`create-branch`・`delete-branch`）の項目を書く
- [ ] T034 [US1] `libs/interface-spec/targets.json` の pecot-workflow を `entries: complete` にする

**Checkpoint**: `main.py` にコマンドを 1 つ足して書き出すと、`lint-defs` が `entry is missing` で止まる

---

## Phase 6: User Story 2 — pecot-tools の定義書を作り、食い違いを止める (Priority: P2)

**Goal**: pecot-tools の 26 ツールの定義書があり、ツールの入力を変えて書き出し直さないと `test-cli` が落ちる

**Independent Test**: quickstart.md の US2 が、pecot-tools で通る

- [ ] T035 [US2] `plugins/pecot-tools/cli/tests/interface-export.test.ts` を書く。メモリ内でつないだ MCP サーバの `tools/list` から書き出したものが、リポジトリの `generated.json` と一致することを確かめる。この時点で失敗する
- [ ] T036 [US2] `plugins/pecot-tools/cli/scripts/export-interface.ts` を実装する
  - `tools/list` の `inputSchema`・`outputSchema`・`annotations` を、そのまま `input`・`mcp.output`・`mcp.annotations` に入れる
  - `--check` と `--write` を持つ
  - 差の出し方は `libs/interface-spec` の関数を使う
- [ ] T037 [US2] `plugins/pecot-tools/interface/generated.json` を `--write` で作る。`project.json` の `test-cli` の入力に `interface/**` を足す
- [ ] T038 [US2] `plugins/pecot-tools/interface/authored.yaml` を書く。26 ツールの項目と、全ツールに共通の環境変数・共通の振る舞い（入力の検証、失敗の種別、結果の形）を書く
  - `effects` は、実行する AWS の操作と、読み取りか書き込みかを書く（spec の US2 の 3）
  - `exit_status` は、失敗の種別（`awscli-missing` など）と条件を書く
  - `stdin` は `none` にする
- [ ] T039 [US2] `plugins/pecot-tools/cli/src/mcp/tests/contract.test.ts` の `TOOL_CONTRACTS` の表を消す。代わりに、定義書との一致を確かめる。別リポの契約からの転記である旨のコメントも消す
- [ ] T040 [US2] `libs/interface-spec/targets.json` に pecot-tools を `entries: complete`・`coverage: off` で足す

**Checkpoint**: 許可リストにコマンドを 1 つ足すと、`test-cli` と `lint-defs` が止まる

---

## Phase 7: User Story 2 — pecot-visual の定義書を作り、食い違いを止める (Priority: P2)

**Goal**: pecot-visual の MCP ツールの定義書があり、食い違いを `test-cli` が止める

**Independent Test**: quickstart.md の US2 が、pecot-visual で通る

- [ ] T041 [US2] pecot-visual の一致のテストと書き出しを、Phase 6 と同じ形で作る
  - `plugins/pecot-visual/cli/tests/interface-export.test.ts`
  - `plugins/pecot-visual/cli/scripts/export-interface.ts`
- [ ] T042 [US2] `plugins/pecot-visual/interface/generated.json` を `--write` で作る。`project.json` の `test-cli` の入力に `interface/**` を足す
- [ ] T043 [US2] `plugins/pecot-visual/interface/authored.yaml` を書く。ツールが書き出すファイルと起動するプロセス（dev サーバ、ブラウザ）を `effects` に書く
- [ ] T044 [US2] `libs/interface-spec/targets.json` に pecot-visual を `entries: complete`・`coverage: off` で足す

**Checkpoint**: ツールの入力に項目を 1 つ足すと、`test-cli` が止まる

---

## Phase 8: User Story 3 — w-help のコマンド一覧を定義書から作る (Priority: P2)

**Goal**: `commands.md` が定義書から生成され、古いと `lint-defs` が止める

**Independent Test**: quickstart.md の US3 の上 2 行が通る

- [ ] T045 [US3] `libs/interface-spec/tests/commands-md.test.ts` を書く。fixture の定義書から作った Markdown を、期待の文字列と比べる。確かめるのは 3 つだ。グループの見出しと並び、`hidden` の項目を出さないこと、先頭の「生成物」の行である
- [ ] T046 [US3] `libs/interface-spec/src/cli.ts` に `commands-md` のコマンドを足す。`--check` は、作り直したものとリポジトリのファイルを比べる。`--write` は書き換える
- [ ] T047 [US3] `plugins/pecot-workflow/skills/w-help/references/commands.md` を生成物に置き換える。今の手書きの表にあって定義書に無い補足（`project create` と `project init` の使い分けなど）を挙げる。補足は実装の help の文に移し、`generated.json` を書き出し直す
- [ ] T048 [US3] `lint-defs` に `commands-md --check` を足す。`plugins/pecot-workflow/skills/w-help/SKILL.md` が `commands.md` を参照する箇所が、生成物の形でも読めることを確かめる

**Checkpoint**: `generated.json` の説明を変えて作り直さないと、`lint-defs` が `commands.md is stale` で止まる

---

## Phase 9: User Story 4 — テストの規約を置き、題の形を lint で止める (Priority: P2)

**Goal**: `.claude/rules/test-conventions.md` があり、規約に外れた vitest の題を lint が止める

**Independent Test**: quickstart.md の US4 の 1 行目が、4 つの project で通る

- [ ] T049 [US4] `vitest/valid-title` の設定で、`it` の題の 2 つの決めを守れるかを確かめる
  - 決めは「日本語の文字がある」と「句点で終わらない」だ
  - `describe` と `it` を別々の形で指定できるかも確かめる
  - できない部分は、`libs/interface-spec` に小さな eslint の規則を書く
  - 規則を書くときは、通る題と外れる題の RuleTester のテストを先に書く
- [ ] T050 [US4] `.claude/rules/test-conventions.md` を書く。中身は contracts/test-conventions.md に従う。対象、題の形、項目へのつなぎ、従う考え方を、vitest と pytest の例つきで書く
- [ ] T051 [P] [US4] `plugins/pecot-tools/cli/eslint.config.js` で題の lint を有効にし、外れた題（約 2 件）を直す
- [ ] T052 [P] [US4] pecot-visual で題の lint を有効にし、外れた題（約 110 件）を直す。設定は `plugins/pecot-visual/cli/eslint.config.js` と、`plugins/pecot-visual/assets/slidev/` の下にある
- [ ] T053 [P] [US4] `plugins/pecot-workflow/cli-node/eslint.config.js` で有効にし、外れた題（約 33 件）を直す
- [ ] T054 [P] [US4] `libs/text-rules/eslint.config.js` と `libs/interface-spec/eslint.config.js` で有効にし、外れた題を直す
- [ ] T055 [US4] 「いちばん外の `describe` の題が定義書の `name` にある」を確かめる eslint の規則の、RuleTester のテストを書く。定義書にある名前・無い名前・`describe` が無いファイルを入れる。この時点で失敗する
- [ ] T056 [US4] T055 の規則を `libs/interface-spec` に実装する。各 project の eslint の設定で、`tests/interface/**` にだけ当てる。今の公開面のテストのファイルは対象に入れず、作り替えない

**Checkpoint**: `it('works', …)` を足すと、4 つの project の lint が止まる

---

## Phase 10: User Story 4 — テストが項目の ID を書けるようにし、定義書に無い ID を止める (Priority: P2)

**Goal**: vitest と pytest が振る舞いの項目の ID を JUnit に出せる。定義書に無い ID を書いたテストを `lint-defs` が止める

**Independent Test**: quickstart.md の US4 の 2〜3 行目が通る

- [ ] T057 [US4] `libs/interface-spec/tests/links.test.ts` を書く。fixture のテストのファイルから ID を集め、定義書に無い ID と、テストの無い項目を、contracts の失敗の行で比べる。`coverage: off` では後者を出さないことも確かめる
- [ ] T058 [US4] `libs/interface-spec/src/domain/links.ts` と `cli.ts` の `links` のコマンドを実装する
  - テストのファイルから `P[WTV]-[A-Z0-9-]+-[0-9]{2}` に合う文字列を集める
  - テストは動かさない
  - `lint-defs` に足す
  - 3 プラグインを対象にした `lint-defs` の所要を測り、10 秒を超えないことを PR に書く
- [ ] T059 [P] [US4] vitest の 3 つの project（pecot-tools・pecot-visual・`cli-node/`）に `verifies` の関数を足す
  - pecot-tools では `plugins/pecot-tools/cli/tests/_helpers/verifies.ts` に置く
  - `annotate(id, 'verifies')` を呼ぶ 1 行の関数にする
  - 各 `vitest.config.ts` に JUnit の出力を足し、出力先を `.gitignore` と nx の `outputs` に書く
- [ ] T060 [P] [US4] pytest から、項目の ID を JUnit へ出せる形にする
  - `plugins/pecot-workflow/cli/pyproject.toml` の dev 依存に ub-test-reports を足し、`uv.lock` を更新する
  - `plugins/pecot-workflow/scripts/ci/run-tests.sh` の pytest に、次の 3 つを足す
    - `-p ub_test_reports.pytest_plugin`
    - `-o junit_family=xunit1`
    - `-o "test_reports_properties=verifies, list"`
  - JUnit を比べる既存の処理（`compare_junit.py`）が通ることを確かめる
- [ ] T061 [US4] 見本として、pecot-tools の 1 ツールと pecot-workflow の 1 コマンドのテストに ID を書く。JUnit に `<property name="verifies">` が出ることを確かめる。対象は #200 と同じにする。`aws_sts_get_caller_identity` と `session status` だ

**Checkpoint**: テストに `verifies(ctx, 'PT-AWS-S3-LS-99')` を足すと、`lint-defs` がファイルと行を出して止まる

---

## Phase 11: User Story 5 — pecot-workflow の振る舞いの項目にテストをつなぐ (Priority: P3)

**Goal**: pecot-workflow のすべての振る舞いの項目が、1 件以上の pytest につながる。テストの無い項目を `lint-defs` が止める

**Independent Test**: `authored.yaml` にテストの無い項目を 1 つ足すと、`lint-defs` が `has no test` で止まる

- [ ] T062 [P] [US5] `project` の項目に pytest をつなぐ。`@add_test_properties(verifies=[…])` を足す。関数の名前と中身は直さない
- [ ] T063 [P] [US5] `issue`・`pr` の項目に pytest をつなぐ
- [ ] T064 [P] [US5] 残りのコマンドと `common_behaviors` の項目に pytest をつなぐ
- [ ] T065 [US5] つなぐテストが無い項目を挙げる。実装にある振る舞いは、テストを足す。項目を消してよいのは、今の実装にその振る舞いが無いと確かめたときだけにする。挙げた項目と決めを PR に書く
- [ ] T066 [US5] `libs/interface-spec/targets.json` の pecot-workflow を `coverage: on` にする

**Checkpoint**: `lint-defs` が通る。pecot-workflow の振る舞いの項目で、テストの無いものが 0 件

---

## Phase 12: User Story 5 — pecot-tools の振る舞いの項目にテストをつなぐ (Priority: P3)

**Goal**: pecot-tools のすべての振る舞いの項目が、1 件以上の vitest につながる

**Independent Test**: テストの無い項目を 1 つ足すと、`lint-defs` が止まる

- [ ] T067 [US5] pecot-tools の項目に vitest をつなぐ。つなぐテストのうち `it.each` のものは `it.for` に書き換え、表の行に ID を持たせる。全ツールを回すテストは、共通の振る舞いの項目につなぐ
- [ ] T068 [US5] つなぐテストが無い項目を挙げ、T065 と同じ決めで扱う。`targets.json` の pecot-tools を `coverage: on` にする

**Checkpoint**: `lint-defs` が通る

---

## Phase 13: User Story 5 — pecot-visual の振る舞いの項目にテストをつなぐ (Priority: P3)

**Goal**: pecot-visual のすべての振る舞いの項目が、1 件以上の vitest につながる

**Independent Test**: テストの無い項目を 1 つ足すと、`lint-defs` が止まる

- [ ] T069 [US5] pecot-visual の項目に vitest をつなぐ。Phase 12 と同じ形にする
- [ ] T070 [US5] つなぐテストが無い項目を挙げ、T065 と同じ決めで扱う。`targets.json` の pecot-visual を `coverage: on` にする

**Checkpoint**: `lint-defs` が通る。3 プラグインとも `complete`・`on` になる

---

## Phase 14: User Story 3・5 — 定義書と振る舞いの一覧を 1 つの HTML で読める (Priority: P3)

**Goal**: 定義書の全項目と、項目ごとのテストと合否を、1 つの HTML で読める

**Independent Test**: quickstart.md の US3 の 3 行目と、US5 の 2〜4 行目が通る

- [ ] T071 [US5] `libs/interface-spec/docs/` に sphinx の project を作る
  - `pyproject.toml` と `uv.lock` で、sphinx-needs 9.2 と sphinx-test-reports 4.0 の版を固定する
  - `conf.py` に、need の型を 2 つ定義する。コマンド・ツールと、振る舞いの項目だ
  - `conf.py` に、リンクの型 `belongs`・`verifies` を定義する
  - `tr_suite_id_length`・`tr_case_id_length` は 8 にする
  - `docs/` の下の Python を、T001 の ruff と strict の型チェックの対象に入れる
- [ ] T072 [US5] `libs/interface-spec/docs/tests/test_iface_defs.py` を書く
  - fixture の定義書で sphinx をビルドし、出力の `needs.json` を読む
  - need の ID・`belongs` のリンク・本文の表の行を、期待の値と比べる
  - 定義書を作れない項目が警告になることも確かめる
  - この時点で失敗する
  - `test-unit` のレーンから動かす
- [ ] T073 [US5] `libs/interface-spec/docs/_ext/iface_defs.py` に、定義書を読んで need を作るディレクティブを実装する。`sphinx_needs.api.create_need` を使う。試行の `.pecot/work/199/tech-advisor/A-directive/iface_defs.py` をもとにする
  - コマンド・ツールの need の本文に、引数・副作用・終了の状態の表を入れる。欄は、contracts の POSIX の節の順に並べる
  - 振る舞いの項目の need を、コマンド・ツールへ `belongs` でつなぐ
  - 定義書のファイルを `env.note_dependency` で依存に入れる
  - need を作れないとき（`InvalidNeedException`）は、警告にして続ける
  - 欄と枠組みの対応表（`field-map.ts` から書き出したもの）を、1 つのページに出す
- [ ] T074 [US5] プラグインごとのページを作る。各ページで、そのプラグインの JUnit を取り込む。テストのケースは、項目につないだものだけを描く。JUnit が無いときは、合否を「未実行」と出す
- [ ] T075 [US5] `libs/interface-spec/project.json` に `docs` のレーンを足す。`sphinx-build -W` で動かす。PR の必須のレーンには入れない。全量のビルドの所要と、HTML の大きさを測って PR に書く
- [ ] T076 [US5] 表示の HTML を CI の artifact に上げるかを決める。上げるなら、`ci.yml` のどの job が JUnit を集めるかを決めて足す。上げないなら、手元で作る手順を `libs/interface-spec/README.md` に書く

**Checkpoint**: 任意のコマンドのページで、振る舞いの項目ごとに、つないだテストの名前と合否が並ぶ

---

## Phase 15: 文書を直す (Priority: P3)

**Goal**: 設計時の契約と、リポの案内が、定義書を正とする形にそろう

**Independent Test**: 直した文書に、定義書と食い違う記述が無い

- [ ] T077 [P] `specs/020-workflow-ts-mcp/contracts/mcp-tools.md` の先頭に 1 行足す。ツールの一覧と入力の正が `plugins/pecot-workflow/interface/` にある旨だ（FR-018）
- [ ] T078 [P] `CLAUDE.md` の「リポジトリ構成」の表に `libs/interface-spec` と、そのレーンを足す。`.githooks/README.md` のレーンの説明を直す
- [ ] T079 [P] `plugins/pecot-workflow/skills/w-help/SKILL.md` に、コマンドの引数と振る舞いを調べるときの参照先を書く。利用環境のエージェントが読むのは、生成済みの `commands.md` だ
- [ ] T080 Epic #42 の Issue に、移行で使う手順を 3 つ書く
  - 書き出しの元を `cli-node/` の `CommandSpec` に替える
  - `generated.json` の `input` の差が 0 件になるまで移す
  - つなぎ先を Node のテストへ移す

**Checkpoint**: SC-001〜SC-011 を 1 つずつ確かめ、結果を Epic #199 に書く

---

## Dependencies & Execution Order

### Phase Dependencies

| フェーズ | 始められる時期 |
|---|---|
| 1 | 最初 |
| 2（US1） | 1 の後。PR #227 のマージの後 |
| 3〜5（US1） | 2 の後。3 を最初に進め、EARS の規則を実物で確かめる。4 と 5 は 3 の後に並べてよい |
| 6（US2） | 1 の後。2〜5 と並べてよい |
| 7（US2） | 6 の後。書き出しの形を 6 にそろえる |
| 8（US3） | 5 の後 |
| 9（US4） | 1 の後ならいつでも。T055・T056 だけは 6 の後 |
| 10（US4） | 5 と 6 の後 |
| 11（US5） | 5 と 10 の後 |
| 12（US5） | 6 と 10 の後 |
| 13（US5） | 7 と 10 の後 |
| 14（US3・US5） | 10 の後。11〜13 と並べてよい |
| 15 | 13 と 14 の後 |

### User Story Dependencies

| ストーリー | 依存 |
|---|---|
| US1 | 無い。Phase 1 の形式に載る |
| US2 | Phase 1 の形式に依存する。US1 とは独立 |
| US3 | `commands.md` は US1 に依存する。表示は US5 と同じ HTML で作る |
| US4 | 題の lint は独立。項目へのつなぎは US1・US2 の定義書に依存する |
| US5 | US1・US2 の振る舞いの項目と、US4 のつなぎに依存する |

### Parallel Opportunities

| 段 | 並べて進められるフェーズ |
|---|---|
| Phase 1 の後 | 2・6・9 |
| Phase 3 の後 | 4・5 |
| Phase 10 の後 | 11・12・13・14 |

## Parallel Example

```text
# Phase 1 の後、次を並べて進められる
Phase 2: T018 pecot-workflow の書き出し
Phase 6: T036 pecot-tools の書き出し
Phase 9: T051〜T054 題の lint

# Phase 10 の後、次を並べて進められる
Phase 11: T062 project / T063 issue・pr / T064 残り
Phase 12: T067 pecot-tools
Phase 13: T069 pecot-visual
Phase 14: T073 定義書を読むディレクティブ
```

`authored.yaml` は 1 つのファイルなので、同じプラグインのフェーズを並べるときは、項目の ID の順に書いて衝突を減らす。

## Implementation Strategy

### MVP

MVP は Phase 1〜5 とする。pecot-workflow の 34 コマンドの定義書がそろい、実装との食い違いと項目の欠けを CI が止める。Epic #42 の移行の契約に使える。欄の決め（POSIX の節立て、EARS の型）を、実物の 34 項目に当てて確かめられる。

### 増やし方

1. Phase 1〜5 で、形式と pecot-workflow の定義書がそろう
2. Phase 6〜7 で、pecot-tools と pecot-visual の定義書がそろう
3. Phase 8 で、w-help のコマンド一覧が生成物になる
4. Phase 9〜10 で、テストの規約と、項目へのつなぎの仕組みがそろう
5. Phase 11〜13 で、振る舞いの項目のすべてにテストがつながる
6. Phase 14 で、定義書とテストの合否を 1 つの HTML で読める
7. Phase 15 で、文書がそろう

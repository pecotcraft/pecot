---

description: "pecot-workflow の TypeScript 化と MCP 化（再設計）のタスク一覧"
---

# Tasks: pecot-workflow の TypeScript 化と MCP 化（再設計）

**Input**: `specs/020-workflow-ts-mcp/` の設計文書（2026-11-11 に作り直した）

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、contracts/、quickstart.md

**Tests**: 憲法 II（TDD）を守る。テストを先に書き、失敗を確かめてから実装する。
モックは I/O 境界だけに使う。I/O 境界とは、偽の GitHub サーバ、一時 git リポ、shell の子プロセスを指す。
コマンドの移植では、済みの前後比較のシナリオと、定義書の振る舞いの項目を先行のテストとして使う。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの番号は plan.md の「フェーズ」と同じ。
そのフェーズの節と、2 つの共通の完了条件だけで着手できるように書く。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US5） |

パスは `plugins/pecot-workflow/` 起点で書く。例は `cli/`・`cli-node/`・`hooks/`・`skills/`・`bin/`・`interface/`・`project.json`。

次のものは、リポ root 起点で書く。

- `plugins/pecot-tools/`・`plugins/pecot-visual/`・`libs/`
- `.github/`・`.githooks/`・`.nx/`・`.claude/`・`.specify/`
- `nx.json`・`CLAUDE.md` など
`.github/plugin/plugin.json` や `README.md` のように、root とプラグインの両方にあり得るものは、`plugins/pecot-workflow/` から始めて書く。

## 全フェーズに共通の完了条件

- pre-commit と pre-push を `--no-verify` なしで通す
- pecot-workflow の version plan を `.nx/version-plans/` に足す。CHANGELOG は手で編集しない
- 新しい識別子・ファイル名・テストの値に、ベンダー名とブランドの語を含めない
- `cli-node/vitest.config.ts` のカバレッジの閾値を下げない
- フェーズ 11 より前は、配布物の振る舞いを変えない（spec FR-014）
- フェーズ 11 より前は、`interface/generated.json` を Node から書かない（spec FR-020）
- `interface/authored.yaml` の項目の ID と文を変えない（spec FR-022）

## コマンドを移すフェーズ（2〜6）に共通の完了条件

- 該当の前後比較のシナリオが、`cli-node/tests/parity/parity.test.ts` で golden と一致する。golden は書き換えない
- `cli-node/scripts/export-interface.ts --check` の差が 0 件になる
  対象は登録済みの全部で、この PR で足した N 個を含む。
  比べる欄は `surfaces.mcp` 以外の全部（`input`・`cli`・`name`・`description`・`hidden`・`deprecated`・`surfaces.cli`）である。
- `interface-spec:lint-defs` が通る
- 移したコマンドの振る舞いの項目が、全部 vitest のケースにつながる
  ケースは `cli-node/tests/interface/<グループ>.test.ts` に置く。グループ無しのコマンドは、コマンド名のファイルに置く。
- ケースの最初で `verifies(context, 'PW-…')` を呼ぶ。いちばん外の `describe` はコマンド名にする（`.claude/rules/test-conventions.md`）
- 項目のケースの期待値は、項目の文と、今つながっている pytest のケースから取る。`tests/parity/` の下には ID を書かない
- pytest の差し替えは、次のように vitest へ置き換える
  - `GitHubClient` は、偽の GitHub サーバ（`tests/fake-github/`）の応答にする
  - 設定の読み（`load_active_config` など）は、一時ディレクトリに置く設定ファイルで置き換える
  - `git_current_branch` などの git の関数は、一時 git リポにする
  - 呼び出しの確認（`assert_called_with`）は、偽サーバが受けた要求の比較か、終わった後のファイルの比較にする
- コマンドの起動は、`cli-node/src/cli.ts` の `runCli(argv, context)` をプロセス内で呼ぶ。カバレッジに数えるため
- 表を回すケースは `it.for` を使い、行に ID をリテラルで持たせる。`it.each` では `annotate` が使えない
- `tests/interface/` では `it.skip`・`it.todo` を使わない
- 出力は `createOutput`（`cli-node/src/commands/output.ts`）を通す。`tests/direct-output-lint.test.ts` が通る
- 項目のケースは、移植と同じ変更で書く。先に書いて失敗を確かめてもよく、順は問わない（憲章 II）
- pytest 側のつなぎ（`@add_test_properties(verifies=[...])`）は消さない
- 項目の ID・元の pytest のケース・vitest のケースの対応表を、`.pecot/work/<Issue番号>/` に残す
- 憲章 II の「単体テストの後、実際のコマンドを現実の入力で実行する」は、前後比較のシナリオが受け持つ
- 別のフェーズも要る共有の関数は、先に merge された PR の置き場に従う。後の PR が rebase で取り込む

---

## Phase 1: 準備（golden の差、依存の停止、定義書との比較）

**Purpose**: 移植の基準を今の Python にそろえる。移行中に基準が動かないようにする。定義書と比べる仕組みを、最初のコマンドを移す前に入れる

- [x] T001 `cli/` で `uv sync` を実行し、`cli-node/` で `record:parity:check` を流す。差が次の 5 件であることを確かめる。結果を `.pecot/work/<Issue番号>/` に残す。
  `delete-branch-auth-fallback`・`delete-branch-ok`・`pr-cleanup-ok-delete-branch` は stderr の差である。`pr-create-ok-prepare`・`pr-create-ok-prepare-epic` は files の差である。
  差があると終了コード 1 で終わる。
- [x] T002 T001 の 5 件の原因を調べる。この 1 回は、Python を変えない PR で記録し直してよい（spec FR-007 の例外）。Python の出力が変わっていたなら、その 5 件だけを `record:parity <id>...` で記録し直す。
  実行する環境で変わる値なら、`cli-node/tests/parity/run.ts` の置き換えの規則に足す。どちらの場合も、`record:parity:check` の差を 0 にする。
- [x] T003 [P] `.github/dependabot.yml` の uv のエントリに `open-pull-requests-limit: 0` を付ける。対象は `/plugins/pecot-workflow/cli` である。理由を同じファイルの 1 行のコメントに書く（research R-15）。
- [x] T004 `cli-node/tests/interface-export.test.ts` に `--check` のテストを先に書く。見本のコマンド定義を `main` に渡し、一時ファイルの定義書と比べる。
  確かめる条件は 5 つある。
  比べる項目は登録したコマンドの ID だけ。比べる欄は `surfaces.mcp` 以外の全部。Node にあって定義書に無い ID は失敗。定義書にあって Node に無い ID は見ない。登録 0 件は warning 1 行で終了コード 0。
  差があるときは、`<ID>: <欄>: <前> -> <後>` の行が標準エラーに出ることも確かめる。
  登録が 0 件なら、`--write` も warning 1 行を出して終了コード 0 にする。登録が 1 件以上の `--write` は、使い方のエラー（終了コード 2）にする。
  テストに書く見本の ID は、`PW-…-NN` の形の文字列をそのまま書かず、文字列の連結で作る。`lint-defs` が `is not defined` で止めるため。
- [x] T005 `cli-node/scripts/export-interface.ts` に `--check` を実装する。比べ方は `libs/interface-spec/src/domain/diff.ts` の `diffGenerated` を使う。
  `libs/interface-spec` は、`cli-node/eslint.config.js` の `describe-title` と同じく相対パスで import する。`GeneratedFile` の配列は変更可能な型なので、渡す前に写す。
  `diffGenerated` は項目と欄を絞る引数を持たない。呼ぶ側で、定義書の項目を Node の ID だけにし、Node の項目から `surfaces.mcp` を除いたものを渡す。
  差の行は `createOutput().error` に渡す。`formatStale` は `--write` を促す行を出すので、切り替えの前は使わない。
  `main` に、`generated.json` のパスを差し替える引数を足す（pecot-tools の `options.target` と同じ）。
- [x] T006 同じ `interface-export.test.ts` に、移したコマンドの項目のつなぎの確認を足す。決めは contracts/interface.md の「移したコマンドの項目のつなぎ」にある。
  登録済みのコマンドごとに、`authored.yaml` から振る舞いの ID を集める。ID が `verifies(` の引数として `cli-node/tests/**/*.ts` か `cli-node/src/**/tests/**/*.ts` にあることを見る。`tests/parity/**` と、コメントの中の ID は数えない。
  ID のあるファイルが `vitest.config.ts` の `cli` project の include に当たることも確かめる。登録が 0 件の間は、共通の項目 `PW-COMMON` だけを確かめる。
  見本のコマンドと見本の ID で、無い ID を並べて失敗することを確かめる。
- [x] T007 [P] 共通の項目 `PW-COMMON` の 17 個を、`cli-node/tests/interface/common.test.ts` のケースにつなぐ。対象は `cli-node/src/cli.ts` のグローバルオプションと例外の扱いである。
  コマンドの要る項目は、見本のコマンド定義を `COMMANDS` の代わりに渡して確かめる。Python と違う振る舞いがあれば、`cli.ts` の側を直す。
- [x] T008 [P] `libs/interface-spec/targets.json` の pecot-workflow の `sources` に、cli-node の製品コードを足す。Python と併記する。
  同じ変更で `libs/interface-spec/project.json` の `lint-defs` の inputs にも足す。
  テストは `sources` に入れない。`**` は使わず、ディレクトリごとに glob を分ける。
  - `cli-node/src/*.ts`・`cli-node/src/commands/*.ts`・`cli-node/src/domain/*.ts`
  - `cli-node/src/infra/*.ts`・`cli-node/src/infra/github/*.ts`
  `interface-spec:lint-defs` の環境変数の確認で出る失敗（試算で 41 件）を 0 件にする。やることは 3 つある。
  `authored.yaml` の `environment` に、製品コードが読む名前を足す。名前が文字列でない読みに、`interface-env:` の注記を付ける。テストのファイルを `sources` の glob から外す。
- [x] T009 [P] `project.json` の `test-cli` と `lint-cli` の inputs に、次を足す。
  - `interface/generated.json` と `interface/authored.yaml`
  - `libs/interface-spec` の `src/domain/diff.ts`・`schema.ts`・`utility.ts`・`package.json`
  pecot-tools の `project.json` と同じ形にする。`.githooks/tests/test_nx_affected_mapping.py` の期待値も直す。
  `diff.ts` の届く先に、`pecot-workflow:test-cli` と `pecot-workflow:lint-cli` を足す。

**Checkpoint**: `record:parity:check` の差が 0。`dependabot.yml` の uv のエントリに `open-pull-requests-limit: 0` がある。`--check` が登録 0 件で通る。共通の項目 17 個が vitest につながる。`interface-spec:lint-defs` が通る

---

## Phase 2: User Story 1 — project・create-branch・delete-branch を移す (Priority: P1)

**Goal**: project の 10 個と `create-branch`・`delete-branch` の 2 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の `project-*`・`create-branch-*`・`delete-branch-*` が golden と一致する。`global-*` は対象外で、フェーズ 6 で確かめる。
この PR で足した 12 個が登録され、登録済みの全部で `--check` の差が 0。振る舞いの項目 127 個（project 82、`create-branch` 27、`delete-branch` 18）が vitest につながる

- [x] T010 [P] [US1] `cli/commands/project.py` を `cli-node/src/commands/project.ts` に移す。`registry.ts` の `COMMANDS` に 10 個を足す。
  `cli/commands/_tracker_sync.py` の `api_error_detail` も要る。フェーズ 4・6 も使うので、`cli-node/src/commands/` の共有のファイルに置く。
- [x] T011 [P] [US1] `cli/commands/repo.py` の 2 個を `cli-node/src/commands/repo.ts` に移す。対象は `create_branch` と `delete_branch`。`COMMANDS` に 2 個を足す。
  共有の `_repo_policy.py` の `require_repo_match` と `_work_target.py` の `record_work_target` も要る。Node に無ければ、`cli-node/src/commands/` に置く。
- [x] T012 [US1] rich の表の整形を、golden と文字単位で一致させる。直す先は `cli-node/src/domain/format.ts` と `src/commands/cell-table.ts` である。
- [x] T013 [US1] Python が書いた状態を Node が読む `project-info-ok-python-state` が、golden と一致することを確かめる。食い違えば `cli-node/src/infra/state-store.ts` と `config-store.ts` を直す。
- [x] T014 [US1] 振る舞いの項目 127 個を、vitest のケースにつなぐ。置き場は `cli-node/tests/interface/project.test.ts`・`create-branch.test.ts`・`delete-branch.test.ts` である。
- [x] T015 [US1] `export-interface.ts --check` を流し、登録済みの全部で `surfaces.mcp` 以外の差を 0 にする。差があれば `project.ts` と `repo.ts` のコマンド定義を直す。

**Checkpoint**: 該当シナリオが全部一致する。この PR で足した 12 個が登録され、登録済みの全部で `--check` の差が 0。該当の項目 127 個が全部つながる

---

## Phase 3: User Story 1 — issue・session・add-to-project・update-issue-status を移す (Priority: P1)

**Goal**: issue の 5 個、session の 2 個、`add-to-project`・`update-issue-status` の 2 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の次のシナリオが golden と一致する。`issue-*`・`session-*`・`add-to-project-*`・`update-issue-status-*`
この PR で足した 9 個が登録され、登録済みの全部で `--check` の差が 0。振る舞いの項目 211 個（issue 138、`add-to-project` 17、`update-issue-status` 13、session 43）が vitest につながる

- [x] T016 [P] [US1] `cli/commands/issue.py` の issue の 5 個を `cli-node/src/commands/issue.ts` に移し、`COMMANDS` に足す。`--prepare` の下書きと、実投稿の成功時にスラッシュコマンドのフラグを消す処理を含める。
  `cli/core/issue_board.py` の `create_issue`・`put_on_board` などは、フェーズ 6 の同期も使う。`cli-node/src/` の共有の置き場に移す。
- [x] T017 [US1] `issue.py` の `add_to_project` と `update_issue_status` を同じ `issue.ts` に移し、`COMMANDS` に 2 個を足す。`_validate_status_for_type` も含める。
- [x] T018 [P] [US1] `cli/commands/session.py` を `cli-node/src/commands/session.ts` に移し、`COMMANDS` に 2 個を足す。
  `cli/commands/pr.py` の `extract_issue_number_from_branch` も要る。フェーズ 4 も同じ関数を使うので、共有の置き場に置く。
- [x] T019 [US1] Python が書いた状態を Node が読む `session-status-ok-python-state` が、golden と一致することを確かめる。食い違えば `cli-node/src/infra/state-store.ts` と `config-store.ts` を直す。
- [x] T020 [US1] 振る舞いの項目 211 個を、vitest のケースにつなぐ。置き場は `cli-node/tests/interface/` の下。ファイルはコマンドごとに分ける。
- [x] T021 [US1] `export-interface.ts --check` を流し、登録済みの全部で `surfaces.mcp` 以外の差を 0 にする。差があればコマンド定義を直す。

**Checkpoint**: 該当シナリオが全部一致する。この PR で足した 9 個が登録され、登録済みの全部で `--check` の差が 0。該当の項目 211 個が全部つながる

---

## Phase 4: User Story 1 — pr のコマンドを移す (Priority: P1)

**Goal**: pr の 4 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の `pr-*` のシナリオが golden と一致する。この PR で足した 4 個が登録され、登録済みの全部で `--check` の差が 0。振る舞いの項目 107 個が vitest につながる

- [ ] T022 [US1] `cli/commands/pr.py` の `create` と `read` を `cli-node/src/commands/pr.ts` に移し、`COMMANDS` に足す。`--prepare` と `--dry-run` を含める。
  `cli/commands/_tracker_sync.py` の `settle` も要る。フェーズ 6 も使うので、共有の置き場に置く。
- [ ] T023 [US1] `pr.py` の `preflight` と `cleanup` を同じ `pr.ts` に移し、`COMMANDS` に足す。git の呼び出しは `src/infra/git.ts` を通す。
  `extract_issue_number_from_branch` は、フェーズ 3 も使う。共有の置き場に置く。
- [ ] T024 [US1] pr の項目 107 個を、`cli-node/tests/interface/pr.test.ts` のケースにつなぐ。
- [ ] T025 [US1] `export-interface.ts --check` を流し、登録済みの全部で `surfaces.mcp` 以外の差を 0 にする。

**Checkpoint**: 該当シナリオが全部一致する。この PR で足した 4 個が登録され、登録済みの全部で `--check` の差が 0。該当の項目 107 個が全部つながる

---

## Phase 5: User Story 1 — worktree と release のコマンドを移す (Priority: P1)

**Goal**: worktree の 4 個と release の 3 個が、Node で Python と同じ結果を返す

**Independent Test**: `parity.test.ts` の `worktree-*`・`release-*` のシナリオが golden と一致する。
この PR で足した 7 個が登録され、登録済みの全部で `--check` の差が 0。振る舞いの項目 217 個（worktree 129、release 88）が vitest につながる

- [ ] T026 [P] [US1] `cli/commands/worktree.py` を `cli-node/src/commands/worktree.ts` に移し、`COMMANDS` に 4 個を足す。`worktree link` は `interactive: true` にする。CLI の上書き確認は今の対話のまま残す。
- [ ] T027 [P] [US1] `cli/commands/release.py` を `cli-node/src/commands/release.ts` に移し、`COMMANDS` に 3 個を足す。
  `resolve_release_target_repo` は、フェーズ 6 の同期が使う。`export` して、別のファイルから読めるようにする。
- [ ] T028 [US1] Python が書いた状態を Node が読む `worktree-add-ok-python-state` が、golden と一致することを確かめる。食い違えば `cli-node/src/infra/state-store.ts` と `config-store.ts` を直す。
- [ ] T029 [US1] 振る舞いの項目 217 個を、vitest のケースにつなぐ。置き場は `cli-node/tests/interface/worktree.test.ts` と `release.test.ts` である。
- [ ] T030 [US1] `export-interface.ts --check` を流し、登録済みの全部で `surfaces.mcp` 以外の差を 0 にする。

**Checkpoint**: 該当シナリオが全部一致する。この PR で足した 7 個が登録され、登録済みの全部で `--check` の差が 0。該当の項目 217 個が全部つながる

---

## Phase 6: User Story 1 — security sync と dependabot sync を移し、34 個をそろえる (Priority: P1)

**Goal**: 同期の 2 個（グループ `security` の `sync` と、グループ `dependabot` の `sync`）が Node で動き、registry が 34 個になる

**Independent Test**: `parity.test.ts` の全件が一致する。`security-sync-*`・`dependabot-sync-*` と、34 個がそろって初めて合う `global-*` の 7 件を含む。
registry の数が 34。`--check` が 34 項目で差 0（SC-010）。振る舞いの項目 769 個（共通の 17 個を含む）が全部 vitest につながる

- [ ] T031 [P] [US1] `cli/commands/security.py` を `cli-node/src/commands/security.ts` に移す。`COMMANDS` にグループ `security` の `sync` を足す。
  ツール名は `security_sync`、CLI は `pecot security sync` である。
  `_tracker_sync.py` の残り、`cli/core/security_alerts.py`、`cli/core/tracker_body.py` の `find_tracker`・`render_tracker_body` も移す。
  `cli/core/issue_board.py` の `create_issue`・`put_on_board` は、issue の移植と共有する。Node に既にあればそれを使う。
- [ ] T032 [P] [US1] `cli/commands/dependabot.py` を `cli-node/src/commands/dependabot.ts` に移す。`COMMANDS` にグループ `dependabot` の `sync` を足す。
  ツール名は `dependabot_sync`、CLI は `pecot dependabot sync` である。
  `cli/core/dependabot_prs.py` の要る分と、`resolve_release_target_repo`（`release.ts`）も使う。
- [ ] T033 [US1] 同期の 2 個の項目 90 個を、vitest のケースにつなぐ。置き場は `cli-node/tests/interface/security.test.ts` と `dependabot.test.ts` である。
- [ ] T034 [US1] `cli-node/src/commands/tests/registry.test.ts` にテストを足す。`COMMANDS` が 34 個であることと、ID が `interface/generated.json` の項目の ID と同じ集合であることを確かめる。
  グループ無しは 4 個（`add-to-project`・`update-issue-status`・`create-branch`・`delete-branch`）、残りはグループの下のコマンドである。
  移行の途中で Python のコマンドが増えたとき、Node への足し忘れを止めるのはこのテストである。
- [ ] T035 [US1] 34 個がそろった状態で、`global-*` の 31 件が golden と一致することを確かめる。`parity.test.ts` の `SCENARIOS_NEEDING_ALL_COMMANDS` の 7 件は、ここで初めて合う。
- [ ] T036 [US1] `export-interface.ts --check` を 34 個がそろった状態で流し、34 項目で差 0 件であることを確かめる。項目のつなぎの確認が 769 個で通ることも確かめる。

**Checkpoint**: 全件が一致し、registry が 34 個。`--check` が 34 項目で差 0。配布物は Python のまま

---

## Phase 7: User Story 2 — MCP サーバ (Priority: P2)

**Goal**: registry から 34 個の MCP ツールを公開する。プラグインにはまだ登録しない

**Independent Test**: `tools/list` が 34 個で定義書と一致する。MCP に写せるシナリオの全件（2026-11-11 の時点で 165 件）が、MCP 経由でも golden と一致する

- [ ] T037 [US2] `cli-node/package.json` に `@modelcontextprotocol/server` を足す。devDependencies には `@modelcontextprotocol/client` を足す。版は `plugins/pecot-tools/cli/package.json` と同じにする。
- [ ] T038 [US2] `cli-node/vitest.config.ts` の `cli` project の include に `tests/mcp/**/*.test.ts` を足す。`cli-node/tests/coverage-include.test.ts` に、`tests/mcp/` のテストが include に当たる確認を足す。
- [ ] T039 [US2] `cli-node/tests/mcp/tools-list.test.ts` を先に書く。ツールの数と名前が registry と一致することを確かめる。
  各ツールの入力が、定義書の同じ項目の `input` に `repo` を足したものと一致することも確かめる。コマンド定義の入力は、`export-interface.ts` の `normalizeInput` を通した形で比べる（`export` して使う）。
- [ ] T040 [US2] `cli-node/src/mcp/server.ts`・`serve.ts`・`result.ts` を作り、`COMMANDS` からツールを登録する。
  結果の形は次のとおり。
  - `content[0].text` は stdout
  - `isError` は `exitCode !== 0`
  - `structuredContent` は `{ exitCode, stdout, stderr }`
  `libs/interface-spec/targets.json` の `sources` に `cli-node/src/mcp/*.ts` を足す。`interface-spec:lint-defs` が通ることを確かめる。
- [ ] T041 [US2] `worktree_link` のテストを `cli-node/tests/mcp/worktree-link.test.ts` に書く。入力は定義書の `force` をそのまま使い、新しい入力は作らない。
  MCP ツールは標準入力を持たない。`force` が false で上書きの確認が要るときは、定義書の「入力の終端なら中止する」と同じ結果を返すことを確かめる。
- [ ] T042 [US2] `cli-node/src/cli.ts` に `mcp` サブコマンドを足し、stdio で MCP サーバを起動する。`mcp` はツールにしない。`--help` の一覧と、打ち間違いの候補には出さない。
  `global-*` の golden は変えず、`parity.test.ts` が通ることを確かめる。
- [ ] T043 [US2] `cli-node/tests/parity/parity.test.ts` に MCP 経由の起動を足す。各シナリオのツールを `@modelcontextprotocol/client` で呼び、golden と比べる。
  CLI の直接起動は全件（228 件）。MCP 経由は「MCP に写せるシナリオ」の全件で、次の 3 種を除く（2026-11-11 の時点で 63 件、残りは 165 件）。除く一覧と理由は `parity.test.ts` が持つ。
  `global-*` の 31 件。名前に `usage` を含むもののうち `global-*` 以外の 29 件（CLI の引数の誤り。MCP では入力の検証の誤りになる）。標準入力を使う `worktree-link-*-overwrite-confirmed`・`-declined`・`-eof` の 3 件。
  argv からツールの入力への写し方は、位置引数を `positional` の順に、フラグを名前の `-` を `_` にして渡す。比べる欄は、`structuredContent` の `stdout`・`stderr`・`exitCode` と、golden の `requests`・`files` である。
  時間のかかる `release_*` も完了まで待つ。入力の検証の誤りは、ツール一覧のテストが受け持つ。

**Checkpoint**: MCP に写せるシナリオの全件が MCP 経由でも一致する。プラグインの `.mcp.json` は変えていない

---

## Phase 8: User Story 3 — hooks のガード (Priority: P3)

**Goal**: 投稿の ask を MCP ツールで判定する。Bash の `pecot` の deny の判定を用意する。どちらも、配布物の振る舞いはまだ変えない

**Independent Test**: 今の確認・阻止の条件が、MCP の入力 JSON で同じ判定と文言になる。2 つのクライアントの名前の形で通る。34 個のツール名にない名前（playwright など）は判定しない

- [ ] T044 [P] [US3] `cli-node/tests/hooks/pecot-post-ask.test.ts` を先に書く。ツール名は、2 つのクライアントの形の両方で流す。
  Claude Code は `mcp__plugin_pecot-w_pecot-workflow__<tool>`、Copilot CLI は `pecot-workflow-<tool>` である。
  `issue_create`・`issue_quick` は ask を返す。`tool_input.prepare == true`、スラッシュコマンドのフラグ、config キーが false のどれかがあれば素通し。
  `pr_create` は ask を返す。`prepare` か `dry_run` が true、フラグ、config キーが false のどれかがあれば素通し。文言は今の `pecot-issue-create-ask`・`pecot-pr-create-ask` と一致させる。
  取り出した名前が 34 個のツール名にないとき（`pecot-workflow-playwright-browser_click` など）は判定しないことも確かめる。
- [ ] T045 [US3] `hooks/lib/mcp-handlers/pecot-post-ask.sh` を作る。`PECOT_HOOK_TOOL_NAME` から `<tool>` を取り出し、34 個のツール名にあるときだけ判定する。`tool_input` を jq で読む。
  `mcp-dispatcher.sh` からは、`pr-create-block.sh`（deny）の後、`context7-allow.sh`（allow）の前に呼ぶ。
  `mcp-dispatcher.sh` を変えるので、既存の pytest（`hooks/tests/test_pre_mcp.py` など）も同じ PR で直す。
- [ ] T046 [P] [US3] `cli-node/tests/hooks/pecot-cli-deny.test.ts` を先に書く。定義書にある 34 コマンドの起動形のそれぞれで deny になり、理由に対応するツール名が入ることを確かめる。
  起動形は、セグメントの先頭が `pecot`・`$PECOT`・`"$PECOT"`・`bin/pecot` のフルパス・クオート付きのパスのどれかである。`pecot issue read` なら理由に `issue_read` が入る。
  サブコマンドが分からない形（`pecot` だけ、`pecot --help`）は deny とし、理由に MCP ツールの一覧を使うよう書く。
- [ ] T047 [US3] `hooks/lib/core/pecot-cli-deny.sh` を作る。セグメントの分け方と起動形の見つけ方は、`external-post-check.sh` の処理を使う。サブコマンド別の許可・阻止は持たない。`pre-tool-use-bash.sh` からはまだ呼ばない。
- [ ] T048 [P] [US3] 案内文の移行後の文を `hooks/lib/core/mcp-guidance.sh`（新規）に用意する。
  文は `cli-node/tests/hooks/mcp-guidance.test.ts`（新規）で固定する。どのスクリプトからもまだ読まない。
  案内文を持つ箇所は次の 6 つ。
  - `hooks/lib/core/gh-command-check.sh`（54・66〜67 行）は、`pr_create`・`issue_quick`・`issue_create` で案内する
  - `hooks/lib/core/git-worktree-branch-check.sh`（85 行）は、`delete_branch` で案内する
  - `hooks/lib/pre-tool-use/pecot-issue-pending-reminder.sh`（43〜60 行）は `issue_quick`・`issue_create` で案内する
  - `hooks/lib/core/external-post-check.sh` の `GH_MSG` は、`pecot pr cleanup` を `pr_cleanup` に替える
  - `hooks/templates/exit-plan-comment-update.md` は、`issue_comment` で案内する
  - `hooks/README.md` の記述
  `ISSUE_MSG`・`CREATE_MSG` はフェーズ 11 で外す。ask の文は `pecot-post-ask.sh` に移す。

**Checkpoint**: 新しい判定のテストが通る。今の Bash の判定と案内文は変わっていない。`.mcp.json`・`bin/pecot`・`skills/` に差分が無い

---

## Phase 9: User Story 3 — Copilot CLI でのツール名を実物で確かめる (Priority: P3)

**Goal**: Copilot CLI が MCP ツールに付ける名前と hooks の入力を実物で採る。research R-5 の推定を確かめる

**Independent Test**: 実物のツール名が contracts/hooks-guard.md の形と一致する。違えば、直した後にフェーズ 8 の投稿の ask のテストが通る

- [ ] T049 [US3] 開発用の登録で、GitHub Copilot CLI から MCP サーバを起動する。`build-cli` の後に、`node <作業ツリー>/plugins/pecot-workflow/cli-node/dist/cli.js mcp` を直接起動する形で登録する。
  `bin/pecot` はフェーズ 11 まで Python を起動するので使わない。`project_info` を呼ぶ。
  PreToolUse の hooks が受ける JSON は、開発用の一時の matcher（`.*`）で採り、`.pecot/work/<Issue番号>/` に保存する。採り終えたら matcher を戻す。
- [ ] T050 [US3] 採ったツール名が `pecot-workflow-<tool>` と違えば、`hooks/lib/mcp-handlers/pecot-post-ask.sh` の取り出しを直す。contracts/hooks-guard.md、data-model.md、投稿の ask のテストの名前も直す。
  同じなら、確かめた日付と Copilot CLI の版を research.md の R-5 に書く。

**Checkpoint**: Copilot CLI の名前の形が確定している。`.mcp.json`・`bin/pecot`・`skills/` に差分が無い

---

## Phase 10: User Story 4 — hooks のテストを vitest に移す (Priority: P4)

**Goal**: hooks の pytest を vitest の `hooks` project に移す

**Independent Test**: 移した pytest のケースのすべてに、対応する vitest のケースがある。件数は、移行元のケースとの対応でファイルごとに比べる。起動スクリプトの一覧が `baseline.json` の `hooks.scripts` を全部含む

- [ ] T051 [P] [US4] `hooks/tests/` の pytest（27 ファイル）を、vitest で `cli-node/tests/hooks/` に移す。
  shell は `child_process.spawnSync` で起動し、stdin・env・終了コード・stdout を確かめる。今の pass 2 の条件（空の設定と `GIT_DIR` の export）も残す。
- [ ] T052 [P] [US4] `hooks/lib/tests/` の pytest（35 ファイル）を、同じ方法で移す。
- [ ] T053 [US4] 移したファイルごとに、pytest のケースと vitest のケースの対応を作り、件数を比べる。対応表は `.pecot/work/<Issue番号>/` に残す。
  比べるのは、pytest の JUnit と vitest の JUnit（`cli-node/test-results/junit-hooks.xml`）である。`scripts/ci/compare_junit.py` を使うなら、ケース名をそろえて移す。
  フェーズ 8 が足した新しいケースは、`baseline.json` の `hooks.testCount`（1,569 件）との比較から除く。
- [ ] T054 [US4] `cli-node/tests/hooks/baseline-scripts.test.ts` に確認を足す。テストが起動するスクリプトの一覧が `hooks.scripts` を全部含むことを見る。消したスクリプトは除く。
  `test-hooks` レーンは、移行中は pytest と vitest の両方を流す。直す先は `project.json` と `scripts/ci/run-tests.sh` である。

**Checkpoint**: vitest だけで hooks の全ケースが流れる。移行元の全ケースに対応が付いている。pytest もまだ残っている。`.mcp.json`・`bin/pecot`・`skills/` に差分が無い

---

## Phase 11: 切り替え — Node・MCP・Agent Plugins 1.0・定義書の元を 1 回で切り替える (Priority: P2〜P4)

**Goal**: スキル・hooks・CLI・manifest・定義書の書き出しの元をそろえて切り替える。利用者に届く振る舞いを変えるのは、この PR だけ

**Independent Test**: エージェントに Bash で `pecot` を呼ばせる記述が 0 件。`interface/generated.json` の差分が各項目の `surfaces.mcp` だけ。
`claude --plugin-dir plugins/pecot-workflow` と GitHub Copilot CLI で、quickstart.md の CUJ 1〜7・9・10 が通る

- [ ] T055 [P] [US2] `cli-node/tests/skills/tool-names.test.ts` を先に書く。本文にある MCP ツール名が全部 `COMMANDS` にあることを確かめる。対象はスキル・agents・hooks テンプレートである。
  `pecot <サブコマンド>` の残りが、テストの持つ一覧と同じであることも確かめる。一覧に載せるのは、利用者が端末で打つコマンドの説明だけである（research R-19）。
  `cli-node/vitest.config.ts` の `cli` project の include に `tests/skills/**/*.test.ts` を足す。`tests/coverage-include.test.ts` に、`tests/skills/` が include に当たる確認を足す。
- [ ] T056 [P] [US2] `test-skills` レーンを vitest に替える。次の pytest を vitest に移す。
  - `scripts/ci/tests/test_*.py` の 5 本（`test-skills` の本体）
  - `skills/w-onboarding/scripts/tests/` の pytest
  直す先は `project.json` と `scripts/ci/run-tests.sh` である。
- [ ] T057 [P] [US1] bootstrap の shell のテストを流す `test-bootstrap` レーンを、pecot-tools と同じ形で足す。足すものは 5 つある。
  `project.json` の `test-bootstrap` target。`test` target の dependsOn。`scripts/ci/run-tests.sh` の `bootstrap` scope。
  `.githooks/tests/test_nx_affected_mapping.py` の対応表。root の `CLAUDE.md` のレーンの表。
- [ ] T058 [US2] スキルなどの `pecot <サブコマンド>` を、MCP ツールの呼び出しに書き換える。対象は 28 ファイル 202 箇所のうち、エージェントに実行させる記述である。
  数え方は research.md の R-19 の式を使う。コードブロックの外でも、手順として実行を指示する文は対象にする。
  内訳は `skills/*/SKILL.md` 15 ファイル 91 箇所、`skills/*/references/` 11 ファイル 109 箇所。`agents/` と `hooks/templates/` が各 1 ファイル 1 箇所。`$PECOT` の形は 0 箇所。
  `skills/w-help/references/commands.md` は手で直さない。
  `skills/w-pr/SKILL.md` の frontmatter の `allowed-tools` にある `Bash(*/bin/pecot ...)` は、MCP ツールの名前に替える。
  `agents/w-e2e-planner.md:57` の `"${CLAUDE_PLUGIN_ROOT}/bin/pecot" issue create --prepare` も、`issue_create`（`prepare: true`）に替える。
- [ ] T059 [US3] `hooks/pre-tool-use-bash.sh` から `lib/core/pecot-cli-deny.sh` を呼ぶ。`lib/core/external-post-check.sh` の pecot の判定を外し、`gh pr merge` の ask だけを残す。
  案内文は、`hooks/lib/core/mcp-guidance.sh` の文に差し替え、古い文を消す。対象はフェーズ 8 で用意した 6 か所である。
  `external-post-check.sh` の `ISSUE_MSG`・`CREATE_MSG` は外し、ask の文は `pecot-post-ask.sh` に移す。テストを同じ変更に合わせる。
- [ ] T060 [US3] hooks に Bash の `pecot` の実行が無いことを、`git grep` で確かめる。
  式は `git grep -nE '(bin/pecot|\$PECOT|"\$PECOT")' -- 'plugins/pecot-workflow/hooks/**/*.sh'` である。
  2026-11-11 の時点では、コメントと案内文に出るだけで、実行する処理は無い。結果は PR の本文に書く。
- [ ] T061 [US1] `bin/_lib.sh` に、pecot-tools の `bin/_lib.sh` から `plugin_runtime_*` と Node の下限の確認を写す。`bin/pecot` は実行用ミラー方式に書き換える。`PECOT_BOOTSTRAP_SKIP=1` は `cli-node/dist/cli.js` を直接起動する。
- [ ] T062 [US1] 初回起動で `${DATA}/venv/` を消す処理を `bin/pecot` に入れる。`.inuse` のロックを持つ世代は、次回の起動で消す。
- [ ] T063 [P] [US1] `plugins/pecot-tools/cli/tests/bootstrap/` から 3 本を `cli-node/tests/bootstrap/` に写す。
  3 本は `data-dir.sh`・`run.sh`・`stub-root.sh`。Python と uv の無い `PATH` で、初回起動がミラーを作ることを確かめる。古い venv が消えることと、Node が無いと理由を返して止まることも確かめる。
- [ ] T064 [US2] `.mcp.json` に `pecot-workflow` を足す。`command` は `${CLAUDE_PLUGIN_ROOT}/bin/pecot`、`args` は `["mcp"]` である。context7 と `pecot-workflow-playwright` は残し、`env` は書かない。
- [ ] T065 [US2] root に `plugin.json` と `mcp.json` を置く。`plugin.json` は `$schema` 1.0.0、name `pecot-w` である。
  `mcp.json` は `pecot-workflow`・context7・`pecot-workflow-playwright` の 3 つを持つ。Copilot CLI の matcher `pecot-workflow-.*` が playwright のツールにも当たるので、hooks は 34 個のツール名にあるときだけ判定する。
- [ ] T066 [US2] `hooks/hooks-copilot.json` を `com.github.copilot/hooks/hooks.json` に移す。matcher に `pecot-workflow-.*` を足す。
  agents を `com.github.copilot/agents/` に置く。`plugins/pecot-workflow/.github/plugin/plugin.json` と `hooks/hooks-copilot.json` を消す。
- [ ] T067 [US2] `cli-node/tests/bootstrap/manifest.sh` を作る。中身は `plugins/pecot-visual/cli/tests/bootstrap/manifest.sh` と同じ確認にする。両形式の name・version・MCP サーバと args の一致を固定する。
- [ ] T068 [US2] `project.json` の `release.version.manifestRootsToUpdate` を直す。`plugins/pecot-workflow/.github/plugin` の指定を `{projectRoot}` に替える。
  `.nx/nx-release/src/version-actions.js` とそのテストの、旧形式の参照も直す。
- [ ] T069 [US1] `cli-node/scripts/export-interface.ts` に `--write` を実装し、`interface/generated.json` を Node から書く。
  `--check` は、全部の項目の全部の欄を比べるように替える。定義書にあって Node に無い ID も失敗にする。差の表示は `formatStale` を使う。
  `generated.json` の差分が各項目の `surfaces.mcp` だけであることを確かめる。`origin/main` の `generated.json` と、今の `generated.json` を比べる。
  どちらにも `jq -S 'del(.entries[].surfaces.mcp)'` をかけて `diff` に渡し、出力が空になることを見る。
  `input` か `cli` に差が出たら、コマンド定義の側を直す。
- [ ] T070 [US1] `scripts/interface/export.py` と `cli/tests/unit/test_interface_export.py` を消す。`cli-node/tests/interface-export/typer-sample.json` と、それを読むテストも消す。
  `libs/interface-spec/tests/sample-files.test.ts` と、`libs/interface-spec/project.json` の `test-unit` の inputs の、`typer-sample.json` の参照も外す。
  `scripts/ci/run-lint.sh` と `cli/pyproject.toml` の `scripts/interface` の参照も外す。`project.json` の `test-py`・`lint-py` の inputs から、消したパスを外す。
- [ ] T071 [US1] `libs/interface-spec/targets.json` の pecot-workflow の `sources` から、Python の 4 つを外す。
  4 つは `cli/commands/**/*.py`・`cli/core/**/*.py`・`cli/__init__.py`・`cli/__main__.py` である。
  `libs/interface-spec/project.json` の `lint-defs` の inputs も、`sources` に合わせて直す。`interface-spec:lint-defs` が通ることを確かめる。
- [ ] T072 [US1] SC-009 を計る。同じ端末で続けて、切り替えの前の `bin/pecot`（Python）と後の `bin/pecot`（Node のミラー）で、`project info` の起動から結果までを 5 回ずつ計る。初回の準備は数えない。
  接続先は偽の GitHub サーバ（`PECOT_GITHUB_API_URL` をループバックに向ける）にする。2 つの中央値を、PR の本文と `.pecot/work/<Issue番号>/` に残す。Node が Python 以下であることを確かめる。
- [ ] T073 version plan に、Node と MCP への切り替えを書く。旧形式の manifest の削除も書く。Python と uv が要らなくなったことも書く。
- [ ] T074 quickstart.md の CUJ 1〜7・9・10 を、CUJ ごとの表のクライアントで実行する。結果は `.pecot/work/<Issue番号>/` に残す。
  Claude Code は `claude --plugin-dir plugins/pecot-workflow` で起動する。
  CUJ 6 の更新と実投稿の確認は、リリースの後に人が確かめる。PR の本文に、確かめる手順と、リリースの後に確かめることを書く。

**Checkpoint**: 切り替えの版を出せる。定義書は Node の実装を写している。Python の CLI とテストはまだ残っている。`--plugin-dir` での CUJ が通る。リリースの後に人が確かめる分は、CUJ 6 の更新と実投稿

---

## Phase 12: User Story 4 — Python を消し、cli-node を cli に移す (Priority: P4)

**Goal**: pecot-workflow に Python の CLI・テスト・レーンが残らない。定義書の仕組みも Python を読まない

**Independent Test**: Python と pytest の無い環境で、pecot-workflow の全レーンが通る。カバレッジが 91.0 以上。quickstart.md の「走査」で、Python の残りが 0 件。
`interface-spec:lint-defs` に `has no test` の行が無い（SC-011）。`git ls-files 'plugins/pecot-workflow/**/*.py'` が 0 件。`git grep -n cli-node` の該当が、`specs/` と CHANGELOG を除いて 0 件

- [ ] T075 [US4] `cli/` の Python を消す。対象は `commands/`・`core/`・`tests/`・`pyproject.toml`・`uv.lock`・`__init__.py`・`__main__.py`・`py.typed` である。`cli/templates/` は Node の CLI が読むので残す。
- [ ] T076 [US4] ID を持たない pytest を、1 本ずつ移すか消すかを決める。対象は次の 6 本。
  - `cli/tests/unit/test_architecture.py`・`test_doc_reference_integrity.py`・`test_english_only.py`
  - `cli/tests/unit/test_skill_docs.py`・`test_template_rules.py`
  - `cli/tests/ci/test_run_tests_locked.py`
  スキルとテンプレートの文書を確かめるものは vitest に移す。Python の構成だけを確かめるものは消す。決めた結果を PR の本文に書く。
- [ ] T077 [US4] hooks とスキルの pytest を消す。対象は次のとおり。
  - `hooks/tests/`・`hooks/lib/tests/`・`hooks/conftest.py`
  - `skills/w-onboarding/scripts/tests/` の Python
  - `scripts/ci/tests/test_*.py` の 5 本
- [ ] T078 [US4] Python のソースを読む Node のテスト 3 つを、固定の期待値に置き換える。
  対象は次の 3 つ。
  - `cli-node/src/infra/github/tests/queries.test.ts`（`cli/core/github/queries.py` を読む）
  - `cli-node/tests/fake-github/server.test.ts`（同じ `queries.py` を読む）
  - `cli-node/tests/parity/scenario.test.ts`（`cli/commands/main.py` を読む）
  `project.json` の `test-cli` の inputs からも、`cli/core/github/queries.py` と `cli/commands/main.py` を外す。
- [ ] T079 [US4] `cli-node/tests/python-output/record.py` を消す。`record.ts` と `record:parity*` のスクリプトも消す。
  golden、`tests/output/cases.json`、`tests/python-output/` の JSON は、Node の回帰テストの期待値として残す。
- [ ] T080 [US4] `cli-node/` を `cli/` に移す。`project.json` の inputs と `--filter`、`bin/pecot`・`bin/_lib.sh` のパスを直す。`pnpm-workspace.yaml`、knip と ESLint の設定、`vitest.config.ts` の参照も直す。
- [ ] T081 [US4] `project.json` から `test-py` と `lint-py` を外し、`test` と `lint` の dependsOn を直す。
  `scripts/ci/run-tests.sh` と `run-lint.sh` から py と pytest を外す。`scripts/ci/python-version.sh` と `compare_junit.py` を消す。
- [ ] T082 [US4] `libs/interface-spec/targets.json` の pecot-workflow を、移した後のパスに直す。`sources` は `cli/src` の分けた glob にする。`tests` は `cli/tests/**/*.ts`・`cli/src/**/tests/**/*.ts` にする。
  `libs/interface-spec/project.json` の `lint-defs` の inputs も、`sources` と `tests` に合わせる。
  `libs/interface-spec/docs/conf.py` の `iface_junit` は、`cli/test-results/junit.xml`（Node）と `cli/test-results/junit-hooks.xml` の 2 本にする。
- [ ] T083 [US4] `interface-spec:lint-defs` を流し、振る舞いの項目 769 個が全部つながることを確かめる（SC-011）。`libs/interface-spec/README.md` の手順で定義書の HTML を作り、Python を読まずに出来ることも確かめる。
  同じ README の手順 `nx run-many -t test-py test-cli test-hooks` も、今のレーンに直す。
- [ ] T084 [US4] `nx.json` の `pecotPluginTestGlobals` / `pecotPluginLintGlobals` から、uv と Python の参照を外す。
  外すのは runtime 入力、`cli/pyproject.toml`、`cli/uv.lock`、`python-version.sh` である。代わりに `pnpm-lock.yaml` などの Node の入力を足す。
- [ ] T085 [US4] プラグインの外の `cli-node`・`test-py`・`lint-py`・`python-version.sh` の参照を直す。
  `.githooks/project.json`、`.githooks/pre-push/check-text-push.sh`、`.gitignore`、`.pre-commit-config.yaml`（ruff の `--config` と `check-nx-env-inputs` の files）。
  `.githooks/tests/` の `test_nx_affected_mapping.py`・`test_nx_task_cache.py`・`test_python_range_parity.py`・`test_nx_env_inputs.py`・`test_pre_commit_config_wiring.py`・`test_gen_runtime_lock.py`・`representative-files.txt`。
  `plugins/pecot-visual/cli/tests/bootstrap/lib-consistency.sh`、`plugins/pecot-visual/scripts/ci/check-pm-guard.sh`、`libs/interface-spec/tests/sample-files.test.ts`（`node-sample.json` のパス）。
  `.claude/rules/test-conventions.md`、`plugins/pecot-workflow/runtime-workspace.yaml`。
- [ ] T086 [P] [US4] `.github/dependabot.yml` から uv（`/plugins/pecot-workflow/cli`）のエントリを消す。ファイル先頭の uv についての説明も消す。
- [ ] T087 [US4] `.specify/memory/constitution.md` の `cli-node/` と pytest の閾値の記述は、憲章の変更にあたる。利用者に確認してから直す。確認が取れるまでは直さず、PR の本文に確認待ちと書く。

**Checkpoint**: Python なしで全レーンが通る。つながらない項目が 0 件。着手の時点の `authored.yaml` と、項目の ID と文に差が無い。Python と uv の無い環境の作り方は quickstart.md を指す

---

## Phase 13: User Story 5 — npm の単体配布を始める (Priority: P5)

**Goal**: リリースのたびに、`@pecot/workflow-mcp` を npm へ出す

**Independent Test**: dry-run の配布ツリーを `npx` で起動し、34 個のツールが使える

- [ ] T088 [US5] `plugins/pecot-tools/scripts/release/` のスクリプトとテストを `scripts/release/` に写す。
  写すのは `publish-mcp-dist.sh`・`finalize-dist.mjs`・`mcp-dist-README.md`・`tests/` の 4 つ。パッケージ名は `@pecot/workflow-mcp`、bin は `bin/pecot-workflow-mcp.mjs` にする。
- [ ] T089 [US5] 配布の README に、hooks のガードが無いことを書く。投稿の確認は MCP クライアント自身に任せることも書く。置き場は `scripts/release/mcp-dist-README.md` である。
- [ ] T090 [US5] `project.json` の `nx-release-publish` を publish スクリプトに置き換え、`test-release` レーンを足す。冪等性は pecot-tools と同じく、HEAD の `pecot-workflow-v<version>` タグで判定する。
  `test-release` に足すものは 5 つある。`project.json` の `test-release` target。`test` target の dependsOn。`scripts/ci/run-tests.sh` の `release` scope。
  `.githooks/tests/test_nx_affected_mapping.py` の対応表。root の `CLAUDE.md` のレーンの表。
- [ ] T091 [US5] `.github/workflows/publish-npm.yml` のタグの形と説明に、`pecot-workflow-v<version>` を足す。このタグを `@pecot/workflow-mcp` に解決させる。
- [ ] T092 [US5] dry-run の配布ツリーを `npx` で起動し、34 個のツールが見えることを確かめる。結果は `.pecot/work/<Issue番号>/` に残す。
- [ ] T093 [US5] npm 側の trusted publisher の設定手順を PR の本文に書く。利用者の設定は PR の外で待つ。

**Checkpoint**: PR の合否は、dry-run の配布ツリーで 34 個のツールが使えること。リリースの後に確かめることは 2 つある。リリースで `@pecot/workflow-mcp` が npm に出ること。プラグインの無い MCP クライアントで、quickstart.md の CUJ 8 が通ること

---

## Phase 14: Polish — 文書と関連 Epic への引き渡し

**Purpose**: 移行の結果を文書と関連 Epic に反映する

- [ ] T094 [P] `plugins/pecot-workflow/` の `README.md` と `CONTRIBUTING.md` から、Python と uv の前提を消す。MCP ツールの使い方と、単体配布の登録を書く。
  root の `README.md` に、pecot-workflow の Python と uv の前提があれば、同じように直す。
- [ ] T095 [P] `CLAUDE.md` のリポジトリ構成の表から `test-py` を外し、pecot-workflow のレーンを今の形に直す。`.githooks/README.md` に Python のレーンの記述があれば、同じに直す。
- [ ] T096 Epic #41 に、pecot-workflow の manifest と準拠範囲が片づいたことをコメントする。#41 の本文は書き換えない。
- [ ] T097 quickstart.md を最初から最後まで実行し、SC-001〜SC-011 の結果を `.pecot/work/<Issue番号>/` に残す。

---

## Dependencies & Execution Order

### フェーズの依存

| フェーズ | 始められる時期 |
|---|---|
| 1 | 最初 |
| 2〜5（US1） | 1 の後。互いに独立で、並べて進めてよい |
| 6（US1） | 2〜5 の後（3 と 5 の関数を使い、34 個がそろったことを確かめるため） |
| 7（US2） | 6 の後 |
| 8（US3） | 1 の後ならいつでも。7 と並べてよい |
| 9（US3） | 7 と 8 の後 |
| 10（US4） | 1 の後ならいつでも。8 が `mcp-dispatcher.sh` を変えたときは、既存の pytest も 8 の PR で直す |
| 11（切り替え） | 2〜10 が全部終わってから |
| 12（US4） | 11 の後 |
| 13（US5） | 12 の後 |
| 14 | 最後 |

フェーズ 2 と 3 は、別のファイル（`repo.py` と `issue.py`）を移すので重ならない。

### ユーザーストーリーの依存

| ストーリー | 依存 |
|---|---|
| US1 | 単独で確かめられる（前後比較と定義書） |
| US2 | US1 に依存する。registry が 34 個そろってから MCP を作る |
| US3 | 判定は US1・US2 と独立に作れる。発火するのは切り替えの後 |
| US4 | hooks のテストの移行は独立。Python の削除は切り替えの後 |
| US5 | US4 の後 |

## Parallel Example

```text
# Phase 1 の後、次を並べて進められる
Phase 2: T010 project.ts / T011 repo.ts
Phase 3: T016〜T017 issue.ts / T018 session.ts
Phase 4: T022〜T023 pr.ts
Phase 5: T026 worktree.ts / T027 release.ts
Phase 6: T031 security.ts / T032 dependabot.ts
Phase 8: T044〜T048 hooks のガード
Phase 10: T051 hooks/tests の移行 / T052 hooks/lib/tests の移行
```

並べて進めるフェーズは、`registry.ts` の `COMMANDS` で重なる。後から入る PR が rebase で取り込む。

## Implementation Strategy

### MVP

MVP は Phase 1〜6（US1）とする。Node の CLI が、前後比較の全件と定義書の 34 項目で Python と一致すれば、以降のフェーズはこの結果の上に積める。
配布物はまだ Python のままで、利用者への影響は無い。

### 増やし方

1. Phase 1〜6 で、Node の CLI がそろい、振る舞いの項目が全部 vitest につながる
2. Phase 7〜10 で、MCP サーバ・hooks の判定・Copilot CLI の名前・hooks のテストがそろう。配布物は変わらない
3. Phase 11 で、1 回の PR とリリースで切り替える。定義書の書き出しの元も Node に替わる
4. Phase 12〜13 で、Python を消し、単体配布を始める
5. Phase 14 で、文書を片づける

## Notes

- 旧 sub-issue #17〜#27 を not planned で close する作業（spec FR-017）は、2026-11-05 に済んだ。

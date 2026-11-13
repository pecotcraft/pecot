---

description: "Issue の着手の可否を依存関係から判定し、前提が PR 中なら stacked PRs として積んで進める のタスク一覧"
---

# Tasks: Issue の着手の可否を依存関係から判定し、前提が PR 中なら stacked PRs として積んで進める

**Input**: `specs/024-issue-readiness-stacked-prs/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、quickstart.md と、contracts/ の 3 つの文書

**Tests**: 憲法 II（TDD）を守る。判定・進め方・列を直す判断・本文の節の読み書きは、入力の組を表にした失敗するテストを先に書き、失敗を確かめてから実装する。期待は、判定の値・理由の文字列・出力の行・API に渡す値で比べる。モックは HTTP と git の境界だけに使う。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの番号は plan.md の「実装の段階と PR」の段階と同じ。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US9） |

パスはリポ root 起点で書く。`plugins/pecot-workflow/` は `p-w/` と略す。
`p-w/cli/` は、spec 020 の T080 が `cli-node/` を移した後の Node の CLI を指す。

## 着手の条件

- Epic #42 の Python の削除（#351）が main に入っている。入る前は、新しいクエリを足すと Python との一致のテストが落ちる
- 検証用のリポとボードが用意されている（Phase 1 の T001）

## 全フェーズに共通の完了条件

- pre-commit を `--no-verify` なしで通す
- 前提の付いていない Issue だけを使うときの、既存のコマンドの出力と終了コードを変えない
- 新しい出力は、既存の共通の関数（`p-w/cli/src/commands/output.ts`）を通した英語の行にする。データは stdout、それ以外は stderr に出す
- 判定と列を直す判断は `p-w/cli/src/domain/` に置き、I/O を持たせない
- コマンドを足すフェーズは、次の 4 つを同じ PR で済ませる
  - `p-w/cli/scripts/export-interface.ts --write` で `p-w/interface/generated.json` を書き出し直す
  - `p-w/interface/authored.yaml` に項目を書く。振る舞いの項目を確かめるテストに `verifies` を付ける
  - `p-w/skills/w-help/references/commands.md` を生成し直す
  - コマンドの数を固定している 5 か所を直す
    - `p-w/cli/src/commands/tests/registry.test.ts`
    - `p-w/cli/tests/parity/commands.ts`
    - `p-w/cli/tests/hook-tool-names.test.ts`
    - `p-w/cli/tests/hooks/pecot-cli-deny.test.ts`
    - `p-w/hooks/lib/core/pecot-tool-names.sh`
- 既存のコマンドの振る舞いを変えるフェーズは、`p-w/interface/authored.yaml` を直す。直すのは `details`・`exit_status`・振る舞いの項目で、テストに `verifies` を付ける
- 新しいクエリを足すフェーズは、`p-w/cli/tests/fake-github/operations.ts` に行を足す
- スキルの文での pecot の呼び出しは、Epic #42 の切り替えの後の書き方（MCP のツール名）に合わせる。contracts の CLI の形を、そのまま写さない
- 配布物が変わるフェーズは、version plan を `.nx/version-plans/` に足す。CHANGELOG は手で編集しない
- 各テストのカバレッジの閾値を下げない（憲法 III）
- テストの後に、足したコマンドを検証用のリポで動かし、出た行を PR に貼る（憲法 II）

---

## Phase 1: 書き込まないと確かめられない点を確かめる

**Goal**: research.md の R14 の 8 つの点に、実物の結果が付いている。見込みと違った点は、設計の直し方が決まっている

**Independent Test**: research.md の R14 の表のすべての行に、結果と、確かめた日が書かれている

- [x] T001 検証用のリポとボードを用意する。組織の下にリポを 1 つ作り、squash のマージと開発ブランチの ruleset をこのリポと同じにする。Projects のボードを作り、`pecot project create` で初期化する。作る前に、利用者の同意を得る
- [x] T002 [P] 既定の Status に、`updateProjectV2Field` で選択肢を 1 つ足す。既存の選択肢を `id` 付きで送り、カードの値が残ることを見る。足した後に PR を 1 本マージし、既定の自動化が札を `Done` にすることを見る
- [x] T003 [P] 進行の欄の選択肢を、`Backlog` と `Ready` の間に 1 つ差し込む。ボードの列が、渡した順に並ぶことを見る（API の順まで確かめた。画面の列の順は未確認で、quickstart の準備で確かめる）
- [x] T004 [P] `addBlockedBy` で、同じリポと別のリポの Issue を前提に付ける。輪になる組を付けたときの応答を記録する。REST の DELETE と `removeBlockedBy` の両方で外し、通るほうを記録する
- [x] T005 [P] 2 段の PR を作り、`POST /repos/{owner}/{repo}/stacks` でスタックに登録する。上の段の PR の `closingIssuesReferences` が作られるかを記録する
- [x] T006 2 段のスタックの下の段を、`PUT .../pulls/{n}/merge-async` でマージする。結果の読み方と、終わるまでの時間を記録する。上の段の PR の base とブランチの位置が、マージの後にどう変わるかを記録する
- [x] T007 T006 の後、上の段の手元のブランチで `git rebase --onto <開発ブランチ> <記録した古い base の位置>` を打つ。差分が上の段の変更だけになることを見る
- [x] T008 merge queue を有効にしたブランチで、T006 と同じマージを打つ。キューに入るかを記録する
- [x] T009 結果を `specs/024-issue-readiness-stacked-prs/research.md` の R14 の表に書く。見込みと違った点は、R14 の「外れたとき」の設計に合わせて、該当の R と contracts を直す

**Checkpoint**: 後ろのフェーズが、確かめた事実の上で実装できる

---

## Phase 2: 前提の読み書きと、着手の判定の関数

**Goal**: Issue の前提を GitHub から読み書きでき、着手の判定・進め方・輪の確認が、I/O を持たない関数として使える

**Independent Test**: data-model.md の 3 の判定の表と、4 の進め方の表の、すべての行に当たる入力でテストが通る。偽の GitHub サーバに対して、前提の追加・解除・読み取りが、決めた形の要求を送る

- [x] T010 [P] `p-w/cli/src/domain/tests/readiness.test.ts` に、着手の判定の失敗するテストを書く
  - data-model.md の 3 の表の 9 つの順を、1 行ずつ入力にする。区分・理由のコード・積む先・見直しが要るかを比べる
  - 順 7 は、前提の状態ごとに分ける。着手済みで PR が無い、未着手、PR が 2 本以上、fork からの PR、列が `Pending` の 5 つだ
  - 順 8 は、どの前提の PR から base をたどっても、ほかの前提に届かない組を入れる。間接の前提を挟む鎖と、開発ブランチに届かない鎖も入れる
  - 済んでいない前提が 3 件で 1 本の列に並ぶ組は `stackable` になり、積む先が最上段の head のブランチになる
  - 前提の札が `Needs Attention` のとき、理由とは別の注記にその前提が入り、区分は変わらない
  - Epic と Tracker は、判定を返さない
- [x] T011 [P] `p-w/cli/src/domain/tests/readiness.test.ts` に、進め方と積める並びの失敗するテストを書く
  - data-model.md の 4 の表の 4 つの進め方を、1 行ずつ入力にする
  - `merge` の前提があれば、ほかの前提の形にかかわらず「マージ待ち」になる
  - 枝分かれのある前提の形で、積める並びが 2 本に分かれて出る
  - quickstart.md の 1 の 5 つのフェーズを入力にし、期待の表と並びに合う
  - 輪のある入力で、輪になるキーの並びを返す
- [x] T012 [P] `p-w/cli/src/domain/tests/prerequisites.test.ts` に、本文の節の読み書きの失敗するテストを書く
  - 形は contracts/prerequisite-table.md の 3 のとおり。見出しは `## Waits for merge`、行は `- <参照>: <理由>`
  - 節の無い本文に行を足すと、末尾に節ができる。ほかの節は 1 文字も変わらない
  - 行を外して節が空になると、節ごと消える
  - 同じリポは `#N`、別のリポは `owner/repo#N` で書く
  - 形に合わない行が 1 つでもある節は、読めないものとして返す
- [x] T013 `p-w/cli/src/domain/readiness.ts` を足し、T010 と T011 を通す。判定・進め方・積める並び・輪の確認を置く。区分は `startable`・`stackable`・`blocked` の 3 つで、理由のコードは data-model.md の 3 の表の 7 つだ
- [x] T014 `p-w/cli/src/domain/prerequisites.ts` を足し、T012 を通す
- [x] T015 [P] `p-w/cli/src/infra/github/tests/` に、前提の読み書きの失敗するテストを書く
  - 追加は GraphQL の `addBlockedBy` で、`issueId` と `blockingIssueId` に node ID を渡す
  - 解除は GraphQL の `removeBlockedBy` で、追加と同じ node ID を渡す（Phase 1 の T004 で、REST とどちらも通った。research.md の R1）
  - 読み取りは `blockedBy(first: 50)` で、番号・リポ・状態・列・札・リンクしたブランチ・その PR を返す
- [x] T016 `p-w/cli/src/infra/github/queries.ts` と `p-w/cli/src/infra/github/issues.ts` に、前提の追加・解除・読み取りを足す。`p-w/cli/tests/fake-github/operations.ts` に行を足す
- [x] T017 `p-w/cli/src/infra/github/pulls.ts` に、Issue にリンクしたブランチを head に持つ PR の読み取りを足す。返すのは、番号・状態・head・base・ドラフトか・fork からかだ（research.md の R3）
- [x] T018 `p-w/cli/src/domain/readiness.ts` に、GitHub から読んだ値を「Issue の実態」にまとめる関数を足す
  - 形は data-model.md の 2 のとおり。済んだ・PR 中・着手の跡があるの 3 つの値を、表のとおりに決める
  - Issue の PR は、リンクしたブランチの PR と、閉じる参照の PR を合わせる
  - `p-w/cli/src/commands/` は、読んだ値を渡すだけにする
  - テストは `p-w/cli/src/domain/tests/readiness.test.ts` に書く

**Checkpoint**: 前提と判定が、コマンドから呼べる

---

## Phase 3: ボードの値の追加と、列の定義

**Goal**: `pecot project init` が、進行の欄に `Blocked`、既定の Status に `Needs Attention` を足す。値の無いボードでも設定の読み込みが通る。配布する列の説明が、`Pending`・`Blocked`・`Ready` の違いを書いている

**Independent Test**: `pecot project init` を 2 回打つ。1 回目で 2 つの値が足され、2 回目は何も足さない。カードの列と札が変わっていない。`Blocked` の無いボードでも、`pecot project info` が終了コード 0 を返す

- [x] T019 [P] `p-w/cli/src/commands/tests/` に、選択肢の追加の失敗するテストを書く
  - 今の選択肢を `id` 付きで全部読み、1 つ差し込んだ一覧を `updateProjectV2Field` に渡す
  - 渡す一覧の既存の選択肢が、どれも `id` を持つ。`id` の無い既存の選択肢があればテストが落ちる
  - `Blocked` は `Backlog` と `Ready` の間に入る。`Needs Attention` は末尾に入る
  - 値が既にあれば、mutation を呼ばずに `unchanged:` を出す
- [x] T020 [P] `p-w/cli/src/commands/tests/` に、値の無いボードの失敗するテストを書く。`Blocked` の無い進行の欄で、設定の検証が止まらない。既存の 6 つの値のどれかが無いときは、今までどおり終了コード 1 で止まる
- [x] T021 選択肢の追加と、既定の Status の読み書きを足す（research.md の R8）
  - 置き場は `p-w/cli/src/infra/github/queries.ts` と `p-w/cli/src/infra/github/projects.ts`
- [x] T022 `p-w/cli/src/commands/project-sync.ts` を直す
  - `WORKFLOW_FIELD_OPTIONS` に `Blocked` を足す。色は `Pending` と同じ GRAY、説明は英語で、前提を待つ Issue を pecot が置く列と書く
  - `Pending` の説明から「or blocked」を外す（FR-082）
  - `validateWorkflowField` は、`Blocked` を「あれば使う値」として扱う（research.md の R9）
  - `WORKFLOW_KEYS` と `buildBoardUrl` に `blocked` を足す
- [x] T023 `p-w/cli/src/domain/config.ts` に、`workflow.options.blocked` と `fields.status` を足す。キーは data-model.md の 5 の「設定ファイル」のとおりだ。`status` の無い設定は、今までどおり読める
- [x] T024 `p-w/cli/src/commands/project.ts` の `initializeFields` を直す。既にあるフィールドには足りない選択肢を足し、足した後に設定ファイルを同期する。出力は contracts/cli-commands.md の `pecot project init` のとおりだ
- [x] T025 [P] 状態の値を直書きしている場所に `blocked` を足す
  - `p-w/cli/src/commands/issue-shared.ts` の `VALID_STATUSES`
  - `p-w/cli/src/domain/format.ts` の `STATUS_PATTERNS` と `STATUS_ORDER`
  - `p-w/cli/src/commands/project-info.ts` の `DISPLAY_STATUSES`
  - `--status` の説明の 3 か所（`issue-project.ts` の 2 つと `issue-create.ts`）
- [x] T026 [P] 列の説明を直す（FR-065、FR-075）
  - `p-w/skills/w-help/references/board-status.md` に `Blocked` と `Needs Attention` を足す。`Ready` の用途を「着手できる」に直す
  - 同じファイルに、`Pending`・`Blocked`・`Ready` の違いを、置く理由・動かす者・出る条件の表で書く
  - `p-w/skills/w-help/references/spec-driven-workflow.md` と `p-w/skills/w-backlog/SKILL.md` の列の表を直す
- [x] T027 このリポのボードで `pecot project init` を打つ。`Blocked` の列が `Ready` の左にあることと、カードの列と札が前後で変わっていないことを、画面で確かめる。`.pecot/config/projects/` の設定の差分をコミットする
- [x] T028 version plan を `.nx/version-plans/` に足す

**Checkpoint**: ボードに `Blocked` と `Needs Attention` があり、設定ファイルから ID を引ける

---

## Phase 4: User Story 2 — 一覧と Issue の表示に判定が出て、一覧が列を直す (Priority: P1)

**Goal**: `pecot project info` が、`Ready` と `Blocked` の Issue に判定と理由を出し、列と札を判定に合わせて直す。`pecot issue read` が、前提の一覧と判定を出す

**Independent Test**: quickstart.md の 2・8・9・10 を通す。前提の状態が「済んだ」「PR 中」「未着手」の Issue が、順に `startable`・`stackable on`・`blocked by` と出る。手で動かしたカードが、`moved:` の行とともに戻る

- [ ] T029 [P] [US2] `p-w/cli/src/domain/tests/board-move.test.ts` に、列を直す判断の失敗するテストを書く
  - data-model.md の 6 の列の表の 8 行と、札の表の 3 行を、1 行ずつ入力にする
  - `Backlog`・`Pending`・`Archived` の Issue は、どの判定でも動かさない
  - 着手の跡がある Issue は、どの列にあっても、列と札を動かさない（FR-084）。判定が `blocked` のときは、食い違いを返す
  - `Blocked` の値が無いボードでは、動かす先を返さず、足りない値を返す
- [ ] T030 [US2] `p-w/cli/src/domain/board-move.ts` を足し、T029 を通す
- [ ] T031 [US2] `p-w/cli/src/commands/issue-board.ts` に、判定から列と札を動かす共通の処理を足す。動かしたときは `moved: #N <元> -> <先> (<理由>)` を出す。札は `set: Status of #N to <値>` を出す（FR-079、FR-083）
- [ ] T032 [P] [US2] `p-w/cli/tests/interface/project.test.ts` に、`project info` の失敗するテストを書く
  - `Ready` と `Blocked` の表に `Readiness` の列が出る。形は contracts/cli-commands.md の `pecot project info` のとおりだ
  - 判定と違う列にある Issue が動き、stderr に `moved:` が出る
  - 着手の跡が無い `Active` の Issue が、判定に合った列へ戻る
  - 着手の跡がある Issue は、判定が `blocked` でも列と札が変わらず、`warning:` が出る
  - 前提がマージされずに閉じられた Issue の札が `Needs Attention` になる
  - 判定の読み取りに失敗した Issue は `unknown` と出て、列が動かない
  - `Blocked` の値が無いボードでは、列が動かず、`warning:` に足し方が出る。終了コードは 0 だ
  - 前提の付いていない Issue だけのボードでは、`Readiness` の列がすべて `startable` で、列が動かない
- [ ] T033 [US2] `p-w/cli/src/commands/project-info.ts` と `p-w/cli/src/commands/project.ts` を直し、T032 を通す
  - 判定の計算は `mapWithLimit` で並べる
  - 同じ Epic の積める並びを `## Stackable chains` に出す（FR-051）
  - JSON の出力の各 Issue に `readiness` を足す
- [ ] T034 [P] [US2] `p-w/cli/tests/interface/issue.test.ts` に、`issue read` の失敗するテストを書く。`Blocked by:` と `Readiness:` の 2 行が出る。前提の無い Issue では出ない。本文の節と blocked by が食い違うときに `warning:` が出る
- [ ] T035 [US2] `p-w/cli/src/commands/issue-read.ts` を直し、T034 を通す。JSON の出力に `blockedBy` と `readiness` を足す
- [ ] T036 [US2] `project info` と `issue read` の定義書を直す。`p-w/interface/authored.yaml` の `details`・`effects`・振る舞いの項目に、判定の表示と列の移動を書く
- [ ] T037 [US2] 50 件の `Ready` と `Blocked` を持つボードで `pecot project info` を打ち、判定の分の増加が 5 秒以内であることを測る。超えるときは、前提の読み取りを 1 つのクエリにまとめる
- [ ] T038 [US2] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 画面で付けた blocked by が、一覧の判定とボードの列に出る

---

## Phase 5: User Story 1 — 一括投稿が前提を付け、進め方を示す (Priority: P1)

**Goal**: `pecot issue create` が、Issue ファイルの前提を blocked by として付け、判定に合った列へ置く。`--plan` が、進め方の表と積める並びを出す。タイトルの番号は通し番号だけになる

**Independent Test**: quickstart.md の 1 を通す。5 つのフェーズの Issue に、表の行と合う blocked by が付く。マージを待つ前提のある Issue の本文にだけ、節が付く

- [ ] T039 [P] [US1] `p-w/cli/src/domain/tests/` に、frontmatter の失敗するテストを書く
  - `blocked_by` は一覧で、各要素は `issue`・`wait`・`reason` を持つ。`wait` は `stack` か `merge` で、省くと `stack` だ
  - `wait: merge` に `reason` が無いと、検証で落ちる
  - `order` と `status` は省ける。`parallel` を書くと、使えなくなった旨の検証の誤りになる
  - `blocked_by` と `status: ready` を両方書くと、検証で落ちる
- [ ] T040 [US1] `p-w/cli/src/domain/frontmatter.ts` を直し、T039 を通す
- [ ] T041 [P] [US1] `p-w/cli/tests/interface/issue.test.ts` に、`issue create --plan` の失敗するテストを書く
  - 出力の表と積める並びは、contracts/cli-commands.md の `--plan` の形のとおりだ
  - 投稿の要求を 1 件も送らない
  - 次の 5 つの入力で、決めた `error:` を出して終了コード 1 で止まる
    - 前提のキーが、どのファイルにも無い
    - 前提が、後ろのファイルを指す
    - 前提が輪になる
    - `wait: merge` に `reason` が無い
    - `parallel` が書かれている
- [ ] T042 [P] [US1] `p-w/cli/tests/interface/issue.test.ts` に、一括投稿の失敗するテストを書く
  - 作った Issue に、前提ごとに `addBlockedBy` を送る。ファイルのキーは、作った Issue の番号に置き換わる
  - 前提に `owner/repo/N` を書くと、既存の Issue を指す
  - マージを待つ前提のある Issue だけ、本文の末尾に節が付く
  - 前提のある Issue は `Blocked` の列に、無い Issue は `Ready` の列に置かれる
  - 前提の追加が 1 件失敗しても、Issue の作成は取り消されない。失敗した組と、付け直すコマンドが出て、終了コードは 1 になる
  - 最後に、Issue の番号での積める並びが出る
  - Issue の作成が途中で失敗したときは、作られた Issue どうしの前提だけを付ける
- [ ] T043 [P] [US1] `p-w/cli/tests/interface/issue.test.ts` に、通し番号の失敗するテストを書く
  - `order` を省くと、既存のサブタスクの番号の最大の次から、ファイルの順に振る
  - 既存の番号に枝の文字（`18a`）があるときは、数字の部分で数える
  - 親のサブタスクが 20 件を超えていても、全件を読んで最大を決める
  - `order` を書いたときは、その番号を使う
  - タイトルに枝の文字が付かない
- [ ] T044 [US1] 一括投稿を直し、T041〜T043 を通す
  - 直すのは `p-w/cli/src/commands/issue-create.ts` と `p-w/cli/src/commands/issue-shared.ts`
  - 投稿の前の確認は、どのファイルの投稿よりも先に全部済ませる
  - 列は Phase 4 の共通の処理で置く
  - `validateStatusForType` を緩め、タスクとバグを `blocked` でも作れるようにする
- [ ] T045 [US1] `p-w/cli/templates/issue/task-implement.md` を直す。frontmatter に `blocked_by` を足し、`parallel` を外す。冒頭のコメントから、段と枝の文字の説明を外し、`blocked_by` の書き方を足す。`order` と `status` は省く旨を書く
- [ ] T046 [US1] `p-w/skills/w-issueize/SKILL.md` を、contracts/skill-flow.md の w-issueize の表のとおりに直す
  - Step 2 は、前提の表を読む。段と枝の文字の計算と、「番号が示すのは着手の条件」の記述を外す
  - Step 3 は、`blocked_by` を書く。投稿の前に `pecot issue create --plan` を打ち、出力を前提の表と並べて示す
  - 4 列の表が無い tasks.md の扱いを、contracts/prerequisite-table.md の 4 のとおりに書く
  - Step 4 は、進め方・積める並び・最初に着手できる Issue を報告する
- [ ] T047 [P] [US1] `p-w/skills/w-help/references/issue-flow-rules.md` の `order` の説明を通し番号に直し、前提と種類の決まりを足す
- [ ] T048 [US1] スキルの文書のテストを直す。w-issueize の Step の順と、打つコマンドが、直した文と合う
- [ ] T049 [US1] `issue create` の定義書を直す。`p-w/interface/authored.yaml` に、`--plan`・前提の登録・通し番号の振る舞いの項目を足す
- [ ] T050 [US1] version plan を `.nx/version-plans/` に足す

**Checkpoint**: tasks.md の前提の表から、blocked by の付いた Issue がボードの正しい列にできる

---

## Phase 6: User Story 7・9 — 前提と種類を後から直す (Priority: P3)

**Goal**: `pecot issue block` と `pecot issue unblock` で、既存の Issue の前提と種類を直せる。直した直後に、判定・列・札・本文の節がそろう

**Independent Test**: quickstart.md の 7 を通す。種類を `merge` に変えると本文に節が付き、判定が `blocked` になる。外すと blocked by が消え、列が動く。輪になる組は付かない

- [ ] T051 [P] [US7] `p-w/cli/tests/interface/issue.test.ts` に、`issue block` の失敗するテストを書く。場面と出力は、contracts/cli-commands.md の `pecot issue block` の表の 7 行のとおりだ
  - 付けた後に、待つ側の Issue の列が動く
  - 種類を `merge` にすると、本文の節に行が付く。`stack` に戻すと、行が外れる
  - 本文のほかの節は変わらない
  - 輪になる組は、要求を送る前に止まる
  - `--dry-run` は、要求を送らずに、付ける内容を出す
- [ ] T052 [P] [US7] `p-w/cli/tests/interface/issue.test.ts` に、`issue unblock` の失敗するテストを書く
  - 場面と出力は、contracts/cli-commands.md の `pecot issue unblock` の表の 4 行のとおりだ
  - 札が `Needs Attention` で、見直しの要る前提が無くなると `Todo` に戻る
- [ ] T053 [US7] `p-w/cli/src/commands/issue-dependency.ts` を足し、T051 と T052 を通す。`p-w/cli/src/commands/issue.ts` の `ISSUE_COMMANDS` に登録する
- [ ] T054 [US9] 着手済みの Issue の前提を変えたときの失敗するテストを、`p-w/cli/tests/interface/issue.test.ts` に書く。変更は通る。待つ側の Issue の列と札は動かない。`warning:` で、着手済みの Issue と判定の食い違いを知らせる
- [ ] T055 [US7] 定義書に 2 つの項目を足す。`p-w/interface/authored.yaml` に `PW-ISSUE-BLOCK` と `PW-ISSUE-UNBLOCK` を書き、共通の完了条件の 4 つを済ませる。コマンドの数は 2 つ増える
- [ ] T056 [US7] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 判定が実態と違うときに、前提を直して進められる

---

## Phase 7: User Story 3 — 着手が判定で base を選び、ブロック中なら止まる (Priority: P1)

**Goal**: `pecot create-branch` が、判定に合った base でブランチを作る。ブロック中の Issue では作らずに止まる。base の記録が残る

**Independent Test**: quickstart.md の 3 の前半と 4 を通す。`startable` は開発ブランチから、`stackable` は前提のブランチからブランチができる。`blocked` は終了コード 2 で止まり、リモートにブランチができない

- [ ] T057 [P] [US3] `p-w/cli/tests/interface/create-branch.test.ts` に、失敗するテストを書く。場面と出力は、contracts/cli-commands.md の `pecot create-branch` の表の 4 行のとおりだ
  - `stackable` のとき、`createLinkedBranch` に渡す位置が、積む先のブランチの先頭になる
  - `blocked` のとき、ブランチを作る要求を送らない。直し方の 2 行が出る
  - `--base` が判定で選んだ base と違うと、終了コード 2 で止まる
  - 前提の付いていない Issue では、出力が今までと 1 文字も変わらない
- [ ] T058 [P] [US3] `p-w/cli/src/infra/tests/` に、base の記録の失敗するテストを書く。`.pecot/state/.pecot-base` に、base のブランチ・位置・積んだ先の Issue を 1 行で書く。ファイルが無いときは、開発ブランチから着手したものとして読む（data-model.md の 8）
- [ ] T059 [US3] `p-w/cli/src/domain/state.ts` と `p-w/cli/src/infra/state-store.ts` に、base の記録を足し、T058 を通す
- [ ] T060 [US3] `p-w/cli/src/commands/repository.ts` を直し、T057 を通す。`resolveBaseBranch` の前に判定を計算する。ブロックを無視する指定は足さない（FR-021）
- [ ] T061 [US3] `p-w/cli/src/commands/session.ts` を直す。テストは `p-w/cli/tests/interface/session.test.ts` に書く
  - 積んで着手した作業ディレクトリで、`## Stack` の節に base と、その Issue の PR を出す
  - 着手中の Issue の判定が `blocked` のときは、同じ節に食い違いを出す
- [ ] T062 [US3] `p-w/skills/w-active/SKILL.md` を、contracts/skill-flow.md の w-active の表のとおりに直す。base の選び方をスキルの文に書かない。ブロック中で止まったときに、案内の 2 行を利用者に示す手順を足す
- [ ] T063 [US3] `create-branch` と `session status` の定義書を直す。スキルの文書のテストを直す
- [ ] T064 [US3] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 前提が PR 中の Issue に、base を選ばずに着手できる

---

## Phase 8: User Story 4 — 積んだ Issue の PR がスタックとして出る (Priority: P2)

**Goal**: `pecot pr create` が、積んだブランチの PR を下の段のブランチを base にして作り、GitHub のスタックに登録する。PR を作ると、その Issue を待っていた Issue の列が動く

**Independent Test**: quickstart.md の 3 の後半を通す。PR の base が前提のブランチで、差分にその段の変更だけが出る。2 つの PR がスタックとして並ぶ。待っていた Issue が `Ready` に移る

- [ ] T065 [P] [US4] `p-w/cli/src/domain/tests/` に、PR の内容の検証の失敗するテストを書く。base が開発ブランチか、記録の base と同じなら通る。どちらでもなければ、今までどおり検証で落ちる
- [ ] T066 [P] [US4] `p-w/cli/src/infra/github/tests/` に、スタックの API の失敗するテストを書く
  - `POST /repos/{owner}/{repo}/stacks` に PR 番号を下から順に渡す
  - 既にスタックがあれば `POST .../stacks/{n}/add` を使う
  - `GET .../stacks?pull_request=N` で、PR の入っているスタックを読む
- [ ] T067 [P] [US4] `p-w/cli/tests/interface/pr.test.ts` に、`pr create` の失敗するテストを書く。場面と出力は、contracts/cli-commands.md の `pecot pr create` の表の 5 行のとおりだ
  - `--prepare` が、記録の base をテンプレートの `base` に入れる
  - PR を作った後、その Issue を前提にしている Issue の列が動き、`moved:` が出る
  - スタックの API が 404 を返すリポでは、PR は作り、`warning:` を出す
  - 記録の base が開発ブランチのとき、出力が今までと変わらない
- [ ] T068 [US4] `p-w/cli/src/infra/github/pulls.ts` に、スタックの登録と読み取りを足し、T066 を通す
- [ ] T069 [US4] `p-w/cli/src/domain/pull-request.ts` と `p-w/cli/src/commands/pr.ts` を直し、T065 と T067 を通す。下の段の PR がマージ済みなら、base を開発ブランチにする
- [ ] T070 [US4] `p-w/skills/w-pr/SKILL.md` を、contracts/skill-flow.md の w-pr の表のとおりに直す。本文に、上下の PR やスタックの位置を書かせない
- [ ] T071 [US4] `pr create` の定義書を直す。スキルの文書のテストを直す
- [ ] T072 [US4] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 積んで着手した Issue を、レビューに出せる

---

## Phase 9: User Story 5 — スタックを下からマージし、次に着手できる Issue が分かる (Priority: P2)

**Goal**: `pecot pr merge` が、単独の PR とスタックの最下段の PR をマージする。`pecot pr cleanup` が、待っていた Issue の列を動かし、判定の変化を出す。エージェントは `gh stack` を直接打てない

**Independent Test**: quickstart.md の 6 を通す。上の段の PR のマージは止まる。下の段をマージして片付けると、`Readiness changed:` が出て、上の段のブランチが残る

- [ ] T073 [P] [US5] `p-w/cli/src/infra/github/tests/` に、マージの API の失敗するテストを書く。単独の PR もスタックの中の PR も、`PUT .../pulls/{n}/merge-async` を呼ぶ（同期の API は merge queue を扱わない）。結果は `GET .../merge-async/{uuid}` で、終わるまで読む
  - merge queue の有無は、GraphQL の `PullRequest.isMergeQueueEnabled` で判定する。有りと無しの両方でテストする
  - merge queue の無いブランチでは `merge_method: "squash"` を渡す
  - merge queue のあるブランチでは `merge_method`・`commit_title`・`commit_message`・`merge_action` を渡さない（research.md の R5）
  - 応答は 202（pending）、200（既にマージ済みかキューの中）、400（閉じている PR など）、409（同じ PR の要求が既にある。既存の uuid を読む）を分ける
  - uuid の結果は 24 時間で消える。消えた後に読んだ場合の扱いも確かめる
  - `enqueued` と `failed` の `details.message` を、そのまま返す
- [ ] T074 [P] [US5] `p-w/cli/tests/interface/pr.test.ts` に、`pr merge` の失敗するテストを書く。場面と出力は、contracts/cli-commands.md の `pecot pr merge` の表の 10 行のとおりだ
  - merge queue の無いブランチでは squash を渡し、あるブランチでは渡さない（research.md の R5）
  - `--dry-run` は、要求を送らない
- [ ] T075 [P] [US5] `p-w/cli/tests/interface/pr.test.ts` に、`pr cleanup` の失敗するテストを書く
  - 片付けの後、この PR の Issue を前提にしている Issue の列と札が動く。着手の跡がある Issue は動かない
  - base が開発ブランチでない PR の片付けでも、その PR の Issue が閉じる
  - 判定が変わった Issue が、stdout の `Readiness changed:` に出る
  - 上に積んだ段があるとき、載せ直しの案内が出る。上の段のブランチを消す要求を送らない
  - base の記録のファイルが、`.pecot-active` と一緒に消える
  - 前提にされていない Issue の PR では、出力が今までと変わらない
- [ ] T076 [US5] `p-w/cli/src/infra/github/pulls.ts` に、非同期のマージを足し、T073 を通す
- [ ] T077 [US5] `p-w/cli/src/commands/pr.ts` に `pr merge` を足し、T074 を通す。`PR_COMMANDS` に登録する
- [ ] T078 [US5] `p-w/cli/src/commands/pr.ts` の `runCleanup` を直し、T075 を通す
- [ ] T079 [P] [US5] hook の規則を足す（research.md の R16）
  - `p-w/hooks/lib/core/gh-command-check.sh` で、`gh stack` で始まるコマンドを止める。`view` と `--help` は通す。案内は `pecot pr create`・`pecot pr merge`・`pecot pr restack` だ
  - `p-w/hooks/lib/mcp-handlers/pecot-post-ask.sh` で、MCP のツール `pr_merge` を確認にかける。`dry_run` が真のときは通す。w-merge の起動の印があれば通す
  - `issue block`・`issue unblock`・`pr restack` は確認にかけない
  - テストは `p-w/cli/tests/hooks/` に書く
- [ ] T080 [US5] `p-w/skills/w-merge/SKILL.md` を、contracts/skill-flow.md の w-merge の表のとおりに直す。`gh pr merge` を `pecot pr merge` に変える。後続フェーズの通知は `Readiness changed:` を使う
- [ ] T081 [US5] 定義書に `PW-PR-MERGE` を足し、`pr cleanup` の項目を直す。共通の完了条件の 4 つを済ませる。コマンドの数は 1 つ増える。スキルの文書のテストを直す
- [ ] T082 [US5] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 積んだ PR を、順番を誤らずに開発ブランチへ届けられる

---

## Phase 10: User Story 6 — 下の段を直した後に、上の段を載せ直せる (Priority: P3)

**Goal**: `pecot pr restack` が、今のブランチを base の新しい位置へ載せ直す。`--check` で、載せ直しが要るかが分かる。ほかの作業ディレクトリには触れない

**Independent Test**: quickstart.md の 5 と、6 の後半を通す。下の段に push があると `needs restack` と出る。載せ直すと、PR の差分がその段の変更だけに戻る。衝突では終了コード 3 で止まり、`--abort` で元に戻る

- [ ] T083 [P] [US6] `p-w/cli/src/infra/tests/` に、載せ直しの失敗するテストを書く。一時の git リポと worktree を 2 つ使い、実際の git で確かめる
  - 下の段にコミットを足すと、上の段が `git rebase --onto <新しい位置> <記録の位置>` で載る
  - 下の段を squash で開発ブランチへ入れた後、上の段が開発ブランチへ載り、下の段のコミットが落ちる
  - もう一方の worktree の、未コミットの変更とブランチの位置が変わらない
  - 載せ直した結果の木が `origin/<branch>` と同じなら、手元が origin と同じ SHA になり、push しない
  - 木が違えば、`rebase --onto` した結果を `--force-with-lease` で push する
  - 衝突のとき、衝突したファイルの一覧を返す。取りやめると、載せ直しの前の位置に戻る
- [ ] T084 [US6] `p-w/cli/src/infra/git.ts` に、載せ直し・続行・取りやめ・`--force-with-lease` の push を足し、T083 を通す
  - `rebase --onto` の後に `git diff --quiet HEAD origin/<branch>` で木を比べ、同じなら `origin/<branch>` に合わせて push しない
  - 合わせた後の base の位置は `git merge-base origin/<branch> <開発ブランチ>` で求める
- [ ] T085 [P] [US6] `p-w/cli/tests/interface/pr.test.ts` に、`pr restack` の失敗するテストを書く。場面と出力は、contracts/cli-commands.md の `pecot pr restack` の表の 9 行のとおりだ。載せ直しの後に、base の位置の記録が書き直される
- [ ] T086 [US6] `p-w/cli/src/commands/pr.ts` に `pr restack` を足し、T085 を通す。`PR_COMMANDS` に登録する
- [ ] T087 [US6] `p-w/cli/src/commands/session.ts` の `## Stack` の節に、載せ直しが要るかを足す
- [ ] T088 [US6] `p-w/skills/w-revise/SKILL.md` を、contracts/skill-flow.md の w-revise の表のとおりに直す。上の段の作業ディレクトリには入らず、載せ直しが要る旨を報告に入れる
- [ ] T089 [US6] 定義書に `PW-PR-RESTACK` を足し、共通の完了条件の 4 つを済ませる。コマンドの数は 1 つ増える。スキルの文書のテストを直す
- [ ] T090 [US6] version plan を `.nx/version-plans/` に足す

**Checkpoint**: レビューの指摘で下の段が変わっても、上の段を保てる

---

## Phase 11: User Story 8 — w-breakdown が前提の表を書かせる (Priority: P2)

**Goal**: w-breakdown の tasks の工程でできる tasks.md に、4 列の前提の表がある。マージを待つ前提には理由が書かれている

**Independent Test**: main に入らないと確かめられないフェーズを含む Epic を、w-breakdown にかける。できた tasks.md の表に、そのフェーズの前提が「マージを待つ」と理由つきで載る。その tasks.md を `pecot issue create --plan` にかけ、表の行と出力が 1 対 1 で合う

- [ ] T091 [US8] `p-w/skills/w-breakdown/SKILL.md` を、contracts/skill-flow.md の w-breakdown の表のとおりに直す
  - `/speckit.tasks` へ渡す指示に、前提の表の形を書く。形は contracts/prerequisite-table.md の 1 のとおりだ
  - 種類を決める 2 つの問いと、「マージを待つ」になる例の 3 つを、指示に入れる
  - tasks の工程の後に、4 列の表があることを確かめる手順を足す
  - spec-kit のテンプレートは変えない
- [ ] T092 [P] [US8] `p-w/skills/w-help/references/spec-driven-workflow.md` に、前提の表から Issue 化までの流れを足す
- [ ] T093 [US8] スキルの文書のテストを直す。w-breakdown の Step の順と、tasks の工程に渡す指示の中身が、直した文と合う
- [ ] T094 [US8] version plan を `.nx/version-plans/` に足す

**Checkpoint**: 前提の読み違いが、表の形で防がれる

---

## Phase 12: 文書と、このリポでの通し

**Goal**: 利用者が、前提・着手の判定・積む運用を、配布する文書だけで使える。spec 023 の文書が、人の判断を待つ値の名前を `Needs Attention` と書いている。このリポで、スキルだけで Issue 化からマージまでが通る

**Independent Test**: quickstart.md の 11 を、このリポの Epic で通す。エージェントが base を選ばず、`gh stack` を打たず、マージの後に次に着手できる Issue を報告する

- [ ] T095 [P] `p-w/skills/w-help/references/spec-driven-workflow.md` に、積んで着手・PR・マージ・載せ直しの流れを足す（FR-045）
- [ ] T096 [P] `p-w/skills/w-help/SKILL.md` と `p-w/README.md` に、新しい 4 つのコマンドと、列の読み方への案内を足す
- [ ] T097 [P] `specs/023-label-triggered-autofix/` の文書の `Waiting` を `Needs Attention` に直す（FR-071）。直すのは値の名前だけで、ほかの文は変えない
- [ ] T098 このリポの Epic を 1 つ選び、quickstart.md の 11 の 5 つの手順を、スキルだけで通す。対象の Epic は、前提の表に「マージを待つ」の行を 1 つ以上持つものにする
- [ ] T099 T098 の通しで、エージェントが判断に迷った箇所を記録する。スキルの文か CLI の出力で直せるものは、このフェーズで直す
- [ ] T100 quickstart.md の 1〜10 を検証用のリポで通し、spec.md の SC-001〜SC-016 に結果を付ける。結果は PR に貼る
- [ ] T101 検証用のリポとボードを消すかを利用者に確かめ、同意があれば消す
- [ ] T102 version plan を `.nx/version-plans/` に足す

**Checkpoint**: この機能を、このリポの運用に使い始められる

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | 積める | 前提の解除に使う API を、Phase 1 の結果で決める |
| 3 | 1 | 積める | 選択肢の足し方と並びを、Phase 1 の結果で決める |
| 4 | 2 | 積める | 一覧が、判定の関数と前提の読み取りを使う |
| 4 | 3 | 積める | 列を直す処理が、`Blocked` の値と設定のキーを使う |
| 5 | 4 | 積める | 一括投稿が、列を動かす共通の処理を使う |
| 6 | 4 | 積める | 前提を変えた後に、列を動かす共通の処理を使う |
| 7 | 4 | 積める | 着手が、Issue の実態の読み取りと判定を使う |
| 8 | 7 | 積める | PR の作成が、着手のときの base の記録を読む |
| 9 | 8 | 積める | マージが、スタックの読み取りを使う |
| 10 | 8 | 積める | 載せ直しが、base の記録と下の段の PR を読む |
| 11 | 5 | 積める | 前提の表を読む w-issueize と、表の形をそろえる |
| 12 | 6 | マージを待つ | このリポでの通しは、main から読み込まれるプラグインで動かす |
| 12 | 9 | マージを待つ | 同上 |
| 12 | 10 | マージを待つ | 同上 |
| 12 | 11 | マージを待つ | 同上 |

Phase 3 の T027 は、このリポのボードに値を足す。値の無いボードでも動くので、ほかのフェーズはこれを待たない。
Phase 9 の hook の案内は `pecot pr restack` の名前を出す。コマンドは Phase 10 で入るが、案内の文だけなので Phase 9 は Phase 10 を待たない。

### User Story Dependencies

| ストーリー | 終わるフェーズ | 依存 |
|---|---|---|
| US2（判定の表示と列） | 4 | 無い |
| US1（一括投稿が前提を付ける） | 5 | US2 |
| US7・US9（前提と種類を直す） | 6 | US2 |
| US3（判定で着手する） | 7 | US2 |
| US4（スタックとして PR を出す） | 8 | US3 |
| US5（下からマージする） | 9 | US4 |
| US6（載せ直す） | 10 | US4 |
| US8（前提の表を書かせる） | 11 | US1 |

### Parallel Opportunities

- Phase 2 と Phase 3 は、Phase 1 の後に並べて進められる
- Phase 5・6・7 は、Phase 4 の後に並べて進められる
- Phase 9 と Phase 10 は、Phase 8 の後に並べて進められる。どちらも `p-w/cli/src/commands/pr.ts` を直すので、後から出すほうが載せ直す
- Phase 11 は、Phase 5 の後ならいつでも進められる
- フェーズの中では、`[P]` のタスクを並べて進められる

積める並びは次のとおり。

```text
1 -> 2
1 -> 3
4 -> 5 -> 11
4 -> 6
4 -> 7 -> 8 -> 9
4 -> 7 -> 8 -> 10
```

Phase 4 は、Phase 2 と Phase 3 の合流なので、両方のマージを待つ。Phase 12 は、4 つの前提のマージを待つ。

## Parallel Example

Phase 2 の始めに、次の 4 つを並べて進める。

```text
T010 着手の判定の失敗するテスト（p-w/cli/src/domain/tests/readiness.test.ts）
T012 本文の節の失敗するテスト（p-w/cli/src/domain/tests/prerequisites.test.ts）
T015 前提の読み書きの失敗するテスト（p-w/cli/src/infra/github/tests/）
T017 Issue の PR の読み取り（p-w/cli/src/infra/github/pulls.ts）
```

## Implementation Strategy

### MVP

Phase 1〜5 で、tasks.md の前提の表から、blocked by の付いた Issue がボードの正しい列にできる。一覧に判定が出て、列がずれても直る。
この時点で、最初の困りごと（進めてよいのか分からない）が解ける。積んで進める動線はまだ無く、前提のマージを待つ。

### 増やし方

| 順 | 足すもの | 届く価値 |
|---|---|---|
| 1 | Phase 1〜4 | 画面で付けた blocked by が、一覧の判定とボードの列に出る |
| 2 | Phase 5 | Issue 化のときに、前提が付き、進め方が見える |
| 3 | Phase 7・8 | 前提がレビュー中の間に、次の Issue に着手して PR を出せる |
| 4 | Phase 9 | 積んだ PR を、順番を誤らずにマージできる |
| 5 | Phase 10 | 下の段が変わっても、上の段を保てる |
| 6 | Phase 6 | 計画が変わったときに、前提を直せる |
| 7 | Phase 11 | 前提の読み違いが、表の形で防がれる |
| 8 | Phase 12 | このリポの運用に使い始められる |

### 人の作業が要るところ

| タスク | 頼むこと |
|---|---|
| T001 | 検証用のリポとボードを作ることへの同意 |
| T027 | このリポのボードに値を足した後の、画面での確認 |
| T098 | 通しに使う Epic の選択 |
| T101 | 検証用のリポとボードを消すことへの同意 |

### ほかの Epic との順番

| Epic | 関係 |
|---|---|
| #42（TypeScript 化） | #351 が main に入ってから、Phase 2 に着手する |
| #315（spec 023） | ボードへ値を足す処理（Phase 3）を共有する。先に入るほうが作る。人の判断を待つ値の名前は `Needs Attention` にそろえる |
| #50 | この Epic の Phase 5 で内容が満たされる |

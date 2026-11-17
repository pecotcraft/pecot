---

description: "PR を作ると、GitHub Actions の上で w-revise のレビューが始まる のタスク一覧"
---

# Tasks: PR を作ると、GitHub Actions の上で w-revise のレビューが始まる

**Input**: `specs/027-auto-revise-on-pr/` の設計文書

**Prerequisites**: plan.md、spec.md、research.md、data-model.md、quickstart.md と、contracts/ の 3 つの文書

**Tests**: 憲法 II（TDD）を守る。コマンドと雛形は、契約の表の場合ごとに、先にテストを書いて落とし、失敗を確かめてから実装する。スキルの文の変更は、文書のテストに期待を足してから直す。その後に、quickstart.md のシナリオを検証用で流す。

**Organization**: 1 フェーズが 1 つの Issue・PR になる。フェーズの順は、plan.md の「実装の段階と PR」を元に、雛形を先に置く順へ入れ替えた。

## Format: `[ID] [P?] [Story] Description`

| 印 | 意味 |
|---|---|
| `[P]` | 並べて進められる。別のファイルで、終わっていないタスクに依存しない |
| `[Story]` | spec.md のユーザーストーリー（US1〜US5） |

T058 と T059 は、T044 を分けて足したタスクだ。進める順は、番号ではなく並びに従う。

パスはリポ root 起点で書く。次の略し方を使う。

| 略 | 指す場所 |
|---|---|
| `p-w/` | `plugins/pecot-workflow/` |
| `spec/` | `specs/027-auto-revise-on-pr/` |
| 検証用 | リポ `pecotcraft/pecot-sandbox`（spec 026） |

## 全フェーズに共通の完了条件

- 確かめは、検証用で流す。このリポの PR を、確かめの書き込む先にしない
- 配布物を直す PR には、`.nx/version-plans/` に version plan を 1 つ足す。要るかどうかは、pre-push の hook が知らせる
- 文面の規則と lint は、pre-commit で通す。`--no-verify` を使わない
- コマンドを足す PR は、`p-w/interface/authored.yaml` に項目を書き、`generated.json` を書き出し直す。振る舞いの項目を確かめるテストは、`verifies` で項目の ID を書く
- 実機で確かめた結果は、確かめた版と日付を付けて書く
- 見込みと違う結果が出たら、後のフェーズのタスクと contracts を直してから進む。標準から外れる点は、その場でユーザーに伝える

---

## Phase 1: 設計を左右する点を、実機で先に確かめる

**Goal**: research.md の「実装で確かめること」に、結果と確かめた日が付いている。見込みと違った点は、contracts と後のフェーズを直してある

**Independent Test**: `spec/research.md` の R2〜R6 と R9 の「実装で確かめること」の各行に、結果・版・日付が書かれている

**前提**: 検証用のリポと、検証用にだけ入れた GitHub App（spec 026 の Phase 2）と Claude の App。直したプラグインを action から入れる手段は、spec 026 の R11-6 の結果に従う。結果がまだ無ければ、main の版のプラグインで確かめられる項目だけを先に進める

- [x] T001 検証用に、確かめ用のワークフローを 1 つ置く。`spec/contracts/workflow-template.md` の job の形で、`prompt` は固定の文にする。App のトークンは Pull requests の write と Contents の read に絞る。置いたファイルは `.pecot/work/<Issue番号>/` にも写す
- [x] T002 [P] T001 のワークフローで、プラグインのサブエージェント `pecot-w:w-reviewer` を起こし、結果が main に返るかを確かめる。サブエージェントが main の許可リストを引き継ぐかも見る。結果を `spec/research.md` の R5 に書く
- [x] T003 [P] T001 のワークフローで、プラグインの hooks（`SessionStart`・`UserPromptSubmit`・`PreToolUse`）が、人のいない実行を止めないかを確かめる。止めた hook があれば、名前と出力を `spec/research.md` の R5 に書く
- [x] T004 [P] T001 のワークフローで、`pr_show`・`issue_show`・`pr_restack`・`issue_comment` が、絞ったトークンで動くかを確かめる。Projects の権限を求めたツールと、スレッドの読み取りの結果を `spec/research.md` の R3 に書く
- [x] T005 [P] T001 のワークフローで、`mcp__github_inline_comment__create_inline_comment` を確かめる。`confirmed: true` で投稿した結果からコメントの URL を得られるか、ファイル単位の指摘とスレッドへの返信ができるかを見る。結果を `spec/research.md` の R4 に書く
- [x] T006 [P] `concurrency` を job に書いたとき、`if` で飛ばされた run が group に入らないことを確かめる。起動ラベルでないラベルを、進行中の run の間に付けて見る。`labeled` の run で `github.actor` がラベルを付けた人になることも見る。結果を `spec/research.md` の R2 と R6 に書く
- [x] T007 [P] ターンの上限で切られた run と、時間の上限で切られた run を 1 つずつ起こす。job の終わり方と action の出力から、失敗と上限を見分けられるかを確かめる。結果を `spec/research.md` の R9 に書く
- [x] T008 [P] bot が作者の PR で、プラグインの MCP サーバが起動するかを確かめる。許した bot の PR と、許していない bot の PR に人が起動ラベルを付けた場合の 2 つだ。作者の名前の形も見る。結果を `spec/research.md` の R2 に書く。動かなければ、ユーザーに FR-025 の扱いを仰ぐ
- [x] T009 T002〜T008 の結果で見込みと違った点を、`spec/contracts/` の 3 つの文書と、後のフェーズのタスクに反映する。標準から外れる点が出たら、ユーザーに伝える

---

## Phase 2: 起動する PR・使えるツール・ターンと時間に上限があり、外部の PR から起動されない (US2、P1)

**Goal**: 配布するワークフローの雛形が、契約の形で置いてある。安全策は、何も変えない状態ですべて有効だ

**Independent Test**: `p-w/cli/tests/review-workflow-template.test.ts` が通る。雛形を検証用に手で写すと、fork の PR と draft の PR で job が飛ばされる

**前提**: Phase 1（許可リスト・`if`・`concurrency` の形が、実機の結果で決まる）。#579（`.active` の無い checkout で、pecot の MCP ツールが動く）。起動し直しは合言葉のコメントで行う（research の R15）

### Tests for User Story 2

- [x] T010 [US2] `p-w/cli/tests/review-workflow-template.test.ts` を書く。`spec/contracts/workflow-template.md` の「テストで確かめること」の表を、1 行ずつテストにする。落ちることを確かめる。形は、同じ置き場の board sync の雛形のテストに合わせる

### Implementation for User Story 2

- [x] T011 [US2] `p-w/cli/templates/workflow/pecot-review.yml` を書く。中身は `spec/contracts/workflow-template.md` のとおりにする。利用者が変える 4 つの値は `vars` から読み、job の `if` で `env` を読まない。action は SHA で固定する
- [x] T012 [US2] 雛形の先頭のコメントに、置き先・要る変数と secret・変えられる 4 つの変数と既定値・合言葉・Dependabot を許すときの secret の置き場を、英語で書く。`p-w/cli/templates/workflow/pecot-board-sync.yml` の先頭のコメントと同じ調子にする
- [x] T013 [US2] `.pre-commit-config.yaml` の actionlint が、新しい雛形も対象にしていることを確かめる。対象から外れていれば、対象の指定を直す
- [x] T014 [US2] T010 のテストを通す。雛形を検証用に手で写し、quickstart.md のシナリオ 7（fork）・9（draft）・12（許していない bot）で job が飛ばされることを見る。合言葉のコメントに 👀 が付くことと、`@pecotbot` と書いても誰にも通知が飛ばないことも見る（research の R15）。結果を PR の説明に書く

---

## Phase 3: 後に続く自動処理が、起動・トークン・安全策の同じ仕組みを使える (US5、P3)

**Goal**: `pecot workflow install`・`doctor` が、雛形の一覧から雛形を置き、設定を確かめる。認証の名前と雛形の書き方の決まりが、自動処理に共通のものとして文書にある

**Independent Test**: 空のリポの作業ツリーで `pecot workflow install review` を打つと、雛形ができる。`pecot workflow doctor review` が、足りない変数と secret を名前で出す

**前提**: Phase 2（雛形のファイルを読んで書き出す）

優先度は P3 だが、導入（Phase 7）と確かめ（Phase 8）がこのコマンドを使うので、ここで作る。

### Tests for User Story 5

- [x] T015 [P] [US5] 雛形の一覧と版の比べ方の単体テストを、`p-w/cli/src/domain/tests/` に書く。一覧の `review` の行が、`spec/data-model.md` の「雛形の一覧」の欄を持つこと、1 行目の目印から版を読めること、目印の無いファイルを古いと判定することを確かめる
- [x] T016 [P] [US5] `pecot workflow install` のテストを、`p-w/cli/tests/interface/` に書く。`spec/contracts/cli-commands.md` の `install` の条件の表を、1 行ずつテストにする。`--force` が、利用者の足した行を上書きの前に出すことも入れる
- [x] T017 [P] [US5] `pecot workflow doctor` のテストを、`p-w/cli/tests/interface/` に書く。`spec/contracts/cli-commands.md` の `doctor` の項目の表を、1 行ずつテストにする。権限が無く読めない項目を `skipped:` で出し、足りないと数えないことも入れる

### Implementation for User Story 5

- [x] T018 [US5] 雛形の一覧と版の比べ方を `p-w/cli/src/domain/` に書く。初版の一覧は `review` の 1 行だ。欄は `spec/data-model.md` の「雛形の一覧」のとおりにする
- [x] T019 [US5] 雛形の書き出しと、変数・secret の名前の読み取りを `p-w/cli/src/infra/` に書く。secret と変数は名前の有無だけを読み、値は読まない。リポの単位と organization の単位の両方を見る
- [x] T020 [US5] `p-w/cli/src/commands/workflow.ts` に `install` と `doctor` を書く。コマンドの定義の配列を、`p-w/cli/src/commands/registry.ts` に足す。MCP ツール `workflow_install`・`workflow_doctor` は、registry の定義から出る。MCP の側に、別のファイルは足さない
- [x] T021 [US5] `p-w/interface/authored.yaml` に 2 つの項目と振る舞いの項目を書き、`p-w/interface/generated.json` を書き出し直す。T015〜T017 のテストに `verifies` を足す
- [x] T022 [P] [US5] `p-w/skills/w-help/references/auth-config.md` に、エージェント用の認証の名前を足す。名前は `spec/data-model.md` の「エージェント用の認証」の表のものだ。既定は Claude の App で、名前を登録しないことを書く。自前の App を置くときは、インストールで与える権限は使う自動処理の合計で、ワークフローが発行のときに絞ることを書く
- [x] T023 [P] [US5] `p-w/skills/w-help/references/commands.md` を直す。コマンドの表に、`workflow install` と `workflow doctor` の 2 行を足す
- [x] T024 [US5] T015〜T017 のテストを通す。検証用の作業ツリーで、quickstart.md の「導入を確かめる」の 1〜4 を流す。結果を PR の説明に書く

---

## Phase 4: 止まったことが PR に残る (US1、P1)

**Goal**: `pecot review finish` が、失敗と上限のときだけ、止まったことを知らせるコメントを 1 つ書く

**Independent Test**: 検証用の PR に対して `pecot review finish <PR> --ensure --job-status failure --review-outcome failure --review-conclusion "" --review-has-token true` を打つ。コメントが 1 つ付く。同じコマンドをもう一度打っても、コメントが増えない

**前提**: Phase 1（失敗と上限の見分け方が、実機の結果で決まる）

### Tests for User Story 1（終わり方）

- [x] T025 [P] [US1] 結果の決め方の単体テストを、`p-w/cli/src/domain/tests/` に書く。`--ensure` と job の終わり方・自動レビューの step の値から結果を決める表を、`spec/contracts/cli-commands.md` の順に 1 行ずつ確かめる。止まった場所を、同じ実行のインラインコメントの有無から決めることも入れる
- [x] T026 [P] [US1] `pecot review finish` のテストを、`p-w/cli/tests/interface/` に書く。`spec/contracts/cli-commands.md` の `review finish` の条件の表を、1 行ずつテストにする。同じ実行の目印があるときに 2 度書かないこと、トークンの値が出力に出ないことも入れる
- [x] T027 [P] [US1] T025・T026 に、CLI が埋めたテンプレート `review-stopped` の本文が、テンプレートの検証を通る期待を足す。`issue comment` のテンプレートの種類には足さない（本文は CLI だけが組み立てる）

### Implementation for User Story 1（終わり方）

- [x] T028 [US1] `p-w/cli/templates/comment/review-stopped.md` を書く。欄は `spec/data-model.md` の「止まったことを知らせるコメント」のとおりにする。冒頭のコメントに、読者と書き方を書く
- [x] T029 [US1] 結果の決め方と、テンプレートの本文の埋め方を `p-w/cli/src/domain/review-finish.ts` に書く。frontmatter のテンプレートの種類には足さない
- [x] T030 [US1] `p-w/cli/src/commands/review-finish.ts` を書く。グループ `review` を `names.ts` に、定義の配列を `registry.ts` に足す。MCP ツール `review_finish` は、registry の定義から出る。w-help の `references/commands.md` に行を足す
- [x] T031 [US1] `p-w/interface/authored.yaml` に項目と振る舞いの項目を書き、`p-w/interface/generated.json` を書き出し直す。T025・T026 のテストに `verifies` を足す
- [ ] T032 [US1] T025〜T027 のテストを通す。検証用の PR で、このフェーズの Independent Test を流す。結果を PR の説明に書く

---

## Phase 5: PR を作ると、人が介さずにレビューの指摘が PR に載る (US1、P1)

**Goal**: `/pecot-w:w-revise --unattended <PR>` が、Step 1〜3 を進め、指摘の投稿で終わる。採否を聞かず、コードを直さない

**Independent Test**: 検証用の PR に対して、端末から `/pecot-w:w-revise --unattended <PR>` を起こす。インラインコメントと `review-findings` が付き、質問が出ず、ブランチにコミットが増えていない。端末では、インラインコメントは「端末での投稿の手順」で投稿される。action のツールでの投稿は、Phase 8 で確かめる

**前提**: Phase 4（スキルが、終わりに `review_finish` を呼ぶ）

### Tests for User Story 1（手順）

- [ ] T033 [US1] `p-w/cli/tests/skills/skill-flow-structure.test.ts` に、w-revise の期待を足す。Step の番号と順が変わらないこと、Step 3 に「何を投稿するか」と「端末での投稿の手順」の 2 つの節があること、`--unattended` の節に「行わないこと」の一覧があることを確かめる。落ちることを確かめる

### Implementation for User Story 1（手順）

- [ ] T034 [US1] `p-w/skills/w-revise/SKILL.md` の Step 3 を、「何を投稿するか」と「端末での投稿の手順」に分ける。「何を投稿するか」には、採番・投稿先の振り分け・コメントの本文の形・`review-findings` の書き方だけを書き、投稿の手段を書かない。今の `gh api` の手順は、文を変えずに「端末での投稿の手順」へ移す
- [ ] T035 [US1] 同じファイルに、`--unattended` の進み方を足す。中身は `spec/contracts/skill-flow.md` の「Step 3 の文の分け方」の最後の段落と、「人のいない実行」の節のとおりにする。行わないことの一覧には、マージ・クローズ・リリースを含める
  - リポが複数のボードに入っている利用者のプロジェクトの指定を、`prompt` への渡し方と合わせて決め、`spec/contracts/workflow-template.md` に書く
- [ ] T036 [US1] 同じファイルの frontmatter の `description` と、冒頭の説明に、人のいない実行があることを足す。Claude Code 固有のツールの名前は足さない
- [ ] T037 [P] [US1] `p-w/skills/w-help/references/skills.md` と `p-w/README.md` のスキルの表の、w-revise の行を直す
- [ ] T038 [US1] T033 のテストを通す。このフェーズの Independent Test を、検証用の PR で main が流す。手で回す w-revise を Step 3 まで進めた PR と、quickstart.md の「手で回す w-revise と比べる」の表で比べる。結果を PR の説明に書く

---

## Phase 6: 自動レビューは指摘の投稿で終わり、人が手で回す w-revise で続きから進められる (US3、P2)

**Goal**: 端末の w-revise が、自動レビューの未解決の指摘を見つけると、Step 2・3 を飛ばして採否の確認から進む

**Independent Test**: Phase 5 の Independent Test で指摘の付いた PR に対して、端末から `/pecot-w:w-revise` を起こす。新しい指摘が投稿されず、採否を聞かれる

**前提**: Phase 5（同じファイルの Step 1 と Step 3 に書き足す）

### Tests for User Story 3

- [ ] T039 [US3] `p-w/cli/tests/skills/skill-flow-structure.test.ts` に期待を足す。w-revise の Step 1 に、引き継ぎの分岐があることだ。落ちることを確かめる

### Implementation for User Story 3

- [ ] T040 [US3] `p-w/skills/w-revise/SKILL.md` の Step 1 に、引き継ぎの分岐を足す。中身は `spec/contracts/skill-flow.md` の「引き継ぎ」のとおりにする。候補の見分け方、コミットの比べ方、古い diff のときに利用者へ示して選ばせること、レビューからやり直す道を書く
- [ ] T041 [US3] 同じファイルの「注意」の、返信と resolve の対象の文を直す。自動レビューが開いたスレッドも、w-revise が開いたスレッドに含める
- [ ] T042 [US3] T039 のテストを通す。quickstart.md のシナリオ 3 と 4 を、検証用の PR で main が流す。結果を PR の説明に書く

---

## Phase 7: 利用者が onboarding の流れで、自動レビューの仕組みとトークンを導入できる (US4、P3)

**Goal**: w-onboarding が、自動レビューを入れるかを聞く。入れるなら、雛形を置き、設定の順を示し、最後に確かめる。導入の説明が w-help にある

**Independent Test**: 自動レビューの無いリポで w-onboarding をたどる。入れないを選ぶと、何も置かれない。入れるを選ぶと、設定の順が示され、最後に `workflow_doctor` が通る

**前提**: Phase 3（`workflow_install`・`workflow_doctor` を使う）

### Tests for User Story 4

- [x] T043 [US4] `p-w/cli/tests/review-workflow-template.test.ts` に、導入の説明と雛形の一致の期待を足す。説明に書いた変数・secret の名前・合言葉の既定値と、自前の App の権限が、雛形と同じであることを確かめる。説明が無いので落ちることを確かめる

### Implementation for User Story 4

- [x] T044 [US4] `p-w/skills/w-help/references/review-workflow.md` を書く。導入の節に、前提・置き方・Claude の App の入れ方・モデルの認証の secret・合言葉を書く。
  - 権限を絞りたい利用者のために、自前の App の作り方と権限・変数と secret を別の節に書く。
  - 雛形を変えた PR では Claude の App の道でレビューが動かないことも書く。形は、同じ置き場の `board-sync-workflow.md` に合わせる。モデルの認証は `spec/research.md` の R14 のとおりにする
  - 既定はサブスクリプションのトークンだ。`claude setup-token` で作り、1 行で貼る
  - Workload Identity Federation は、subject の prefix を `sub_claim_prefix` から作る手順を書く
- [x] T058 [US4] 同じファイルに、運用の節を書く。次の項目だ
  - 変えられる 4 つの変数、bot を許す設定、Dependabot の secret、止まったときの読み方
  - トークンが切れたときの作り直しと、払い方の切り替え。secret を消すと Workload Identity Federation で動く
  - 雛形の更新、Claude の App が入っているかの確かめ方、GHES で確かめていないこと
- [x] T059 [US4] 同じファイルに、「自動処理に共通の決まり」の節を書く。認証の名前・版の目印・利用者が足す行の印を書く
- [x] T045 [US4] `p-w/skills/w-onboarding/SKILL.md` に、自動レビューを入れるかを選ぶ Step を足す。中身は `spec/contracts/skill-flow.md` の「w-onboarding に足す Step」のとおりにする
- [x] T046 [P] [US4] `p-w/skills/w-help/SKILL.md` の参照の表に、`review-workflow.md` を足す
- [x] T047 [US4] T043 のテストを通す。quickstart.md のシナリオ 14 を、検証用で main が流す。結果を PR の説明に書く。最初の自動レビューまでの 30 分の測定は T048 で行う

---

## Phase 8: 検証用で通し、このリポへ導入する

**Goal**: quickstart.md のシナリオが、検証用で、配られた版のプラグインと公開した CLI で通る。雛形の既定値が、試行の結果で直してある。このリポに自動レビューが入っている

**Independent Test**: quickstart.md のシナリオ 1〜18 の結果が、PR の説明にある。このリポで PR を作ると、指摘が PR に載る

**前提**: Phase 6 と Phase 7（どちらも main に入っている。CLI は、npm の `@next` に出た開発版を使う）

- [ ] T048 検証用で、`pecot workflow install review` から quickstart.md の「導入を確かめる」を流す。雛形の後始末の step が、公開した `@pecot/workflow-mcp` の `review finish` を打てることを見る
  - シナリオ 14 の、始めてから最初の自動レビューが起きるまでの時間を測り、30 分以内であることを見る。T047 では、配られたプラグインと CLI が自動レビューに届かないため測らない
- [ ] T049 quickstart.md のシナリオ 1〜13 と 15〜18 を、検証用で流す。実際に投稿するシナリオ 1・3・6 は main が流す。結果を、シナリオごとに PR の説明に書く
- [ ] T050 T049 の実行の記録から、かかったターンと時間を読む。`p-w/cli/templates/workflow/pecot-review.yml` の既定値を直し、版の目印を上げる。w-reviewer に公式の文書を調べる手段を許すかを決め、`spec/research.md` の「残した判断」に結果を書く
- [ ] T051 quickstart.md の「実行の記録で見ること」の 4 つを、T049 の run で確かめる。トークンと secret の値が、ログとコメントに出ていないことを見る
- [ ] T052 このリポに導入する。`pecot workflow install review` で `.github/workflows/pecot-review.yml` を置き、Claude の App と secret を用意する。App のインストールと secret の登録は、ユーザーが行う。`pecot workflow doctor review` が通ることを見る
- [ ] T053 このリポで PR を 1 つ作り、指摘が載ることを見る。fork からの PR で起動しないことは、検証用の結果（シナリオ 7）で代える

---

## Phase 9: spec 023 を、共通の部分を使う形に直す

**Goal**: spec 023 の成果物が、今の CLI（TypeScript）と、この spec が作った共通の部分を前提にしている

**Independent Test**: `specs/023-label-triggered-autofix/` の plan・research・contracts を読む。認証の名前、雛形を置いて確かめるコマンド、雛形の書き方の決まりが、この spec のものを指している

**前提**: Phase 8（共通の部分の形が、検証用での試行の後に決まる）

- [ ] T054 `specs/023-label-triggered-autofix/research.md` を直す。R2 の認証の名前、R8 の導入のコマンド、R10 の版の目印を、この spec の形に合わせる。`allowed_bots` の名前の形と、権限のモードの既定が変わったことを書く
- [ ] T055 `specs/023-label-triggered-autofix/plan.md` と `contracts/` を直す。Python の CLI の前提を TypeScript の今の構成に直し、雛形の一覧に行を足す形にする
- [ ] T056 `specs/023-label-triggered-autofix/tasks.md` を、T054・T055 に合わせて直す。作り直しになる範囲が広いときは、ユーザーに伝えて、tasks の工程のやり直しを仰ぐ
- [ ] T057 Epic #315 の本文の GAP を、共通の部分ができた後の差に直す

---

## Dependencies & Execution Order

### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | 積める | Phase 2 の雛形の許可リスト・`if`・`concurrency` が、Phase 1 で research.md と contracts に書く実機の結果を読む |
| 3 | 2 | 積める | Phase 3 の `workflow install` が、Phase 2 で足す雛形のファイルを読んで書き出す |
| 4 | 1 | 積める | Phase 4 の結果の決め方が、Phase 1 で research.md に書く失敗と上限の見分け方を読む |
| 5 | 4 | 積める | Phase 5 のスキルの文が、Phase 4 で足す MCP ツール `review_finish` を呼ぶ |
| 6 | 5 | 積める | Phase 6 の引き継ぎの分岐が、Phase 5 で分けた w-revise の Step 3 の節を指す |
| 7 | 3 | 積める | Phase 7 の w-onboarding の Step が、Phase 3 で足す MCP ツール `workflow_install`・`workflow_doctor` を使う |
| 8 | 6 | マージを待つ | Phase 8 の確かめは、action が既定のブランチから入れるプラグインと、npm の `@next` の `@pecot/workflow-mcp` を使う。どちらも、w-revise の変更が main に入っていないと流せない |
| 8 | 7 | マージを待つ | Phase 8 の導入の確かめは、既定のブランチから入るプラグインの w-onboarding と `workflow install` を使う。main に入っていないと流せない |
| 9 | 8 | 積める | Phase 9 の文書の直しが、Phase 8 で直す雛形の既定値と、research.md に書く試行の結果を読む |

### User Story Dependencies

| Story | フェーズ | 待つもの |
|---|---|---|
| US2（P1） | 2 | Phase 1 の結果 |
| US5（P3） | 3 | US2 の雛形 |
| US1（P1） | 4・5 | Phase 1 の結果 |
| US3（P2） | 6 | US1 の手順 |
| US4（P3） | 7 | US5 のコマンド |

Phase 2〜3 と Phase 4〜6 は、Phase 1 の後なら、互いを待たずに進められる。

### Within Each User Story

- テストのタスクを先に書き、落ちることを確かめてから実装する
- 定義書のタスクは、コマンドの実装の後、テストを通す前に済ませる
- 各フェーズの最後のタスクが、検証用での確かめだ

一部のタスクだけが待つ依存は、次のとおり。

| タスク | 待つもの |
|---|---|
| T001〜T008 | 検証用のリポと App（spec 026 の Phase 2） |
| T002〜T005 のうち、直したプラグインが要るもの | spec 026 の R11-6 の結果 |
| T011 | T002〜T006・T008 の結果 |
| T029・T030 | T007 の結果 |
| T035 | T005 の結果。返信の手段が無ければ、2 巡目は指摘の一覧に前のスレッドを並べる |
| T038・T042 | 直した w-revise を端末で読み込む手順（spec 026 の Phase 3） |
| T052 | ユーザーによる Claude の App のインストールと、secret の登録 |

### Parallel Opportunities

- Phase 1 の T002〜T008 は、別々の点を確かめるので並べて進められる
- Phase 3 の T015・T016・T017 は、別のテストのファイルなので並べて進められる
- Phase 4 の T025・T026・T027 は、別のテストのファイルなので並べて進められる
- Phase 2〜3 の並びと、Phase 4〜6 の並びは、触るファイルが分かれているので並べて進められる

`p-w/skills/w-revise/SKILL.md` は、Phase 5 と Phase 6 が直す。同じファイルなので、Phase 6 は Phase 5 の上に積む。
`p-w/interface/authored.yaml` は、Phase 3 と Phase 4 が項目を足す。先に main へ入った変更を取り込んでから書く。

## Parallel Example: User Story 5

```text
T015 雛形の一覧と版の比べ方の単体テストを書く
T016 pecot workflow install のテストを書く
T017 pecot workflow doctor のテストを書く
```

## Implementation Strategy

### MVP First

Phase 1・2・4・5 で、PR の作成から指摘の投稿までが通る。雛形は手で写して置く。ここまでで、w-revise の打ち忘れで指摘の無い PR が無くなる。

### Incremental Delivery

1. Phase 1 で、実機の結果をそろえる
2. Phase 2 で、安全策の入った雛形を置く
3. Phase 4・5 で、指摘の投稿までを通す（MVP）
4. Phase 6 で、端末での続きを足す
5. Phase 3・7 で、導入のコマンドと手順を足す
6. Phase 8 で、配られた版で通し、このリポへ導入する
7. Phase 9 で、spec 023 を合わせる

## Notes

- Phase 1 と Phase 8 は、Epic #456（spec 026）の検証用を使う。検証用がまだ整っていなければ、Phase 1 の着手は #456 の Phase 2 を待つ
- プラグインの hooks は、Epic #387 が減らしている途中だ。T003 は、その時点の hooks で確かめる
- 修正まで進める形・push のたびの起動・コメントでの呼び出し・board sync の雛形の移行は作らない（plan.md の Constitution Check の IV）
- board sync の雛形は `pull_request_target` を使う。2026-12-02 からの既定の policy の件は、この spec では扱わない。事実は research.md の最後の表に書いた

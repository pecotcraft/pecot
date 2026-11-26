# GitHub Projects と Issue の機能の棚卸し

GitHub Projects と Issue の機能ごとに、pecot の今の使い方と、使うか使わないかの判断と理由を残す一覧です。保守者が読む文書で、プラグインの動作は決めません。

機能は、次の 2 つの目次の末端の記事から拾いました（2026-11-26 に読んだ版）。

- [Planning and tracking with Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects)
- [Tracking your work with issues](https://docs.github.com/en/issues/tracking-your-work-with-issues)

機能の紹介だけの記事（about・quickstart・best practices）は、行にしていません。GitHub が記事を足したら、表に行を足します。

## 判断の分け方

| 判断 | 当てるもの |
|:---|:---|
| 使う | pecot がすでに使っている。または、これから準備の操作か案内に入れる |
| 使わない（`attributes` で書ける） | pecot の流れでは使わないが、`issue_create`・`issue_edit` の `attributes` で利用者が値を書ける |
| 使わない | pecot の流れの外、GitHub が計算する、または画面だけの操作 |
| 使わない（preview） | 文書に public preview とある。GA になったら見直す |
| 独自の仕組み | 同じ役割を pecot が独自に持つ。[独自の仕組み](#独自の仕組み) の節に、扱いと記録を書く |

Issue の機能を項目ごとにどう扱うかは、[`interface/issue-coverage.yaml`](../interface/issue-coverage.yaml) を正とします。この一覧の Issue の行は、判断をそれと揃え、項目の `id` を挙げるだけにします。

## Projects

### 作る・項目を扱う

| 機能 | pecot の今の使い方 | 判断 | 理由 | 関連する Issue |
|:---|:---|:---|:---|:---|
| [プロジェクトを作る](https://docs.github.com/en/issues/planning-and-tracking-with-projects/creating-projects/creating-a-project) | `project_create` が、pecot の欄と `Lanes` のビューを付けて作る | 使う | — | #703 |
| [プロジェクトをコピーする](https://docs.github.com/en/issues/planning-and-tracking-with-projects/creating-projects/copying-an-existing-project) | 使っていない | 使わない | pecot はコピー元のボードを持たず、保守もしない。既存のボードを整える `project_init` には当てはまらない | — |
| [項目を足す](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project) | `issue_create` が起票と同時にボードへ載せる。`board_add` が既存の Issue を載せる | 使う | — | — |
| [下書きの Issue を Issue にする](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/converting-draft-issues-to-issues) | 使っていない | 使わない | pecot は下書きの Issue を作らず、初めから Issue で起票する | — |
| [項目をまとめて直す](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/editing-items-in-your-project) | 使っていない | 使わない | 画面だけの操作。pecot は `board_move` で 1 件ずつ動かす | — |
| [項目をアーカイブする](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/archiving-items-from-your-project) | `issue_reopen` が、アーカイブされた項目を戻す。退避は `Archived` の列で行う | 独自の仕組み | [2. `Archived` の列](#独自の仕組み) | — |

### 欄

| 機能 | pecot の今の使い方 | 判断 | 理由 | 関連する Issue |
|:---|:---|:---|:---|:---|
| [テキスト・数値の欄](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-text-and-number-fields) | 作らない | 使わない（`attributes` で書ける） | pecot の流れに見積もりが無い。`graphql:ProjectV2FieldValue.text`・`.number` | #702 |
| [日付の欄](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-date-fields) | 作らない | 使わない（`attributes` で書ける） | pecot の流れに期日が無い。`graphql:ProjectV2FieldValue.date` | — |
| [単一選択の欄](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-single-select-fields) | `pecot-status`・`pecot-lane` を作り、既定の `Status` に `Blocked`・`Needs Attention` を足す | 使う | — | #701・#703 |
| [Iteration の欄](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-iteration-fields) | 作らない | 使わない（`attributes` で書ける） | pecot の流れに期日が無い。`graphql:ProjectV2FieldValue.iterationId` | — |
| [Issue fields](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-issue-fields) | 作らない。既定の Priority・Effort・Start date・Target date も使わない | 使わない（`attributes` で書ける） | pecot の判定に優先度・見積もり・期日を使わない。`graphql:CreateIssueInput.issueFields` | #702・#705 |
| [親の Issue・sub-issue の進み具合の欄](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields) | 親は `issue_create` が付ける。進み具合は読まない | 使う（親）・使わない（進み具合） | 進み具合は GitHub が計算する。`graphql:enum:ProjectV2FieldType.PARENT_ISSUE`・`.SUB_ISSUES_PROGRESS` | — |
| [Pull Request の欄](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-pull-request-fields) | 使っていない | 使わない | GitHub が計算する。`graphql:enum:ProjectV2FieldType.LINKED_PULL_REQUESTS`・`.REVIEWERS` | — |
| [Issue type の欄](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-the-issue-type-field) | ボードの欄としては読まない。Epic の判定は Issue の `issueType` を読む（Issue の節の「Issue type」の行） | 使わない（`attributes` で書ける） | `graphql:enum:ProjectV2FieldType.ISSUE_TYPE` | — |
| [欄の名前を変える](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/renaming-custom-fields) | `project_init` が、前の名前の進行の欄を `pecot-status` に変える | 使う | — | #701 |
| [欄を消す](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/deleting-custom-fields) | `project_init` が、`confirm_delete` で `pecot-priority`・`pecot-size` を消す | 使う | — | #702 |

### ビュー

| 機能 | pecot の今の使い方 | 判断 | 理由 | 関連する Issue |
|:---|:---|:---|:---|:---|
| [ビューのレイアウト](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/changing-the-layout-of-a-view) | `Lanes` のビューを Board で作る | 使う | — | #703 |
| [Table のレイアウト](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-table-layout) | GitHub が作る既定のビューのまま | 使わない | pecot が足すビューは `Lanes` だけ | — |
| [Board のレイアウト](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout)（列・Group by） | `Lanes` のビューが、`pecot-status` を列にし、`pecot-lane` で横に分ける（`project.ts` の `viewBodyOf`） | 使う | — | #703 |
| Board のレイアウト（Slice by・Field sum・列の上限・並べ替え） | 使っていない | 使わない | 数値の欄を持たない。進行中の数は worktree の数で決まる | — |
| [Roadmap のレイアウト](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-roadmap-layout) | 使っていない | 使わない | pecot の流れに期日が無い | — |
| [フィルタ](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/filtering-projects) | `Lanes` のビューにフィルタを付けない | 使わない | 列と横の分け方で全件を見せる | — |
| [ビューを作る・保存する](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/managing-your-views) | `project_create`・`project_init` が REST の API で `Lanes` を作る | 使う | Group by は GraphQL では設定できないので、REST を使う（research R10） | #703 |

### 自動化

| 機能 | pecot の今の使い方 | 判断 | 理由 | 関連する Issue |
|:---|:---|:---|:---|:---|
| [組み込みの自動化](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations) | 止めない。閉じた項目・マージした PR の `Status` を `Done` にする 2 つが、初めから有効 | 使わない | pecot は `Done` を読まず、書かない。自動化は、ほかの Issue の状態を条件にできず、進行の欄も動かせない（specs/024 research R10） | — |
| `Status` と Issue の status の同期（Sync with issue status） | 止めない。初めから有効 | 使わない（preview） | Issue の status が preview。同期の先は、pecot が札を書く `Status` と同じ欄なので、GA になったら合わせて見直す | — |
| [API で扱う](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) | ボードの読み書きは GraphQL、ビューの作成は REST | 使う | — | — |
| [Actions で扱う](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions) | `pecot-board-sync.yml` の雛形が、Issue・PR の出来事で `board_sync` を動かす | 使う | — | #434 |
| [項目を自動で足す](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically) | 使っていない | 使わない | 起票のときに pecot がボードへ載せ、列と札も同時に書く。自動で足す仕組みは欄を書けない | — |
| [項目を自動でアーカイブする](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/archiving-items-automatically) | 使っていない | 独自の仕組み | [2. `Archived` の列](#独自の仕組み) | — |

### Insights

| 機能 | pecot の今の使い方 | 判断 | 理由 | 関連する Issue |
|:---|:---|:---|:---|:---|
| [Insights のグラフ](https://docs.github.com/en/issues/planning-and-tracking-with-projects/viewing-insights-from-your-project)（作る・設定する） | 使っていない | 使う（案内に入れる） | `pecot-lane` ごとの件数のグラフで、領域の偏りを画面で見られる（Epic #542 の目標）。グラフを作る API が無いので、w-onboarding で手順を案内する | #772 |

### 管理

| 機能 | pecot の今の使い方 | 判断 | 理由 | 関連する Issue |
|:---|:---|:---|:---|:---|
| [公開範囲](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/managing-visibility-of-your-projects)・[アクセス](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/managing-access-to-your-projects) | 触らない | 使わない | 利用者が決める | — |
| [組織のテンプレート](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/managing-project-templates-in-your-organization) | 使っていない | 使わない | 組織のボードだけの機能で、ユーザーのボードでは使えない | — |
| [閉じる・消す](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/closing-and-deleting-your-projects) | 使っていない | 使わない | pecot の流れの外 | — |
| [リポに付ける](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/adding-your-project-to-a-repository) | `project_link` が、登録するリポをボードにつなぐ | 使う | — | — |
| [チームに付ける](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/adding-your-project-to-a-team)・[書き出す](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/exporting-your-projects-data) | 使っていない | 使わない | pecot の流れの外 | — |
| [プロジェクトを探す](https://docs.github.com/en/issues/planning-and-tracking-with-projects/finding-your-projects) | 画面の操作は使わない。pecot は `project_search`・`project_list` で API から探す（「API で扱う」の行） | 使わない | 画面だけの操作 | — |
| [status updates](https://docs.github.com/en/issues/planning-and-tracking-with-projects/sharing-project-updates) | 使っていない | 使わない | Epic の進みは、引き継ぎのワークフローが Epic へのコメントで書く | — |

## Issue

### 使う

| 機能 | pecot の今の使い方 | 判断 | 理由 | 関連する Issue |
|:---|:---|:---|:---|:---|
| [Issue を作る](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue) | `issue_create` | 使う | `graphql:mutation:createIssue` | — |
| [sub-issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) | `issue_create` が親の Epic に付ける。並びは変えない | 使う | `graphql:mutation:addSubIssue`。並びは [5. 題の通し番号](#独自の仕組み) | — |
| [sub-issue をたどる](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/browsing-sub-issues) | 画面で利用者が使う | 使わない | 画面だけの操作 | — |
| [依存](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies) | `issue_block`・`issue_unblock` が blocked by を付け外しする。着手の可否の判定に読む | 使う | `graphql:mutation:addBlockedBy`・`removeBlockedBy` | — |
| [担当者](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users) | pecot の流れでは付けない | 使わない（`attributes` で書ける） | `graphql:CreateIssueInput.assigneeIds` | — |
| [Issue を直す](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/editing-an-issue) | `issue_edit` が属性を書き、`issue_block` が本文の節を書く | 使う | `graphql:mutation:updateIssue` | — |
| [Issue からブランチを作る](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-a-branch-for-an-issue) | `session_start` が Issue に紐づくブランチを作る | 使う | `graphql:mutation:createLinkedBranch` | — |
| [PR を Issue につなぐ](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) | `pr_create` が本文に closing keyword を書く | 使う | `graphql:mutation:addCloseIssueReferences` は使わない | — |
| [Issue type](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-types) | 起票で書き、Epic の判定に読む。型を作るのは利用者 | 使う | `graphql:CreateIssueInput.issueTypeId` | — |
| [Issue fields を定める](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields)・[値を書く](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-and-managing-issue-fields) | 定めない。値は利用者が書ける | 使わない（`attributes` で書ける） | `graphql:mutation:setIssueFieldValue` | #705 |
| [Issue を閉じる](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/closing-an-issue) | `session_finish` が、マージした PR の Issue を閉じる | 使う | `graphql:mutation:closeIssue` | — |

### 使わない

| 機能 | 判断 | 理由 |
|:---|:---|:---|
| [Issue と PR の一覧の画面](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/viewing-all-of-your-issues-and-pull-requests)・[絞り込みと検索](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)・[slash commands](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/about-slash-commands) | 使わない | 画面だけの操作 |
| [AI での triage](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/triaging-an-issue-with-ai) | 使わない | pecot の流れの外 |
| [固定する](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/pinning-an-issue-to-your-repository) | 使わない | `graphql:mutation:pinIssue` |
| [重複にする](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/marking-issues-or-pull-requests-as-a-duplicate)・[複製する](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/cloning-an-issue) | 使わない | pecot の流れの外 |
| [別のリポに移す](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/transferring-an-issue-to-another-repository) | 使わない | `graphql:mutation:transferIssue` |
| [消す](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/deleting-an-issue) | 使わない | `graphql:mutation:deleteIssue` |

### preview

| 機能 | 重なる pecot の仕組み | 判断 | 理由 |
|:---|:---|:---|:---|
| [Issue の status](https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issue-statuses)・[その webhook と workflow](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/issue-status-webhooks-and-workflows) | 進行の欄 `pecot-status` | 使わない（preview） | `graphql:CreateIssueInput.statusId`。GA になったら見直す |
| [Issue の artifacts](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/using-artifacts-with-issues) | Issue に投稿する計画のコメント（`cli/templates/comment/plan.md`） | 使わない（preview） | GA になったら見直す |

## 独自の仕組み

GitHub の機能と役割の重なる、pecot 独自の仕組みです。決めたときの記録を確かめ、扱いを書きます。

| 仕組み | 重なる GitHub の機能 | 記録 | 扱い |
|:---|:---|:---|:---|
| 1. 進行の欄 `pecot-status` と、札としての `Status` | 既定の `Status` の欄 | `specs/024-issue-readiness-stacked-prs/spec.md` の Clarifications と FR の前提（2026-11-12 に利用者が決めた）。既定の Status は進み具合の軸で、着手の可否を混ぜない | 意図して独自に持つ |
| 2. `Archived` の列と、`board_sync` が最新の 20 件を超えた分をボードから消す処理 | 項目のアーカイブ、自動でアーカイブする組み込みの自動化 | 理由の記録なし。最初のコミットからある。探した記録は specs の全部、`board-view.ts` のコメント、git の履歴 | 未決 |
| 3. `Blocked` の列 | 依存を持つ Issue に出る Blocked の印 | `specs/024-issue-readiness-stacked-prs/spec.md` と research R10。組み込みの自動化は、ほかの Issue の状態を条件にできず、進行の欄を動かせない。Blocked の印はそのまま出し、列で着手の可否を示す | 意図して独自に持つ |
| 4. 題の接頭辞 `[Task]`・`[Epic]`・`[Tracker]`・`[Bug]` | Issue type | 理由の記録なし。Tracker の判定は接頭辞で行う（`cli/src/domain/readiness.ts`） | 未決 |
| 5. 題の通し番号 `#<Epic>-<番号>:` | sub-issue の親と並び | `specs/024-issue-readiness-stacked-prs/` の FR-043 と R13 は番号の形を決めた記録で、sub-issue の並びを使わない理由は書かれていない | 未決 |
| 6. `pecot-template://` の Issue の雛形 | リポの Issue テンプレート（`graphql:CreateIssueInput.issueTemplate`） | `issue-coverage.yaml` に扱いはあるが、リポの Issue テンプレートを使わない理由は書かれていない | 未決 |

「未決」は、標準の形に直すか、理由を書いて残すかを、まだ決めていない仕組みです。#709 では、意図して持つ可能性を確かめないまま不適合と呼ばないよう、利用者が承認した計画に沿って、起票せずにこの表へ残しました。決めるときは Epic の下に起票し、残すならその Issue の計画に利用者の承認と理由を書きます（憲法の原則 IV）。

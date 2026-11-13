# Implementation Plan: Issue の着手の可否を依存関係から判定し、前提が PR 中なら stacked PRs として積んで進める

**Branch**: `024-issue-readiness-stacked-prs` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/024-issue-readiness-stacked-prs/spec.md`

## Summary

pecot-workflow に、Issue の前後関係を GitHub の blocked by で持たせ、着手の可否を CLI が計算する仕組みを足す。
判定は 3 つある。着手できる、積めば着手できる、ブロック中だ。
判定の規則は domain の純粋な関数に置く。一覧・着手・PR の作成・マージの片付けが、同じ関数を使う。
ボードの進行の欄に `Blocked` の列を足す。`Ready` の列は、今着手できる Issue だけにする。
列は判定の写しで、pecot の操作と Actions のワークフローが動かす。一覧を出す操作は動かさない。着手の操作は列を読まない。
前提が PR 中の Issue は、前提のブランチを base にして着手する。PR は GitHub のスタックとして登録する。
スタックの登録とマージは、GitHub の REST の API を直接呼ぶ。`gh stack` 拡張には依存しない。
前提には種類がある。積める前提と、マージを待つ前提だ。種類は tasks.md の前提の表で決め、マージを待つ前提だけを Issue の本文に残す。
w-breakdown が前提の表を書かせ、w-issueize がそれを blocked by に変える。進め方と積める並びは CLI が計算する。

## Technical Context

| 項目 | 内容 |
|---|---|
| Language/Version | TypeScript（Node 24。pecot-workflow の CLI）、Bash（hooks）、Markdown（スキルとテンプレート） |
| Primary Dependencies | commander・zod（既存）。GitHub は `fetch` で GraphQL と REST を直接呼ぶ。足す依存は無い |
| Storage | GitHub の Issue（blocked by と本文）・PR・スタック・ボード。手元は `.pecot/state/` の状態のファイルと `.pecot/config/projects/*.json` |
| Testing | vitest（単体と `tests/interface/`）、偽の GitHub サーバ（`tests/fake-github/`）、スキルの文書のテスト、このリポでの CUJ |
| Target Platform | 利用者の端末（Claude Code と GitHub Copilot CLI） |
| Project Type | 配布するプラグイン（CLI・スキル・テンプレート・hooks） |
| Performance Goals | `pecot project info` は、Ready と Blocked が合わせて 50 件のボードで、判定の分の増加を 5 秒以内に収める。GraphQL の点数は 1 回あたり 60 点以下にする（前提の無い Issue は個別に読まない） |

**Constraints**:

- CLI の変更は Node の CLI にだけ入れる。Python の CLI には触れない。実装は Epic #42 の Python の削除（#351）の後に置く
- パスは、spec 020 の T080 が `cli-node/` を `cli/` に移した後の形で書く
- 着手の操作と一覧の表示は、ボードの列を判定の根拠にしない
- 前提の付いていない Issue だけを使うリポでは、着手・PR・マージの動きを変えない
- `Blocked` と `Needs Attention` が無いボードでも、設定の読み込みを通す
- `gh stack` 拡張を求めない。エージェントが `gh stack` を直接打つことは hook で止める
- この spec の「main」は、設定の `develop_branch` を指す
- 検証を迂回しない。`--no-verify` を使わない
- ルート直下にディレクトリを足さない

**Scale/Scope**:

- 新しいコマンド 4 つ（`issue block`・`issue unblock`・`pr merge`・`pr restack`）。コマンドの数は 34 から 38 になる
- 振る舞いを変えるコマンド 7 つ。`issue create`・`issue read`・`create-branch`・`pr create`・`pr cleanup`・`project init`・`project info` だ
- 表示を足すコマンド 1 つ（`session status`）
- スキル 6 本（w-breakdown・w-issueize・w-active・w-pr・w-merge・w-revise）と、w-help の文書
- Issue のテンプレート 1 つ、hook の規則 2 つ（Bash 用と MCP 用が 1 つずつ）
- 定義書の項目 4 つと、振る舞いの項目の追加

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 合格 | 判定・進め方・列を直す判断・前提の表の読み取りは `src/domain/` に置く。GitHub と git の呼び出しは `src/infra/` に置く。`src/commands/` は引数と出力だけを持つ。層の向きと domain の I/O は、既存の eslint の設定が止める |
| II. TDD | 合格 | 判定と列を直す判断は、入力の組を表にして、失敗するテストを先に書く。期待は判定の値と理由の文字列で比べる。モックは HTTP と git の境界だけにする。定義書に振る舞いの項目を足し、`verifies` でテストにつなぐ。単体テストの後に、このリポの実際の Issue で確かめる |
| III. コード品質 | 合格 | 新しいコードは tsc の strict・eslint・knip の対象に入る。定義書とスキルの文書のテストを、既存のレーンで通す |
| IV. YAGNI | 条件つき合格 | コマンドを 4 つと、ボードの値を 2 つ足す。理由は Complexity Tracking に書く。GitHub Actions のワークフロー、Epic ごとの統合ブランチ、fork をまたぐスタック、スタックを見せるフィールドは作らない |
| V. 本体優先 | 条件つき合格 | speckit 成果物は新規の一式を作る。既存の spec 023 の文書は、待ちの値の名前だけを直す。理由は Complexity Tracking に書く |

Phase 1 の設計の後も、同じ判定になる。

## Project Structure

### Documentation (this feature)

```text
specs/024-issue-readiness-stacked-prs/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cli-commands.md
│   ├── prerequisite-table.md
│   └── skill-flow.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
plugins/pecot-workflow/
├── cli/
│   ├── src/
│   │   ├── domain/
│   │   │   ├── readiness.ts            # 新規。着手の判定・進め方・積める並び・輪の確認
│   │   │   ├── board-move.ts           # 新規。列を直す判断
│   │   │   ├── prerequisites.ts        # 新規。本文のマージを待つ前提の節の読み書き
│   │   │   ├── config.ts               # 進行の欄に blocked、fields.status
│   │   │   ├── frontmatter.ts          # blocked_by を足す。parallel を外す
│   │   │   ├── format.ts               # 列の並びと、一覧の判定の列
│   │   │   ├── pull-request.ts         # 積んだ PR の base を通す
│   │   │   └── state.ts                # base の記録のフラグ
│   │   ├── infra/
│   │   │   ├── github/queries.ts       # blocked by・選択肢の更新・Issue の PR
│   │   │   ├── github/issues.ts        # 前提の読み書き
│   │   │   ├── github/projects.ts      # 選択肢の追加、既定の Status の読み書き
│   │   │   ├── github/pulls.ts         # スタックの登録と読み取り、非同期のマージ
│   │   │   ├── git.ts                  # 載せ直しと push
│   │   │   └── state-store.ts          # base の記録
│   │   └── commands/
│   │       ├── issue-dependency.ts     # 新規。issue block・unblock
│   │       ├── issue-create.ts         # 前提の登録、--plan、通し番号
│   │       ├── issue-shared.ts         # 状態の検証、タイトルの番号
│   │       ├── issue-read.ts           # 前提の一覧と判定
│   │       ├── issue-board.ts          # 列を動かす共通の処理
│   │       ├── repository.ts           # create-branch が判定で base を選ぶ
│   │       ├── pr.ts                   # create・cleanup の変更、merge・restack の追加
│   │       ├── project.ts              # init が値を足す、info が判定を表示する
│   │       ├── project-info.ts         # 判定の計算と表示
│   │       ├── project-sync.ts         # 値の定義と、足りない値の扱い
│   │       └── session.ts              # status にスタックの位置
│   ├── tests/
│   │   ├── interface/                  # コマンドごとの振る舞いのテスト
│   │   ├── fake-github/operations.ts   # 新しいクエリの行
│   │   └── parity/commands.ts          # コマンドの一覧
│   └── templates/issue/task-implement.md   # blocked_by を足す。parallel と段の説明を外す
├── interface/
│   ├── authored.yaml                   # 4 つの項目と、振る舞いの項目
│   └── generated.json                  # 書き出し直す
├── hooks/lib/
│   ├── core/gh-command-check.sh        # gh stack を止める
│   ├── core/pecot-tool-names.sh        # ツール名の一覧
│   └── mcp-handlers/pecot-post-ask.sh  # pr_merge を確認にかける
└── skills/
    ├── w-breakdown/SKILL.md            # tasks の工程に前提の表を書かせる
    ├── w-issueize/SKILL.md             # 表を frontmatter に写す。段の計算をやめる
    ├── w-active/SKILL.md               # base の判断を CLI に任せる
    ├── w-pr/SKILL.md                   # 積んだ PR の説明
    ├── w-merge/SKILL.md                # pecot pr merge に変える
    ├── w-revise/SKILL.md               # 上の段の載せ直しの報告
    └── w-help/references/              # board-status.md・issue-flow-rules.md・spec-driven-workflow.md

specs/023-label-triggered-autofix/      # 待ちの値の名前だけを直す
.nx/version-plans/                      # PR ごとの version plan
```

**Structure Decision**: 新しいコードは pecot-workflow の中だけに置く。判定の規則は `src/domain/readiness.ts` の 1 か所に置き、列を直す判断は `src/domain/board-move.ts` に置く。どちらも I/O を持たない。

## 実装の段階と PR

| 段階 | 中身 | 対応 |
|---|---|---|
| 1 | 書き込まないと確かめられない点を、検証用のリポで確かめる（[research.md](research.md) の R14） | — |
| 2 | 前提の読み書きと、着手の判定の関数 | FR-010〜FR-015、FR-059〜FR-061、FR-063 |
| 3 | ボードの値の追加と、列の定義の文書。`project init` の拡張 | FR-064〜FR-067、FR-071〜FR-075、FR-082 |
| 4 | 一覧と個別の表示に判定を出す。一覧は列を直さない | US2、FR-016、FR-017、FR-069、FR-070、FR-078〜FR-081、FR-083、FR-084 |
| 5 | 一括投稿が前提を付ける。進め方と通し番号。テンプレートと w-issueize | US1、FR-001〜FR-006、FR-018、FR-043、FR-046〜FR-051、FR-055〜FR-058 |
| 6 | 前提の付け外しと種類の変更 | US7、US9、FR-007〜FR-009、FR-062 |
| 7 | 着手が判定で base を選ぶ。w-active | US3、FR-019〜FR-024 |
| 8 | 積んだ PR の作成とスタックの登録。w-pr | US4、FR-025〜FR-031、FR-041 |
| 9 | マージのコマンドと、片付けの後の通知。w-merge と hook | US5、FR-032〜FR-035、FR-068 |
| 10 | 載せ直しのコマンド。w-revise | US6、FR-036〜FR-040 |
| 11 | w-breakdown が前提の表を書かせる | US8、FR-052〜FR-054 |
| 12 | w-help の文書、spec 023 の名前の修正、このリポでの CUJ | FR-042、FR-044、FR-045、FR-076、FR-077、SC-001〜SC-016 |

段階 5 までで、Issue 化からボードの列までが通る。段階 7 から 10 が、積んで進める動線だ。
段階の前後関係と種類は、tasks.md の前提の表に書く。

## Complexity Tracking

| 足すもの | 要る理由 | より単純な案を採らない理由 |
|---|---|---|
| `pecot issue block`・`unblock` | 計画が変わったときに、前提と種類を直す手段が要る。ブロックを無視して着手する指定を作らないので、直す操作が唯一の出口になる | GitHub の画面で直す形は、本文のマージを待つ前提の節と blocked by が食い違う |
| `pecot pr merge` | スタックの中の PR は、今までのマージ API で拒まれる。最下段でない PR のマージを止める判断も要る | `gh pr merge` を残すと、積んだ PR で必ず落ちる |
| `pecot pr restack` | 載せ直しには、記録した古い base の位置が要る。スキルの文で git の手順を書くと、位置の取り違えが起きる | `gh stack rebase` は、ほかの作業ディレクトリの状態で全体が止まる |
| 進行の欄の `Blocked` | `Ready` を「着手できる」の意味にするには、前提を待つ Issue の置き場が要る | `Pending` に置く形は、人が後回しにした Issue と区別できない |
| 既定の Status の `Needs Attention` | 前提がマージされずに閉じられた Issue は、人の判断が要る。spec 023 が同じ値を足すので、増える値は 1 つだ | 専用の列やラベルを足すと、人の判断を待つ印が 2 つになる |
| spec 023 の文書の修正 | 待ちの値の名前を `Needs Attention` にそろえる。spec 023 は未実装で、古い名前のまま実装されると、後で値の移行が要る | 文書を直さずに実装の時に読み替える形は、読み替えを忘れる |

---
name: w-active
description: |
  Readyタスクを選択しブランチ作成・実装開始します。
  Use when the user wants to start an existing Ready task — picks the Issue, creates a feature branch, enters plan mode. Triggers: "next task", "pick a task", "start implementing".
  Do NOT use for new tasks from scratch (use w-quick) or for Issue-only creation (use w-ready).
when_to_use: "Ready のタスクに着手したい、次のタスクを始めたい、Issue の実装を開始したい"
---

# Readyからタスクを実装

## pecot CLI ランチャー

pecot CLI は実行環境ごとにランチャーを変数化してから使う。

Claude Code:

```bash
PECOT=pecot
```

GitHub Copilot CLI は shell tool の PATH にプラグイン `bin/` が入らないため、最初からインストール済み wrapper を使う。

```bash
PECOT="$HOME/.copilot/installed-plugins/pecot/pecot-w/bin/pecot"
```

以降の pecot CLI コマンド例は必ず `$PECOT ...` として実行する。

**Readyステータスのタスクから1個選択→ブランチ作成→調査→計画ドラフト作成→レビュー→プランモードで計画を最終化。**

## 手順

### Step 1: 事前確認とプロジェクト情報表示

#### 事前セルフチェック（CLI ガードの予習）

`pecot create-branch` は CWD–Issue ref 整合と `.pecot-active` 上書きを自身でガードする。着手前に状況を把握しておくと、exit 2 で止められる前に対処できる。

```bash
$PECOT session status -D .
```

`.pecot-active` の内容と `=== アクティブIssue ===` の OPEN/CLOSED が出る。違反時の対応:

1. `.pecot-active` に OPEN な別 Issue ref が残っている場合、`create-branch` は exit 2 になる。前 Issue を片付けてから着手する。stale だと確信できるケースのみ `--force-overwrite-active` を付ける。
2. CWD のリポが対象 Issue の `owner/repo` と異なる場合、`create-branch` は exit 2 になる。対象リポの既存 WT（`<project-root>/base/<repo>/` または `<project-root>/<wtN>/<repo>/`）へ `cd` してから着手する。
   スクリプト経由など CWD 外発行のみ `--allow-cross-repo` を付ける。
3. 未コミット差分が新 Issue のスコープ外にある場合、CLI ガードの対象外になる。commit / stash / 破棄で clean にしてから着手する。前 Issue 由来なら先にその Issue を完了させる。

詳細根拠は [`w-help/references/issue-flow-rules.md`](../w-help/references/issue-flow-rules.md) §5。

#### プロジェクト情報表示

ボード状態とIssue一覧を確認し、どのタスクを選択するか判断する

```bash
$PECOT project info
```

### Step 2: 対象タスクを確認

ユーザーが選択したタスクのIssue内容を確認する

```bash
$PECOT issue read owner/repo/XXX
```

### Step 3: ベースブランチを最新化

ブランチ作成前に、現在のブランチを最新化する。

```bash
git pull
```

### Step 4: ブランチ作成

```bash
$PECOT create-branch owner/repo/XXX feat/description
```

**ブランチ名の決め方:**

- `feat/` + タスクの簡潔な説明（英語、ケバブケース）
- 例: `feat/add-user-authentication`, `feat/fix-login-bug`

### Step 5: ブランチ切り替え

CLIの案内メッセージに従ってブランチを切り替える。
案内メッセージにはリポジトリ名（`owner/repo`）が表示されるので、**そのリポジトリの** ワークツリーで実行すること。

```bash
git fetch origin
git checkout feat/description/XXX
```

**CWDと対象リポジトリが異なる場合:**

CLIはブランチを作成したリポジトリ名を案内メッセージに表示する。
例: `★ acme-labs/pecot-presentation-private のワークツリー(wt2)で以下を実行してください`。
CWDが別リポジトリであっても、案内に表示されたリポジトリのワークツリーで `git checkout` を実行する。
ワークスペース内に該当リポジトリのワークツリーがあれば、そのディレクトリで実行すればよい。

案内されたWT名が作業対象リポジトリに存在しない場合は、
`/pecot-w:w-worktree-add` コマンドでWT作成を案内するか、作業を中止する。

### Step 6: 調査（通常モード・読み取り中心）

ブランチ切り替えが完了したら、まず**通常モードのまま**調査する。この段階では
EnterPlanMode を呼ばない。

Issue の Tasks / Acceptance を起点に、次を読み取り中心で把握する。

- 変更対象になるファイルと、その周辺の既存パターン
- 参考にすべき既存実装・命名規約
- テスト構成（どのテストがどの範囲を守っているか）

読み取り中心の調査であり、この段階でコードは編集しない。調査で得た事実が
次の計画ドラフトのもとになる。

### Step 7: 計画ドラフト作成

調査結果をもとに、**通常モードのまま**実装計画のドラフトを作成する。

ドラフト本体の書式は、`$PECOT issue comment --prepare -t plan` で得る plan テンプレが決める。

ドラフトには `## PECOT-Workflow` セクション（E2E）を
概形として含める。ここでは項目の当たりを付ける程度でよく、書式全文をこの SKILL.md
から複製しない。書式への最終適合は Step 9 のプランモード側で行う。

### Step 8: レビュー（通常モード・一巡 1 回）

計画ドラフトが完成したら、EnterPlanMode の前に**通常モードのまま**専門視点レビューを
受ける。この段階でも EnterPlanMode を呼ばない。

- w-tech-advisor を `Agent` ツールの単発 spawn でレビュー依頼する
- w-e2e-planner を `Agent` ツールの単発 spawn でレビュー依頼する
- 2 者の並列 spawn を既定とする。直列にする場合のみ、理由を `w-tech-advisor` の Goal 末尾に括弧書きで添える（例: `(直列の理由: ...)`）。Goal は spawn prompt の冒頭行を指す
- 1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。
- 各エージェントの指摘をドラフトへ反映してから次の Step へ進む

レビューは**一巡 1 回**であり、指摘反映後の**再レビューは不要**。反映を終えたら
再度レビューを依頼せず、そのままプランモードへ進む。spawn 済みエージェントへの
追質問は `SendMessage` で行える。

### Step 9: プランモードに入る

レビュー指摘の反映まで終えたら、**必ずプランモードで計画を最終化する。** プランモードは
**計画最終化と承認の窓**で、レビュー反映後に呼ぶ最終ステップとして扱う。

**必須**: 以下のツールを呼び出してプランモードに入ること。

```
EnterPlanMode tool:
  (パラメータなし)
```

> [!TIP]
> 最終化編集の対象は、Step 7 のドラフトに Step 8 のレビュー指摘を反映した計画書である。
> 書式適合と承認を得るための仕上げをここで行う。書式は `$PECOT issue comment --prepare -t plan` で得る
> plan テンプレが決める。Step 7 で概形を置いた `## PECOT-Workflow` セクション
> （E2E）を、そのテンプレに最終適合させる。実装フェーズの
> w-implementer / w-e2e-planner 起動は ExitPlanMode 後のリマインダー
> （`exit-plan-implementer-remind.md`）が案内する。

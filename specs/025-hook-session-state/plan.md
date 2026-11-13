# Implementation Plan: pecot-workflow のフックを棚卸しし、状態をファイルに頼らない形にし、Claude Code の現行のプラグイン仕様に合わせる

**Branch**: `025-hook-session-state` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/025-hook-session-state/spec.md`

## Summary

この Epic は、pecot-workflow が持つ仕組みを 3 つの面で減らす。

1. フックは、pecot の流れを守る deny と、スキルの本文で代えられない案内 2 つだけを残す。承認（ask）・免除のフラグ・リマインダー・通知音・自動 push を撤廃する
2. 状態は、手元のファイルで持つのをやめる。作業中の Issue は、git の remote とブランチ名の末尾の番号から求める。スキルの起動に結びつく案内は、スキルの frontmatter の `hooks` に移す
3. 仕様は、現行の Claude Code の公式文書と見比べ、組み込みの機能（自動更新・通知）に任せられるものを README の推奨設定に移す

状態をファイルに持たないので、まっさらな clone から始まるクラウドのセッションでも、作業中の Issue が分かる。
状態管理より外のクラウド対応（プラグインの読み込み・GraphQL の拒否・`claude/…` のブランチ）は扱わない。

判定と根拠は [research.md](research.md) に置く。

| 節 | 中身 |
|---|---|
| R1 | フックと設定キーの判定の表 |
| R2 | スキルの frontmatter のフック |
| R3 | 当初諦めた状態管理の結論 |
| R6 | 現行の仕様との見比べ |
| R7 | 作業中の Issue の求め方 |
| R8 | w-breakdown と speckit のブランチ |
| R9 | クラウドのセッションの制約（記録だけ） |

## Technical Context

| 項目 | 内容 |
|---|---|
| Language/Version | Bash（hooks）、TypeScript（Node 24。pecot-workflow の CLI と MCP サーバ）、Markdown（スキル・エージェント・README） |
| Primary Dependencies | jq・git（既存）。足す依存は無い |
| Storage | 作業中の Issue は git から読む。`.pecot/state/` に残るのは、消えてもよいキャッシュと印の 3 つ |
| Testing | vitest（`cli/tests/hooks`・`cli/tests/interface`・`cli/src/**/tests`）、parity のシナリオと golden、定義書の検証、実機の記録 |
| Target Platform | 利用者の端末（Claude Code と GitHub Copilot CLI）。状態の持ち方は、クラウドのセッションでも成り立つ形にする |
| Project Type | 配布するプラグイン（hooks・スキル・MCP サーバ） |
| Performance Goals | フックの起動の回数が減る。足す処理は、フックの `git` の呼び出し 1 回だけ |

**Constraints**:

- #351（`cli-node/` を `cli/` に移す）は main に入った。パスとテストは、移した後の形で書く。pytest は無い
- Copilot CLI の動作は、撤廃と判定によるもの以外を変えない
- スキルの frontmatter に `hooks` を足すと、Copilot CLI も同じ SKILL.md を読む。未知の項目として無視されるかを実機で確かめる
- spec 024 の tasks の「`pr_merge` を確認にかける」項目とぶつかる。この Epic の撤廃を先に入れ、024 の該当 Issue に知らせる
- MCP ツールの入力と出力が変わる（`create_branch`・`issue_quick`・`session_status`・`session_restore`）。定義書と生成物を同じ変更で直す
- 検証を迂回しない。`--no-verify` を使わない
- ルート直下にディレクトリを足さない

**Scale/Scope**:

| 種類 | 内容 |
|---|---|
| 消す `hooks.json` のエントリ | PreToolUse の Edit 系・MCP・WebSearch、PostToolUse の Skill・Bash・ExitPlanMode、Stop、Notification |
| 変える `hooks.json` のエントリ | SessionStart の matcher に `compact` を足す |
| 消すスクリプト | `hooks.json` が直に呼ぶ 9 本と、サブスクリプトの約 30 本（R1 の「消す」の行） |
| 消す設定キー | 40 個のうち、R1 で「消す」としたもの。数は tasks で sample と見比べて確定する |
| 直すフック | `session-title`・`exit-plan-remind`（ブランチ名から求める）、`git-worktree-branch-check`、`git-no-verify-check`、`git-sync` の初期値 |
| 足すもの | w-active・w-quick の frontmatter の `hooks`、`exit-plan-remind.sh` の `--mode`、作業中の Issue を求める関数 |
| MCP ツールの変更 | `create_branch`（入力 2 つとガードを除く）、`issue_quick`、`pr_create`、`pr_cleanup`、`session_status`。`session_restore` を除く |
| スキルの変更 | w-active・w-quick・w-breakdown の SKILL.md、w-help の参照 3 つ、`agents/w-implementer.md` |
| 文書 | `hooks/README.md`（撤廃の反映・状態の表・推奨設定・対応バージョン・実機の記録） |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 合格 | 作業中の Issue を求める規則は `domain/` に置き、git の読み取りは `infra/` に置く。コマンドは求めた値を使うだけにする |
| II. TDD | 合格 | 契約の表（[contracts/](contracts/)）の行ごとに、先に期待を書き換えたテストを落としてから直す。消す振る舞いはテストも消し、定義書の項目を外す |
| III. コード品質 | 合格 | 既存の lint（shellcheck・eslint・tsc・knip）と、sample・README・スクリプトの同期のテストを通す |
| IV. YAGNI | 合格 | 撤廃で仕組みが減る。足すのは、frontmatter の `hooks`・引数 1 つ・関数 1 つだけ。クラウド向けの分岐は足さない |
| V. 本体優先 | 合格 | speckit 成果物は新規の一式だけ。spec 024 の文書は直さず、Issue で知らせる |

Phase 1 の設計の後も、同じ判定になる。

## Project Structure

### Documentation (this feature)

```text
specs/025-hook-session-state/
├── plan.md
├── research.md          # R1 がフックの判定の表
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── hook-behavior.md # フックの入力と出力
│   └── work-target.md   # 作業中の Issue と MCP ツール
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
plugins/pecot-workflow/
├── hooks/
│   ├── hooks.json                         # エントリを消し、SessionStart に compact を足す
│   ├── hooks-config.json.sample           # 撤廃したキーを消し、git-sync と git-no-verify-check を無効にする
│   ├── README.md                          # 撤廃の反映、状態の表、推奨設定、対応バージョン、実機の記録
│   ├── session-start.sh                   # 残るのはセッション名・.gitignore の補完・git-sync
│   ├── user-prompt-submit.sh              # 残るのは .pecot の初期化の検出
│   ├── pre-tool-use-skill.sh              # pecot-skill-compliance を外す
│   ├── （消すスクリプト）                 # pre-tool-use.sh、pre-tool-use-mcp.sh、pre-tool-use-websearch.sh、
│   │                                      # post-tool-use-*.sh、stop.sh、stop-copilot.sh、notification.sh
│   └── lib/
│       ├── adapters/claude-bash-guards.sh # 消すガードの段と、大きすぎるコマンドの ask を外す
│       ├── core/session-title.sh          # 番号をブランチ名から求める
│       ├── core/git-worktree-branch-check.sh  # develop-aist を対象から外す
│       ├── core/git-no-verify-check.sh    # 止める形を増やす
│       ├── core/mcp-guidance.sh           # ask とリマインドの案内の関数を消す
│       ├── post-tool-use/exit-plan-remind.sh  # --mode=active|quick を受け、ブランチ名から求める
│       ├── session-start-common.sh        # 消すサブスクリプトの呼び出しを外す
│       └── （消すディレクトリ）            # mcp-handlers/、notification/、stop/ と、R1 で「消す」の各スクリプト
├── com.github.copilot/hooks/hooks.json    # 同じ撤廃を入れる
├── skills/
│   ├── w-active/SKILL.md                  # frontmatter に hooks（--mode=active、once）。.pecot-active の確認を外す
│   ├── w-quick/SKILL.md                   # frontmatter に hooks（--mode=quick、once）。別のリポの worktree で checkout する手順を外す
│   ├── w-breakdown/SKILL.md               # 分解のタスクを起票し、そのブランチで speckit を動かす
│   └── w-help/references/{flags,issue-flow-rules,commands}.md
├── agents/w-implementer.md                # 編集してよいリポを、worktree の remote で決める
├── cli/src/
│   ├── domain/branch-name.ts              # 作業中の Issue を求める規則
│   ├── domain/state.ts                    # 消すフラグの定数を除く
│   ├── infra/state-store.ts               # .pecot-active の書き込みと、使わなくなる関数を除く
│   ├── commands/work-target.ts            # 題名のキャッシュと作業ディレクトリだけを作る
│   ├── commands/repository.ts             # 上書きガードと入力 2 つを除く
│   ├── commands/session.ts                # session_status を直し、session_restore を除く
│   └── commands/{pr,issue-create,issue-quick}.ts  # フラグの消費を除く。Closes の補完と片付けを直す
├── cli/tests/                             # hooks・interface・parity の期待と golden を直す
└── interface/{authored.yaml,generated.json}   # 変えた MCP ツールの項目を直す
```

**Structure Decision**: 既存の構成（`hooks.json` に登録したスクリプト → `lib/` の関数、`cli/src` の `domain`・`infra`・`commands`）に合わせる。新しいディレクトリは足さない。

## 進め方

変更は、利用者から見たまとまりごとに分ける。tasks は、この順で phase を切る。

| 順 | まとまり | spec | 前提 |
|---|---|---|---|
| 1 | 承認と免除の撤廃（ask・免除のフラグ・`pecot` の deny・GitHub MCP の deny・大きすぎるコマンド） | US1 | 無い |
| 2 | リマインダー・動作安定用・通知音・`auto-push` の撤廃。SessionStart の整理 | US2 | 1（同じスクリプトを触る） |
| 3 | 残るフックの手直し（`git-no-verify-check`・`git-worktree-branch-check`・`git-sync` の初期値・compact・呼び出し元の無いコード） | US3 | 2 |
| 4 | 作業中の Issue を git から求める（CLI・MCP ツール・`session-title`・文書） | US6 | 無い（1〜3 と並べて進められる） |
| 5 | 計画の承認の後の案内を frontmatter のフックに移す。`.pecot-quick-mode` を消す | US4 | 2・4（`exit-plan-remind` が作業中の Issue を読む） |
| 6 | w-breakdown を、分解のタスクのブランチで動かす | US6 | 4 |
| 7 | README の推奨設定・対応バージョン・実機の記録。Copilot CLI の実機の確認 | US5 | 1〜6 |

spec 024 の該当 Issue への知らせは、1 と同じ時に出す。

## Complexity Tracking

憲法の違反は無い。

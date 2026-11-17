# Implementation Plan: main に入れる前の変更を、このリポを乱さずに確かめる試験環境を、設計して作る

**Branch**: `026-pre-merge-test-env` | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/026-pre-merge-test-env/spec.md`

## Summary

main に入れる前の変更を、このリポの Issue・PR・ボード・merge queue を乱さずに、実物で動かして確かめる場所と手順を作る。
新しい仕組みは、ほとんど足さない。今あるものを、決まりと手順でつなぐ。

1. 検証用は、今ある `pecotcraft/pecot-sandbox` とボード `pecot sandbox` を引き継ぐ。clone を作業ディレクトリにすると、pecot の書き込む先が検証用になる
2. 直した pecot-workflow は、公式の `--plugin-dir` で作業ツリーから読み込む。このリポの開発のセッションと同じ読み込み方だ
3. このリポと検証用の設定を比べるスクリプトと、確かめで作ったものを片付けるスクリプトを足す。どちらも開発用で、`plugins/pecot-workflow/scripts/sandbox/` に置く（#562 で移した）
4. 配布物は 3 点を直す。計画の CUJ に「流す先」を足す。w-reviewer の手順を合わせ、CUJ は main が cuj-run.md に従って流す（w-e2e-planner は消す）。フェーズの前後の決まりから、確かめる場所の欠けを訳にした例を外す
5. 人のいないセッションは、公式の文書に動かない点が書いてある。実機で確かめてから、動かし方を選ぶ

判定と根拠は [research.md](research.md) に置く。

| 節 | 中身 |
|---|---|
| R1 | 検証用の場所 |
| R2 | 直した pecot-workflow の読み込み |
| R3 | そろえる設定の比べ方 |
| R4 | 確かめで作ったものの名前と片付け |
| R5 | 計画の「流す先」 |
| R6 | 利用者へ配る自動化の確かめ |
| R7 | 検証用の権限 |
| R8 | クラウドのセッション |
| R9 | フェーズの前後の決まり |
| R10 | 文書の置き場 |
| R11 | 実機で確かめる点 |

## Technical Context

| 項目 | 内容 |
|---|---|
| Language/Version | Bash（比べと片付けのスクリプト）、Markdown（plan テンプレ・エージェント・スキル・文書）、Python（root のテスト）、TypeScript（pecot-workflow の既存のテスト） |
| Primary Dependencies | `gh`・`jq`・`git`（既存）。足す依存は無い |
| Storage | 無い。検証用の clone は `.pecot/work/<Issue番号>/pecot-sandbox/` に置く |
| Testing | vitest（`cli/tests/sandbox/`・`cli/tests/hooks/cuj-definition-single-source.test.ts`・`cli/tests/skills/template-rules.test.ts`。sandbox は偽の `gh` でスクリプトを確かめる）、検証用での CUJ |
| Target Platform | 開発者の devcontainer（Claude Code と GitHub Copilot CLI）と、人のいないセッション |
| Project Type | 配布するプラグイン（テンプレート・エージェント・スキル）と、このリポの開発に使うスクリプト |
| Performance Goals | 直した pecot-workflow を、文書の手順だけで 5 分以内に動かし始められる（SC-006） |

**Constraints**:

- 読み込みは、各クライアントの公式の `--plugin-dir` を使う。独自の読み込み方と、独自の表示を作らない（原則 VI）
- CUJ の定義は、plan テンプレ・cuj-run.md・w-reviewer の 3 か所で同じ文にする。`cuj-definition-single-source.test.ts` が止める
- 配る workflow のテンプレートと、このリポの `.github/workflows/pecot-board-sync.yml` は、npx の dist-tag のほかは同じ中身に保つ。`test_board_sync_workflow_copy.py` が止める
  - dist-tag は、テンプレートが `@latest`、このリポが `@next` だ
- 配布物を直す PR には、version plan が要る
- ルート直下にディレクトリを足さない。スクリプトとテストは pecot-workflow の中に置く（#562 で移した）
  - スクリプトは `scripts/sandbox/`、テストは `cli/tests/sandbox/`
- 検証用での確かめは、PR ごとの CI に入れない
- pecot の設定のキーは足さない。検証用の場所は、プロジェクトの指示に書く

**Scale/Scope**:

| 種類 | 内容 |
|---|---|
| 足すスクリプト | `plugins/pecot-workflow/scripts/sandbox/` に 2 本（設定を比べる・確かめで作ったものを片付ける）と、比べる項目を書いたファイル 1 つ |
| 足すテスト | `plugins/pecot-workflow/cli/tests/sandbox/` に vitest で 2 本 |
| 直す配布物 | `cli/templates/comment/plan.md`、`skills/w-help/references/cuj-run.md`（新規。`agents/w-e2e-planner.md` は消す）、`agents/w-reviewer.md`、`skills/w-breakdown/SKILL.md`、`skills/w-ready/SKILL.md`、`skills/w-help/references/issue-flow-rules.md`、`skills/w-help/references/spec-driven-workflow.md`。GitHub Copilot CLI 向けの写し（`com.github.copilot/agents/`）も同じに直す |
| 直す文書 | `plugins/pecot-workflow/CONTRIBUTING.md`（試験環境の一覧と手順の節）、`CLAUDE.md`（検証用の場所と案内） |
| 検証用の整え | `pecot-sandbox` の必須のチェックの確かめ、人のいないセッション向けの App |
| 直さないもの | pecot の CLI と MCP ツールのコード。書き込む先の切り替えは、作業ディレクトリで足りる |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 合格 | CLI のコードを直さない。足すスクリプトは開発用で、`plugins/pecot-workflow/scripts/sandbox/` に置く。プラグインに同梱されるが、引数なしでは検証用だけに触る |
| II. TDD | 合格 | スクリプト 2 本は、偽の `gh` を使うテストを先に書く。配布物の文の変更は、既存の同期のテストに期待を足してから直す。その後に、検証用で CUJ を流す |
| III. コード品質 | 合格 | 既存の lint（shellcheck・文面の規則）と必須のチェックを通す。迂回しない |
| IV. YAGNI | 合格 | 書き込む先の切り替え・設定のキー・自動で直す仕組みを足さない。pecot-visual・pecot-tools・このリポだけの運用は扱わない |
| V. 本体実装優先 | 合格 | speckit の成果物は、この機能の一式の作成だけ。spec の SC-010 の文は、research の R9 の判定に合わせて直してある |
| VI. 標準準拠 | 条件つき | 読み込みは公式の `--plugin-dir`、workflow は公式の契機の決まりに従う。AWS は扱わないので、アカウントの分け方の勧めに触れない。人のいないセッションは、R11-6 の結果で不適合が出うる。出たら、その場でユーザーに伝えて判断を仰ぐ |

設計の後の見直し: 判定は変わらない。Phase 1 の設計は、コードの層を足さず、配布物の項目を 1 つ足すだけだ。

## 標準との対照

| 標準・公式の仕様 | 従う点 | 外れる点 |
|---|---|---|
| Claude Code のプラグインの読み込み | `--plugin-dir` で読み込む。読み込み元は `plugin list --json` で見る | 無い |
| GitHub Copilot CLI のプラグインの読み込み | `--plugin-dir` で読み込む。読み込み元は `/env` か `copilot plugin list --json` で見る。手順に書くほうは R11-2 で決める | 読まれないものがあれば、R11-2 の結果を文書に残す |
| GitHub Actions の契機 | 直した workflow は、検証用の既定のブランチに置いて起こす | 無い |
| GitHub の権限 | 人のいないセッションには、入れる先を選んだ GitHub App の token を渡す | Projects の権限は org の権限で、リポでは絞れない見込み（R11-5）。書けると分かったら、ユーザーの承認を得る |
| Claude Code のクラウドのセッション | 公式の環境の設定（setup script・環境変数）だけを使う | 動かし方は R11-6 の後に選ぶ |

## Project Structure

### Documentation (this feature)

```text
specs/026-pre-merge-test-env/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── sandbox-scripts.md     # 比べと片付けのスクリプト
│   ├── cuj-destination.md     # 計画の「流す先」と、エージェントの手順
│   └── prerequisite-rule.md   # フェーズの前後の決まり
└── tasks.md                   # /speckit-tasks が作る
```

### Source Code (repository root)

```text
plugins/pecot-workflow/
├── scripts/sandbox/                           # 足す（#562 で .githooks/scripts/ から移した）
│   ├── sandbox-diff.sh                        # このリポと検証用の設定を比べる
│   ├── sandbox-diff-items.json                # 比べる項目と、比べない項目とその訳
│   └── sandbox-sweep.sh                       # 確かめで作ったものを片付ける
├── cli/tests/sandbox/                         # 足す。sandbox-diff.test.ts・sandbox-sweep.test.ts
├── CONTRIBUTING.md                            # 試験環境の節を足す
├── agents/
│   ├── w-e2e-planner.md                       # 消す。CUJ は main が cuj-run.md に従って流す
│   └── w-reviewer.md                          # 流す先の欠けを挙げる
├── com.github.copilot/agents/                 # 上の 2 つの写しを同じに直す
├── cli/templates/comment/plan.md              # CUJ に「流す先」を足す
├── cli/tests/hooks/cuj-definition-single-source.test.ts   # 期待を足す
└── skills/
    ├── w-breakdown/SKILL.md                   # 前後の決まりの問いと例
    ├── w-issueize/SKILL.md                    # 例
    └── w-help/references/
        ├── issue-flow-rules.md                # `merge` の説明
        └── spec-driven-workflow.md            # 例

CLAUDE.md                                      # 検証用の場所と、CONTRIBUTING の節への案内
.nx/version-plans/                             # 配布物を直す PR ごとに 1 つ
```

**Structure Decision**: 検証用のスクリプトは `plugins/pecot-workflow/scripts/sandbox/` に置く（#562 で `.githooks/` から移した）。配布物の変更は `plugins/pecot-workflow/` の既存のファイルに入れる。新しい nx project は作らない。

## 実装の順

tasks は、次の順でフェーズに分ける。

| 順 | 中身 | 対応 | 前のものを待つ訳 |
|---|---|---|---|
| 1 | 実機で確かめる（R11-1〜4 と R11-7）。結果を research に足す | 全体 | 無い |
| 2 | 検証用を整える。比べるスクリプトと片付けるスクリプトを足す | US1 | R11-3 の結果で、検証用の `ci.yml` を直すかが決まる |
| 3 | 直した pecot-workflow を動かす手順を、文書に書く | US2 | R11-1・R11-2 の結果を手順に書く |
| 4 | 配る自動化を、検証用で起こす手順を文書に書く | US3 | R11-4 の結果で、手順が決まる。検証用が整っている必要がある |
| 5 | 計画の「流す先」を足し、エージェントの手順を合わせる | US4 | 流す先に書く検証用と、その手順ができている必要がある |
| 6 | フェーズの前後の決まりを直す | US6 | 試験環境で確かめられることが、手順で示されている必要がある |
| 7 | 人のいないセッションで確かめを流す。最初に R11-5・R11-6 を確かめ、ユーザーが動かし方を選ぶ | US5 | 手元の手順ができている必要がある |

## Complexity Tracking

違反は無い。

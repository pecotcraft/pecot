# Implementation Plan: pecot-workflow の TypeScript 化と MCP 化（再設計）

**Branch**: `020-workflow-ts-mcp` | **Date**: 2026-11-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/020-workflow-ts-mcp/spec.md`

## Summary

旧 spec 015 の Phase 1〜3 は済んだ。基準値、前後比較の 213 件、domain・infra・registry の枠がそろっている。この plan は残りを、今のリポと npm 配布の形に合わせて 13 フェーズに組み直す。

コマンドは 4 つのグループに分けて `cli-node/` に移し、前後比較の golden と一致させる。MCP サーバは registry から 32 個のツールを作る。
利用者に届く振る舞いは、切り替えのフェーズの 1 つの PR でまとめて変える。対象は、スキル本文・Bash の `pecot` の deny・`bin/pecot`・manifest の 4 つ。
それより前のフェーズは、登録されていない MCP サーバや、まだ呼ばれない判定のように、配布物の振る舞いを変えないものだけを足す。
切り替えの後で Python を消し、`cli-node/` を `cli/` に移す。そのうえで `@pecot/workflow-mcp` を npm に出す。

旧 plan から変えた点は次のとおり。

| 項目 | 旧 plan 015 | この plan |
|---|---|---|
| フェーズ 1〜3 | 基準値・前後比較・domain と infra | 済み。フェーズ 1 は golden の記録し直しと dependabot の停止にする |
| スキルの書き換え | 切り替えの前の独立したフェーズ | 切り替えのフェーズに入れる。単独で出すと、MCP の無い版に MCP を呼ぶスキルが届くため |
| Bash の `pecot` の deny | hooks のフェーズで有効にする | hooks のフェーズでは判定と テストだけを足し、`pre-tool-use-bash.sh` からの呼び出しは切り替えで繋ぐ |
| hooks のテストの移行 | Python の削除と同じフェーズ | 独立したフェーズにし、フェーズ 1 の後ならいつでも並べて進められる |
| 単体配布 | git リポを作って `npx -y git+...` | npm の `@pecot/workflow-mcp`。`publish-npm.yml` の対象に足す |

## Technical Context

**Language/Version**: TypeScript / Node `^24.22.1 || >=26.12.1` / ESM。`typescript` は `@typescript/typescript6` の alias とする。`tsc` は `typescript7` の alias を明示パスで起動する。どちらも pecot-tools と同じ

**Primary Dependencies**: commander 15、zod 4、yaml 2（済み）。MCP は `@modelcontextprotocol/server` 2.4 を足す（pecot-tools と同じ版）。テストには `@modelcontextprotocol/client` 2.4 を使う

**Storage**: データ置き場（`CLAUDE_PLUGIN_DATA` → `PLUGIN_DATA` → 既定の場所）と、リポの `.pecot/`。形式は Python と同じ

**Testing**: vitest 5 と coverage-v8。vitest の project は `cli`（カバレッジ対象、閾値は `max(91.0, 90)`。済み）と `hooks`（カバレッジ外）。前後比較は `tests/parity/`。shell の配布テストは pecot-tools と同じ `*.test.sh`

**Target Platform**: Claude Code と GitHub Copilot CLI のプラグイン、および npm の単体配布を登録した MCP クライアント。Linux / macOS

**Project Type**: CLI と MCP stdio サーバ（プラグイン同梱）

**Performance Goals**: 新しい目標は置かない。`project info` の起動から結果までの中央値が、Node で Python 以下（SC-009）

**Constraints**: 出力・終了コード・文言を変えない。識別子にベンダー名やブランドの語を使わない。CHANGELOG は version-plans。各フェーズの PR に pecot-workflow の version plan を付ける。切り替えより前のフェーズは配布物の振る舞いを変えない（FR-014）

**Scale/Scope**: Python のコマンドは 7,989 行。大きいのは `pr.py` 2,226 行、`issue.py` 2,007 行、`project.py` 1,602 行。サブコマンド 32、シナリオ 213、hooks の pytest 1,569 件。`$PECOT` は 17 ファイル 79 箇所

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | PASS | `cli-node/src/` は `commands`（CLI・MCP の表示層）、`domain`、`infra` に分かれ、依存の向きを import-x で強制している（済み）。MCP は `src/mcp/` を表示層に足す |
| II. TDD | PASS | 各コマンドのフェーズは、前後比較のシナリオが先にある状態で始まる。モックは I/O 境界（偽の GitHub サーバ、一時 git リポ、shell の子プロセス）だけ。期待値は Python の実出力 |
| III. コード品質 | PASS | lint・`test-cli` のレーンと閾値は済み。`--no-verify` は使わない。カバレッジの閾値は下げない |
| IV. YAGNI | PASS | 共通ライブラリの切り出しと hooks の TS 化はしない。単体配布は pecot-tools のスクリプトを写す。テスト用の差し替え口は `PECOT_GITHUB_API_URL` の 1 つで、ループバックだけを受け付ける（済み） |
| V. 本体実装優先 | PASS | speckit 成果物は spec 一式の作成だけ。本体の変更は `plugins/pecot-workflow/` と、それを指す root の設定に限る |

設計後の再チェック: 変更なし。

## Project Structure

### Documentation (this feature)

```text
specs/020-workflow-ts-mcp/
├── spec.md / plan.md / research.md / data-model.md / quickstart.md / tasks.md
├── checklists/requirements.md
└── contracts/
    ├── mcp-tools.md     # ツールの名前・入力・結果と登録
    ├── hooks-guard.md   # ガードの入力と判定
    └── parity.md        # 前後比較のシナリオと golden の記録し直し
```

### Source Code (repository root)

```text
plugins/pecot-workflow/
├── cli-node/                              # 済みの枠。フェーズ 11 で cli/ に移す
│   ├── src/
│   │   ├── cli.ts                         # 済み。`mcp` サブコマンドを足す（フェーズ 6）
│   │   ├── commands/registry.ts           # 済み。COMMANDS に 32 個を足す
│   │   ├── commands/{top,project,issue,session,pr,worktree,release}.ts   # 新規（フェーズ 2〜5）
│   │   ├── mcp/{serve,server,result}.ts   # 新規（フェーズ 6）
│   │   ├── domain/ / infra/               # 済み。移植で足りないものを足す
│   └── tests/
│       ├── parity/                        # 済み。golden 213 件、baseline.json、record.ts
│       ├── fake-github/                   # 済み
│       ├── mcp/                           # 新規。MCP 経由の前後比較とツール一覧
│       ├── skills/                        # 新規（フェーズ 10）。スキル本文のツール名
│       └── hooks/                         # 済みの baseline-scripts.test.ts に、pytest から移したテストを足す（フェーズ 9）
├── cli/                                   # Python。切り替えまで配る。フェーズ 11 で消す
├── bin/pecot / bin/_lib.sh                # フェーズ 10 で pecot-tools の実行用ミラー方式にする
├── .mcp.json                              # フェーズ 10 で pecot-workflow を足す（context7 は残す）
├── plugin.json / mcp.json                 # 新規（フェーズ 10）。Agent Plugins 1.0
├── com.github.copilot/hooks/hooks.json    # フェーズ 10 で hooks/hooks-copilot.json から移す
├── com.github.copilot/agents/             # フェーズ 10。pecot-visual と同じ置き方
├── .github/plugin/plugin.json             # フェーズ 10 で消す
├── hooks/
│   ├── pre-tool-use-bash.sh               # フェーズ 10 で pecot の deny を繋ぐ
│   ├── lib/core/pecot-cli-deny.sh         # 新規（フェーズ 7）。Bash の pecot の起動形を見つけてツール名を返す
│   ├── lib/mcp-handlers/mcp-dispatcher.sh # フェーズ 7 で投稿の ask を呼ぶ段を足す
│   ├── lib/mcp-handlers/pecot-post-ask.sh # 新規（フェーズ 7）
│   ├── lib/core/external-post-check.sh    # フェーズ 10 で pecot の判定を外す（gh pr merge の ask は残す）
│   └── tests/ / lib/tests/ / conftest.py  # pytest。フェーズ 9 で vitest に移し、フェーズ 11 で消す
├── skills/**/SKILL.md / agents/*.md / hooks/templates/*.md   # フェーズ 10 で $PECOT → MCP ツール
├── scripts/ci/{install,run-tests,run-lint}.sh                # フェーズ 11 で py を外す
├── scripts/release/                       # 新規（フェーズ 12）。pecot-tools から写す
└── project.json                           # フェーズ 11 で test-py を外す。フェーズ 12 で test-release と nx-release-publish
nx.json                                    # フェーズ 11 で pecotPluginTestGlobals / LintGlobals から uv と Python を外す
.pre-commit-config.yaml                    # フェーズ 11 で ruff の --config を root の pyproject.toml へ
.github/dependabot.yml                     # フェーズ 1 で uv の版の更新を止める。フェーズ 11 でエントリを消す
.github/workflows/publish-npm.yml          # フェーズ 12 で pecot-workflow のタグを受け付ける
CLAUDE.md                                  # フェーズ 13 でレーン表から test-py を外す
```

**Structure Decision**: pecot-tools の `plugins/pecot-tools/` と同じ並びにする。違いは、`commands/registry.ts` が CLI と MCP の両方を作る点と、hooks を持つ点。

## フェーズ

1 フェーズが 1 つの Issue・PR になる。番号は tasks.md と同じ。

| Phase | 内容 | 終わりの条件 | 配布物 |
|---|---|---|---|
| 1 準備 | typer の更新でずれた 12 件の golden を今の Python で記録し直す。dependabot の uv の版の更新を止める（R-15） | `record:parity:check` の差が 0。dependabot の uv エントリが版の更新の PR を出さない | 変わらない |
| 2 project とグループ無し | 14 個（project 10、グループ無し 4）を移す。rich の表の整形を golden に合わせる | 該当シナリオが golden と一致 | 変わらない |
| 3 issue と session | 7 個を移す | 同上 | 変わらない |
| 4 pr | 4 個を移す | 同上 | 変わらない |
| 5 worktree と release | 7 個を移す。`worktree link` の対話は CLI だけに残す | 213 件全部が一致し、registry が 32 個 | 変わらない |
| 6 MCP サーバ | registry からのツール登録、`mcp` サブコマンド、MCP 経由の前後比較 | `tools/list` が 32 個で registry と一致。MCP 経由でも 213 件が一致 | 変わらない（登録しない） |
| 7 hooks のガード | MCP の投稿の ask、Bash の `pecot` の deny の判定と案内文。deny はまだ `pre-tool-use-bash.sh` から呼ばない | 今の確認・阻止の条件がすべて MCP の入力で同じ理由になる。2 つのクライアントの名前の形で通る | 変わらない（MCP サーバが未登録なので ask は発火しない） |
| 8 Copilot CLI の名前の確認 | 開発用の登録で Copilot CLI から MCP サーバを起動し、実際のツール名と hooks の入力を採る。R-5 の推定と違えば、フェーズ 7 の取り出しを直す | 実物のツール名が contracts/hooks-guard.md の形と一致する | 変わらない |
| 9 hooks のテストの移行 | pytest 1,569 件を vitest の `hooks` project に移す。`test-hooks` は移行中、両方を流す | vitest の件数が 1,569 以上、起動スクリプトが基準を全部含む | 変わらない |
| 10 切り替え | スキル・agents・templates を MCP に書き換え、`test-skills` を vitest に移す。Bash の deny を繋ぎ、`external-post-check.sh` の pecot の判定を外す。`bin/pecot` をミラー方式にして古い venv を片付ける。MCP を登録し、Agent Plugins 1.0 の形に移す。version plan で切り替えを告げる | `$PECOT` が 0 件。Claude Code と Copilot CLI で quickstart の CUJ 1〜7 が通る | **Node と MCP と 1.0 の形に切り替わる** |
| 11 Python の削除 | `cli/` の Python、pytest、`test-py`、hooks の pytest、nx globals の uv と Python、dependabot の uv エントリを消す。ruff の設定を root へ向ける。`cli-node/` を `cli/` に移す | Python なしで全レーンが通る。カバレッジが基準以上 | Python が消える |
| 12 単体配布 | `scripts/release/` を pecot-tools から写し、`nx-release-publish` と `test-release` を足す。`publish-npm.yml` に pecot-workflow のタグを足す | dry-run の配布ツリーを `npx` で起動し、32 個のツールが使える。リリースで `@pecot/workflow-mcp` が npm に出る | **単体配布が始まる** |
| 13 仕上げ | README・CONTRIBUTING・CLAUDE.md、#41 へのコメント、quickstart の通し、#17〜#27 の close | SC-001〜SC-009 | |

依存:

- フェーズ 1 が全部の前にある
- フェーズ 2〜5 は互いに独立し、並べて進めてよい。フェーズ 6 は 2〜5 の後
- フェーズ 7 と 9 は、フェーズ 1 の後ならいつでも進めてよい。フェーズ 8 はフェーズ 6 と 7 の後
- フェーズ 10 は 2〜9 が全部終わってから。フェーズ 11 は 10 の後、12 は 11 の後、13 は最後

## リスクと対処

| リスク | 対処 |
|---|---|
| 1.0 の形を出すと、Copilot CLI が `hooks/` と旧形式を読まなくなる | hooks・MCP・スキルと同じ PR（フェーズ 10）で出す。manifest の一致をテストで固定する |
| Copilot CLI の MCP ツール名の形が推定と違う | フェーズ 8 で実物を確かめ、切り替えの前に直す |
| 切り替えの PR が大きくなる | スキルの書き換えは機械的で、`test-skills` がツール名の実在を確かめる。MCP サーバ・判定・テストはフェーズ 6〜9 で先に入れておき、フェーズ 10 は繋ぐだけにする |
| 移行中に Python の CLI か依存が変わる | 同じ PR で Node を直し、golden を記録し直す（FR-007）。版の更新はフェーズ 1 で止める（FR-018） |
| 出力の細部（rich の表、改行、全角の幅）が一致しない | golden で文字単位に比べる。差が出たら Node 側を Python に合わせる |
| 単体配布では hooks のガードが動かない | 配布の README に書く。投稿の確認は MCP クライアント自身に任せる |
| MCP サーバが起動しない | 理由を返して止まる。Python や Bash の CLI に切り替えない。bootstrap のテストで固定する |
| 切り替え直後に状態ファイルが読めない | Python が書いた `.pecot/` とデータ置き場を Node が読むシナリオ（`*-python-state`）が golden にある |
| `@pecot/workflow-mcp` の初回の publish が trusted publishing で通らない | npm 側の trusted publisher の設定は利用者が行う。フェーズ 12 の Issue に手順を書き、承認を得てから実行する |

## Complexity Tracking

違反なし。

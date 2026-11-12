# Implementation Plan: pecot-workflow の TypeScript 化と MCP 化（再設計）

**Branch**: `docs/workflow-ts-mcp-respec/42` | **Date**: 2026-11-11（初版 2026-11-05） | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/020-workflow-ts-mcp/spec.md`

## Summary

旧 spec 015 の Phase 1〜3 は済んだ。基準値、前後比較の 228 件、domain・infra・registry の枠がそろっている。
2026-11-05 の plan の後に、定義書（spec 022）と共通の出力の関数（spec 021）が入った。この plan は残りを 14 フェーズに組み直す。

コマンドは 5 つのフェーズ（2〜6）に分けて `cli-node/` に移す。移すたびに、次の 3 つを通す。

- 前後比較の golden と出力が一致する
- Node のコマンド定義から書き出した項目が、定義書の同じ ID の項目と、`surfaces.mcp` 以外の欄で一致する
- そのコマンドの振る舞いの項目が、全部 vitest のケースにつながる

MCP サーバは registry から 34 個のツールを作る。
利用者に届く振る舞いは、切り替えのフェーズの 1 つの PR でまとめて変える。
対象は、スキル本文・Bash の `pecot` の deny・`bin/pecot`・manifest・定義書の書き出しの元の 5 つ。
それより前のフェーズは、配布物の振る舞いを変えないものだけを足す。
切り替えの後で Python を消し、`cli-node/` を `cli/` に移す。そのうえで `@pecot/workflow-mcp` を npm に出す。

2026-11-05 の plan から変えた点は次のとおり。

| 項目 | 2026-11-05 | この plan |
|---|---|---|
| サブコマンド | 32 個、4 つのフェーズで移す | 34 個、5 つのフェーズ（2〜6）で移す。グループ `security`・`dependabot` の `sync` を移すフェーズを足した。`pr merge` は `pr cleanup` |
| フェーズの数 | 13 | 14 |
| 公開面の一致 | golden だけ | golden と定義書。`export-interface.ts --check` をフェーズ 1 で入れる（R-16） |
| 振る舞いの項目 | 無い | 769 個。コマンドを移すフェーズで vitest につなぐ（R-17） |
| 定義書の書き出しの元 | 無い | 切り替えの PR で Python から Node に替える（R-18） |
| フェーズ 1 の golden | typer でずれた 12 件を記録し直す | 2026-11-11 に計り直した結果に従う（R-0） |
| スキルの書き換えの対象 | `$PECOT` 79 箇所 | 素の `pecot <サブコマンド>` 202 箇所（R-19） |

## Technical Context

**Language/Version**: TypeScript / Node `^24.22.1 || >=26.12.1` / ESM。`typescript` と `tsc` の alias は pecot-tools と同じ

**Primary Dependencies**: commander 15、zod 4、yaml 2（済み）。MCP は `@modelcontextprotocol/server` を足す。版は pecot-tools にそろえる。
定義書の比較は `libs/interface-spec` の `diffGenerated`・`formatStale` を使う

**Storage**: データ置き場（`CLAUDE_PLUGIN_DATA` → `PLUGIN_DATA` → 既定の場所）と、リポの `.pecot/`。形式は Python と同じ

**Testing**: vitest 5 と coverage-v8。vitest の project は `cli`（カバレッジ対象、閾値は `max(91.0, 90)`。済み）と `hooks`（カバレッジ外）。
前後比較は `tests/parity/`。定義書とのつなぎは `tests/_helpers/verifies.ts` の `verifies(context, 'PW-…')`。shell の配布テストは `*.test.sh`。
振る舞いの項目のケースは `tests/interface/<グループ>.test.ts` に置く（`vitest.config.ts` の include に既にある）。
bootstrap の shell のテストは、pecot-tools と同じ `test-bootstrap` レーンで流す（フェーズ 11）。
足す先は 5 つある。
`project.json` の target と、`test` の dependsOn。
`scripts/ci/run-tests.sh` の scope。
`.githooks/tests/test_nx_affected_mapping.py` の対応表。
CLAUDE.md のレーンの表

**Target Platform**: Claude Code と GitHub Copilot CLI のプラグイン、および npm の単体配布を登録した MCP クライアント。Linux / macOS

**Project Type**: CLI と MCP stdio サーバ（プラグイン同梱）

**Performance Goals**: 新しい目標は置かない。`project info` の起動から結果までの中央値が、Node で Python 以下（SC-009）。計るのはフェーズ 11 の PR の中の 1 回（R-13）

**Constraints**: 出力・終了コード・文言を変えない。出力は共通の関数 `createOutput`（`src/commands/output.ts`）を通す（FR-024）。
CHANGELOG は version-plans。各フェーズの PR に pecot-workflow の version plan を付ける。
切り替えより前のフェーズは配布物の振る舞いを変えない（FR-014）。切り替えまで `interface/generated.json` を Node から書かない（FR-020）

**Scale/Scope**: Python のコマンドは 8,450 行。大きいのは `pr.py` 2,135 行、`issue.py` 2,054 行、`project.py` 1,497 行。
サブコマンド 34、シナリオ 228、振る舞いの項目 769、hooks の pytest 1,569 件。スキルなどの `pecot <サブコマンド>` は 28 ファイル 202 箇所

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

憲章 3.1.0 で確かめた。

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | PASS | `cli-node/src/` は `commands`（表示層）、`domain`、`infra` に分かれる。層の向きと domain の I/O はリンターが止める（済み）。MCP は `src/mcp/` を表示層に足す |
| II. TDD | PASS | 各コマンドのフェーズは、前後比較のシナリオと定義書の振る舞いの項目が先にある状態で始まる。項目ごとに vitest のケースを書き、`verifies` で ID を書く。モックは I/O 境界だけで、pytest の差し替えは偽サーバ・一時ディレクトリ・一時 git リポに置き換える（R-17）。実際のコマンドを現実の入力で実行する確認は、前後比較のシナリオが受け持つ |
| II. 定義書とテストのつなぎ | PASS | 項目の ID と文は変えない。つながらない項目は `lint-defs` が止める。移したコマンドの項目が vitest に全部あることは、フェーズ 1 で足すテストが止める（R-17） |
| III. コード品質 | PASS | lint・`test-cli` のレーンと閾値は済み。`--no-verify` は使わない。カバレッジの閾値は下げない。直接の出力は `direct-output-lint.test.ts` が止める |
| IV. YAGNI | PASS | 定義書の比較は `libs/interface-spec` の関数を使い、別に作らない。`--check` のために新しいレーンは足さず、`test-cli` の中で流す。bootstrap と release の shell のテストには、pecot-tools と同じ `test-bootstrap`・`test-release` を足す。hooks の TS 化はしない |
| V. 本体実装優先 | PASS | この更新は、spec 021・022 の実装の結果との差を直す整合の修正で、利用者の指示による。体裁だけの編集はしない |

設計後の再チェック: 変更なし。

## Project Structure

### Documentation (this feature)

```text
specs/020-workflow-ts-mcp/
├── spec.md / plan.md / research.md / data-model.md / quickstart.md / tasks.md
├── checklists/requirements.md
└── contracts/
    ├── mcp-tools.md     # サーバの登録と結果。ツールの一覧と入力の正は定義書
    ├── hooks-guard.md   # ガードの入力と判定
    ├── parity.md        # 前後比較のシナリオと golden の記録し直し
    └── interface.md     # 定義書との比較と、振る舞いの項目のつなぎ
```

### Source Code (repository root)

```text
plugins/pecot-workflow/
├── cli-node/                              # 済みの枠。フェーズ 12 で cli/ に移す
│   ├── scripts/export-interface.ts        # フェーズ 1 で --check。フェーズ 11 で --write
│   ├── src/
│   │   ├── cli.ts                         # 済み。`mcp` サブコマンドを足す（フェーズ 7）
│   │   ├── commands/registry.ts           # 済み。COMMANDS に 34 個を足す
│   │   ├── commands/output.ts             # 済み。移すコマンドはこれを通して出力する
│   │   ├── commands/{project,repo,issue,session,pr,worktree,release,security,dependabot}.ts   # 新規（フェーズ 2〜6）
│   │   ├── mcp/{serve,server,result}.ts   # 新規（フェーズ 7）
│   │   └── domain/ / infra/               # 済み。移植で足りないものを足す
│   └── tests/
│       ├── parity/                        # 済み。golden 228 件、baseline.json、record.ts
│       ├── interface-export.test.ts       # 済み。フェーズ 1 で --check と項目のつなぎの確認を足す
│       ├── interface/                     # 新規（フェーズ 1〜6）。振る舞いの項目のケース。<グループ>.test.ts と common.test.ts
│       ├── _helpers/verifies.ts           # 済み
│       ├── mcp/                           # 新規（フェーズ 7）。vitest.config.ts の include と coverage-include.test.ts も直す
│       ├── skills/                        # 新規（フェーズ 11）。同上
│       └── hooks/                         # フェーズ 10 で pytest から移す
├── cli/                                   # Python。切り替えまで配る。フェーズ 12 で消す
├── interface/generated.json               # 切り替えまで Python が書く。フェーズ 11 で Node が書く
├── interface/authored.yaml                # 項目の ID と文は変えない
├── scripts/interface/export.py            # フェーズ 11 で消す
├── bin/pecot / bin/_lib.sh                # フェーズ 11 で実行用ミラー方式にする
├── .mcp.json / plugin.json / mcp.json     # フェーズ 11
├── com.github.copilot/                    # フェーズ 11
├── hooks/                                 # フェーズ 8 で判定を足し、フェーズ 11 で繋ぐ
├── skills/ / agents/ / hooks/templates/   # フェーズ 11 で MCP ツールの呼び出しに書き換える
├── scripts/release/                       # 新規（フェーズ 13）
└── project.json                           # フェーズ 1・11・12・13 で直す
libs/interface-spec/targets.json           # フェーズ 1 で sources に cli-node を併記、11 で Python を外し、12 で cli/ に直して tests も直す
libs/interface-spec/project.json           # フェーズ 1・11・12 で lint-defs の inputs。フェーズ 11 で test-unit の inputs と sample-files のテスト
libs/interface-spec/docs/conf.py           # フェーズ 12 で iface_junit を cli/test-results/junit.xml（Node）と junit-hooks.xml の 2 本にする
nx.json / .pre-commit-config.yaml          # フェーズ 12
.github/dependabot.yml                     # フェーズ 1 で uv の版の更新を止め、フェーズ 12 で消す
.github/workflows/publish-npm.yml          # フェーズ 13
CLAUDE.md                                  # フェーズ 14
```

**Structure Decision**: pecot-tools の `plugins/pecot-tools/` と同じ並びにする。違いは、`commands/registry.ts` が CLI と MCP の両方を作る点と、hooks を持つ点。

## フェーズ

1 フェーズが 1 つの Issue・PR になる。番号は tasks.md と同じ。

| Phase | 内容 | 終わりの条件 | 配布物 |
|---|---|---|---|
| 1 準備 | golden のずれを R-0 のとおり片づけ、dependabot の uv の版の更新を止める。`export-interface.ts --check`・項目のつなぎのテスト・`PW-COMMON` 17 個の vitest のケースを入れ、定義書の `sources` に cli-node を併記して `lint-defs` を通す（R-18） | `record:parity:check` の差が 0。`--check` が登録 0 件で通り、見本の 1 コマンドで差を出せ、`lint-defs` が通る | 変わらない |
| 2 project・create-branch・delete-branch | project 10 個と `create-branch`・`delete-branch` の 12 個を移す。`global-*` は対象にしない | この PR で足した 12 個が登録され、登録済みの全部で `--check` の差が 0。該当シナリオが golden と一致し、項目 127 個が vitest につながる | 変わらない |
| 3 issue・session・add-to-project・update-issue-status | issue 5 個、`add-to-project`、`update-issue-status`、session 2 個の 9 個を移す | 同上。項目は 211 個 | 変わらない |
| 4 pr | 4 個（`create`・`read`・`preflight`・`cleanup`）を移す | 同上。項目は 107 個 | 変わらない |
| 5 worktree と release | 7 個を移す。`worktree link` の対話は CLI だけに残す | 同上。項目は 217 個 | 変わらない |
| 6 security sync と dependabot sync | 2 個を移して 34 個をそろえ、`global-*` の残り 3 件もここで一致を確かめる（help の 4 件の stdout は #362 で比べる対象から外した） | 228 件全部が一致し（help の 4 件は stdout を除く）、registry が 34 個。`--check` が 34 項目で差 0（SC-010）で、項目 769 個が全部 vitest につながる | 変わらない |
| 7 MCP サーバ | registry からツールを登録し、`mcp` サブコマンドと MCP 経由の前後比較を入れる。`tests/mcp/` の include も足す | `tools/list` が 34 個で定義書と一致。MCP に写せるシナリオの全件（165 件）が MCP 経由で一致 | 変わらない（登録しない） |
| 8 hooks のガード | MCP の投稿の ask と、Bash の `pecot` の deny の判定・案内文を入れる。deny はまだ `pre-tool-use-bash.sh` から呼ばない | 今の確認・阻止の条件がすべて MCP の入力で同じ理由になる。2 つのクライアントの名前の形で通る | 変わらない |
| 9 Copilot CLI の名前の確認 | `build-cli` の後の `node cli-node/dist/cli.js mcp` を開発用に登録し、Copilot CLI から起動する。実際のツール名と hooks の入力を採る | 実物のツール名が contracts/hooks-guard.md の形と一致する | 変わらない |
| 10 hooks のテストの移行 | pytest 1,569 件を vitest の `hooks` project に移す。`test-hooks` は移行中、両方を流す | 移行元の pytest のケースがすべて vitest にある（`compare_junit.py`）。起動スクリプトが基準を全部含む | 変わらない |
| 11 切り替え | スキルなどを MCP に書き換え、Bash の deny を繋ぎ、`bin/pecot` をミラー方式にして MCP を登録し、1.0 の形に移す。定義書の書き出しの元を Node に替え、`test-bootstrap` を足し、SC-009 を計る | Bash で `pecot` を呼ばせる記述が 0 件で、`generated.json` の差分が `surfaces.mcp` だけ。`--plugin-dir` での CUJ が通る | **Node と MCP と 1.0 の形に切り替わる** |
| 12 Python の削除 | `cli/` の Python、pytest、`test-py`、uv の参照を消し、`cli-node/` を `cli/` に移す。定義書の読む先とプラグインの外の参照を直す | `.py` が 0 件で、`cli-node` の参照が `specs/` と CHANGELOG を除いて 0 件。Python なしで全レーンが通り、つながらない項目が 0 件（SC-011） | Python が消える |
| 13 単体配布 | `scripts/release/` を pecot-tools から写し、`nx-release-publish` と `test-release` を足す。`publish-npm.yml` にタグを足す | dry-run の配布ツリーで 34 個のツールが使える。npm に出た後は CUJ 8 で確かめる | **単体配布が始まる** |
| 14 仕上げ | README・CONTRIBUTING・CLAUDE.md、#41 へのコメント、quickstart の通し | SC-001〜SC-011 | |

項目の数は tasks.md の各フェーズの節を正とし、この表は一覧として残す。`test-bootstrap` と `test-release` に足すものは、Technical Context の 5 つ。

依存:

- フェーズ 1 が全部の前にある
- フェーズ 2〜5 は 1 の後で、互いに独立し、並べて進めてよい。フェーズ 2 と 3 が移すのは別のファイル（`repo.py` と `issue.py`）
- フェーズ 6 は 2〜5 の後。3 と 5 の関数を使い、34 個がそろったことを確かめるため。フェーズ 7 は 6 の後
- フェーズ 8 と 10 は、フェーズ 1 の後ならいつでも進めてよい。フェーズ 9 はフェーズ 7 と 8 の後
- フェーズ 11 は 2〜10 が全部終わってから。フェーズ 12 は 11 の後、13 は 12 の後、14 は最後

## リスクと対処

| リスク | 対処 |
|---|---|
| 1.0 の形を出すと、Copilot CLI が `hooks/` と旧形式を読まなくなる | hooks・MCP・スキルと同じ PR（フェーズ 11）で出す。manifest の一致をテストで固定する |
| Copilot CLI の MCP ツール名の形が推定と違う | フェーズ 9 で実物を確かめ、切り替えの前に直す |
| 切り替えの PR が大きくなる | MCP サーバ・判定・テストはフェーズ 7〜10 で先に入れておき、フェーズ 11 は繋ぐだけにする。定義書の元の差し替えは、差分が MCP ツールの欄だけであることで確かめる |
| 移行中に Python の CLI か依存が変わる | 同じ PR で Node を直し、golden を記録し直す（FR-007）。引数が変われば定義書も変わり、直していない Node を `--check` が止める |
| 項目 769 個の vitest が、pytest と違うことを確かめてしまう | 項目の文（EARS の 1 文）を期待値の元にする。pytest のケースを読み、同じ入力と同じ期待値で書く。PR のレビューで、項目・pytest のケース・vitest のケースの対応表を見る |
| pytest の内部の関数の差し替え（約 2,000 箇所）を vitest にそのまま写せない | 偽の GitHub サーバ・一時ディレクトリの設定・一時 git リポに読み替える（R-17）。`it.skip`・`it.todo` は使わず、つなぎの確認は `verifies(` の引数だけを見る |
| 並べて進めるフェーズ 2〜5 が `registry.ts` で衝突する | `COMMANDS` への追加は 1 行ずつ。後の PR は rebase で取り込む。共通の項目 `PW-COMMON` はフェーズ 1 でつなぐので、重ならない |
| 出力の細部（rich の表、改行、全角の幅）が一致しない | golden で文字単位に比べる。差が出たら Node 側を Python に合わせる |
| フェーズ 12 で、プラグインの外にある `cli-node`・`test-py`・Python の参照が残る | `.githooks/`・`.pre-commit-config.yaml`・`nx.json`・pecot-visual・`libs/interface-spec` の参照を同じ PR で直す。`git ls-files` の `.py` が 0 件、`git grep -n cli-node` の該当が 0 件で確かめる（R-18） |
| 単体配布では hooks のガードが動かない | 配布の README に書く。投稿の確認は MCP クライアント自身に任せる |
| MCP サーバが起動しない | 理由を返して止まる。Python や Bash の CLI に切り替えない。bootstrap のテストで固定する |
| 切り替え直後に状態ファイルが読めない | Python が書いた `.pecot/` とデータ置き場を Node が読むシナリオ（`*-python-state`）が golden にある |
| `@pecot/workflow-mcp` の初回の publish が trusted publishing で通らない | npm 側の trusted publisher の設定は利用者が行う。フェーズ 13 の Issue に手順を書き、承認を得てから実行する |

## Complexity Tracking

違反なし。

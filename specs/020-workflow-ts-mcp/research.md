# Research: pecot-workflow の TypeScript 化と MCP 化（再設計）

調査日は 2026-11-05、対象は `pecotcraft/pecot` の main `2347067`。2026-11-11 に main `be3b5a4` で計り直し、R-0・R-1・R-4・R-6 を直して R-16〜R-19 を足した。
同日の PR #339 のレビューで、R-1〜R-3・R-5〜R-9・R-11・R-13・R-16〜R-19 を直した。旧 spec 015 の research（調査日 2026-10-29）を基に、移行後のリポで確かめ直した。名前は aist → pecot に読み替えてある。

## R-0. 済んだものと今の状態

| 対象 | 状態 | 置き場 |
|---|---|---|
| 基準値 | CLI の行カバレッジ 91.0%（2026-10-29、旧リポの `ba0dedf2`）。hooks のテスト 1,569 件と起動スクリプトの一覧 | `cli-node/tests/parity/baseline.json` |
| 前後比較 | シナリオと golden が 228 件（2026-11-05 は 213 件）。`record:parity` と `record:parity:check`、`parity.test.ts` | `cli-node/tests/parity/` |
| golden の鮮度 | 2026-11-11 に今の Python で `record:parity:check` を流した。228 件のうち差は 5 件、誤りは 0 件。typer の書式による 12 件の差は、その後の記録し直しで無くなった。5 件は `delete-branch-auth-fallback`・`delete-branch-ok`・`pr-cleanup-ok-delete-branch` の stderr と、`pr-create-ok-prepare`・`pr-create-ok-prepare-epic` の files。原因はフェーズ 1 で調べる | 作業記録は `.pecot/work/42/parity-check.log` |
| 定義書 | 34 項目と振る舞いの項目 769 個。`generated.json` は Python の `scripts/interface/export.py` が書く。Node の `cli-node/scripts/export-interface.ts` は `exportEntries` まであり、`--check` と `--write` は未実装 | `plugins/pecot-workflow/interface/`、`libs/interface-spec/` |
| 共通の出力の関数 | Python は `cli/commands/_output.py`、Node は `cli-node/src/commands/output.ts` の `createOutput`。Node の直接の出力は `tests/direct-output-lint.test.ts` が止める | spec 021 |
| domain と infra | config、state、frontmatter、sections、reference-parser、format、changelog、release、repository-policy、dependabot、GitHub client（REST・GraphQL）、git、worktree、nx-scope、paths | `cli-node/src/domain/`、`cli-node/src/infra/` |
| CLI の枠 | `cli.ts` がグローバルオプションを typer と同じ順で処理する。`registry.ts` の `defineCommand()` と `COMMANDS`（空）、`command-binding.ts`、rich の枠と表の整形 | `cli-node/src/cli.ts`、`cli-node/src/commands/` |
| レーン | `build-cli`・`test-cli`・lint が `cli-node/` を対象に動く。`test-py` は Python を流す | `plugins/pecot-workflow/project.json` |
| hooks のテストの枠 | vitest の `hooks` project と `baseline-scripts.test.ts` | `cli-node/tests/hooks/` |

`cli/.venv` は、ふだん作業ツリーに無い。`record:parity` を流す前に `cli/` で `uv sync` を実行する。

## R-1. 移植の残り

| フェーズ | コマンド | Python のソース |
|---|---|---|
| 2 | project 10 個（list、search、init、create、info、activate、set-repo、set-aggregation-repo、unset-aggregation-repo、show-aggregation-repo）、`create-branch`、`delete-branch` | `project.py` 1,497 行、`repo.py` 321 行 |
| 3 | issue 5 個（create、quick、read、comment、reopen）、`add-to-project`、`update-issue-status`、session 2 個（status、restore） | `issue.py` 2,054 行、`session.py` 228 行 |
| 4 | pr 4 個（create、read、preflight、cleanup） | `pr.py` 2,135 行 |
| 5 | worktree 4 個（init、add、link、remove）、release 3 個（preflight、create、merge） | `worktree.py` 433 行、`release.py` 607 行 |
| 6 | `security sync`、`dependabot sync` | `security.py` 220 行、`dependabot.py` 210 行、`_tracker_sync.py` 72 行、`core/issue_board.py`（`create_issue`・`put_on_board`）、`core/tracker_body.py`（`find_tracker`・`render_tracker_body`）、`release.py` の `resolve_release_target_repo` |

合わせて 34 個で、定義書の項目と 1 対 1 に対応する。
グループ無しは `add-to-project`・`update-issue-status`・`create-branch`・`delete-branch` の 4 個だけ。
同期の 2 個は、グループ `security`・`dependabot` の `sync`。
`cli/commands/main.py`（201 行）はコールバックと登録だけで、コマンドの本体は無い。
`add_to_project`・`update_issue_status` は `issue.py`、`create_branch`・`delete_branch` は `repo.py` にある。

フェーズ 6 は、フェーズ 3 の `issue_board` とフェーズ 5 の `resolve_release_target_repo` を使う。そのため 2〜5 の後に進める。
フェーズ 2 と 3 は別のファイル（`repo.py` と `issue.py`）を移すので重ならない。

共通の `repo.py`・`_repo_policy.py`・`_work_target.py`・`options.py`・`repo_display.py` は、各グループの移植で要る分だけ写す。domain・infra に同じものがあれば、それを使う。

## R-2. 言語と構成

| 項目 | 内容 |
|---|---|
| 決定 | 済みの `cli-node/` の構成をそのまま使う。pecot-tools と同じ TypeScript・ESM・commander・zod・vitest・ESLint・knip を使う。pnpm workspace は root の `pnpm-workspace.yaml` の 1 つで、`cli-node/` を含み、lockfile を共有する |
| 決定 | MCP は pecot-tools と同じ `@modelcontextprotocol/server` を足す。版は pecot-tools にそろえる |
| 決定 | Python を消すフェーズで `cli-node/` を `cli/` に移す。`build-cli` などの inputs と `--filter` も同じ PR で直す |
| 理由 | 移行中は Python の `cli/` が配布物として動く。`bin/pecot` は `cli/` 全体のハッシュで venv を作るので、同じディレクトリに TS を置くと venv が作り直される |
| 退けた案 | 最終形も `cli-node/` のまま（他のプラグインと名前がずれる） |

## R-3. 実行用ミラーとデータ置き場

| 項目 | 内容 |
|---|---|
| 決定 | `bin/pecot` を pecot-tools の `bin/pecot-tools` と同じ型に書き換える。`bin/_lib.sh` に pecot-tools の `plugin_runtime_*` と Node の下限の確認（`*_node_runtime_*`）を写す。ミラーは `${DATA}/runtime/<deps-hash>-<src-hash>/` |
| 決定 | `PECOT_BOOTSTRAP_SKIP=1` は、本体ツリーの `dist/cli.js` を直接起動する。フェーズ 11 では `cli-node/dist/cli.js`、フェーズ 12 の後は `cli/dist/cli.js` |
| 決定 | 切り替えの版は、初回起動で `${DATA}/venv/` を消す。`.inuse` の共有ロックを持つ世代は残し、次回の起動で消す |
| 理由 | marketplace は `plugins/<name>/` しか配らないので、`_lib.sh` はプラグインごとに持つ。データ置き場の解決の順は、pecot-workflow の `_lib.sh` に既にある |
| 退けた案 | root の `libs/` に置いてリンクで取り込む。pecot-tools 側も書き換えることになり、範囲を越える |

## R-4. コマンド定義の一覧

| 項目 | 内容 |
|---|---|
| 決定 | 済みの `registry.ts` の `defineCommand()` で 34 個を定義する。commander の登録（`command-binding.ts`）と MCP のツール登録は、`COMMANDS` から作る |
| 理由 | FR-004 の 1 対 1 を、一覧の数の一致で確かめられる |
| 退けた案 | MCP のツールを手で書く（pecot-tools の方式）。34 個の CLI と同期を保てない |

## R-5. MCP のツール名と hooks の matcher

| 項目 | 内容 |
|---|---|
| 決定 | サーバ名は `pecot-workflow`。ツール名は `<group>_<subcommand>`、グループの無いものはコマンド名の `-` を `_` にする |
| Claude Code | `mcp__plugin_pecot-w_pecot-workflow__<tool>`。導入済みの pecot-t のツール（`mcp__plugin_pecot-t_pecot-tools__aws_s3_ls`）と同じ形であることを確かめた |
| Copilot CLI | `pecot-workflow-<tool>`。2026-11-12 に Copilot CLI 1.0.107 と 1.0.109 で実物を確かめた（結果は同じ。推定は `hooks-copilot.json` の matcher にある `github-mcp-server-create_pull_request` の形だった）。登録は 2 通りで、`--additional-mcp-config` の登録（`session.mcp_server_status_changed` の `configSource` は `user`）とプラグインの `.mcp.json` の登録（`plugin`）。どちらも `tool.execution_start` の `toolName` は `pecot-workflow-project_info`（`mcpToolName` は `project_info`）で、PreToolUse の `tool_name` も同じ。`tool_input` は文字列ではなくオブジェクトで届き、`issue_create` の `prepare: true` は真偽値の `true` のまま読める。したがって hooks の取り出しは変えない |
| Copilot CLI で確かめた事実 | `-p` では対話の確認画面を出せない。`permissionDecision` が `ask` のとき、ツールの結果は `success: false`・`error.code` が `denied` になり、`error.message` は `Denied by preToolUse hook (unable to ask user for confirmation):` で始まって、その後に hooks の理由（`warning: external-post-check: ...`）が続く |
| Copilot CLI の失敗の結果 | MCP ツールの失敗は `success: false`・`error.code` が `failure` で届く。`error.message` と結果の `content` の先頭に `MCP server 'pecot-workflow':` が付き、その後に CLI の `error: ...` の行と `exit code: 1` の行が続く（`issue_read` に存在しない Issue を渡して確かめた） |
| Copilot CLI のプラグインのサーバの cwd | プラグインの `.mcp.json` のサーバは、`cwd` を書かなければプラグインの root で起動する（2026-11-12、1.0.109 で確かめた。1.0.108 の試しも同じ）。`"cwd"` に作業ツリーのパスを書くと、そのパスの cwd で起動した（1.0.109）。利用者のリポを cwd として読む `cli-node/src/mcp/server.ts` との関係は、この Issue では事実だけを記録する |
| 決定 | hooks は、この 2 つの形から `<tool>` を取り出し、それが 34 個のツール名にあるときだけ判定する |
| 理由 | `.mcp.json` と root の `mcp.json` は `pecot-workflow-playwright` も持つ。Copilot CLI では matcher `pecot-workflow-.*` がそのツールにも当たるので、名前で絞る |
| 退けた案 | `pecot_` の接頭辞（クライアントがサーバ名を前に付けるので重複する） |

## R-6. 前後比較と golden の記録し直し

| 項目 | 内容 |
|---|---|
| 決定 | 済みの仕組みを使う。Node の CLI の直接起動は全件（2026-11-11 の時点で 228 件）、MCP 経由は MCP に写せるシナリオの全件を、golden と比べる |
| 決定 | MCP に写せないのは 3 種で、2026-11-11 の時点で 63 件。残りは 165 件。`global-*` の 31 件（`--help`・`--version`・`--show-repo`・未知のコマンド・引数なし）、名前に `usage` を含む `global-*` 以外の 29 件（CLI の引数の誤りで、MCP では入力の検証の誤りになる）、標準入力を使う `worktree-link-*` の 3 件 |
| 決定 | `global-*` はフェーズ 2 の対象から外す。31 件のうち 24 件は今も一致している。残りの 7 件（help の一覧と「近いコマンド」の案内）は、34 個がそろうフェーズ 6 で一致を確かめる。フェーズ 6 の後、`parity.test.ts` は全件を golden と比べる。help を stdout に出す 4 件だけは、#362 で stdout を比べる対象から外した。`*-python-state` は 3 件で、フェーズ 2・3・5 が 1 件ずつ受け持つ |
| 決定 | 除く一覧と理由は `parity.test.ts` が持つ。argv からツールの入力への写し方と比べる欄は contracts/parity.md にある。入力の検証の誤りは、フェーズ 7 のツール一覧のテストが受け持つ |
| 決定 | golden を記録し直すのは、Python の CLI か依存を変える PR だけ（spec FR-007）。その PR で Node も直す。対象は `record:parity:check` で差の出たシナリオに限る |
| 決定 | フェーズ 1 で、R-0 の 5 件の差の原因を調べる。Python の出力が変わっていたなら記録し直す。実行する環境で変わる値なら、golden の置き換えの規則に足す |
| 状態 | Node の使い方エラーの整形（`usage-error.ts`）は済み。`src/commands/tests/usage-error.test.ts` が golden の実出力から期待値を読む。差が出たら Node 側を golden に合わせる。help の書式は #362 で Node のものに変えた。golden とは比べず、`help.test.ts` が Node の期待値で確かめる |
| 理由 | golden を Node に合わせて書き換えると、前後比較が意味を失う |

## R-7. 対話入力

| 項目 | 内容 |
|---|---|
| 決定 | `worktree link` の上書き確認は、CLI では対話のまま残す（`interactive: true`）。MCP ツールには新しい入力を作らず、定義書にある `force` をそのまま使う |
| 決定 | MCP ツールは標準入力を持たない。`force` が false で確認が要るときは、定義書の今の振る舞い（入力の終端なら中止する。`authored.yaml` の `PW-WORKTREE-LINK` の stdin の欄）と同じになる。新しい振る舞いの項目は足さない |
| 理由 | MCP ツールの呼び出し中は利用者に問えない。`force` が false なら中止するので、確認なしで消えるものがない。`overwrite` を足すと、定義書の `input` と食い違って `--check` が落ちる |

## R-8. hooks のガードの移し方

| 項目 | 内容 |
|---|---|
| 決定 | `external-post-check.sh` の pecot の判定を、MCP の `tool_input` を jq で読む `lib/mcp-handlers/pecot-post-ask.sh` に移す。判定は、ask の対象、`prepare` の素通し、スラッシュコマンドのフラグによる免除、config キーでの無効化の 4 つ |
| 決定 | `mcp-dispatcher.sh` の順は deny > ask > allow を保つ。`pr-create-block.sh` → `pecot-post-ask.sh` → `context7-allow.sh` |
| 決定 | Bash の `pecot` の起動形を見つける判定は、`lib/core/pecot-cli-deny.sh` に置く |
| 決定 | 判定の文言は今の文言を写し、テストで一致させる |
| 理由 | 判定を入れる時期は、MCP サーバの登録前に ask が発火しないことと、Bash の deny を早く繋ぐと今のスキルが動かなくなることで決まる |
| 時期 | 各判定を入れる時期は contracts/hooks-guard.md が正 |
| 退けた案 | Bash 側の判定を残して MCP 側に足す（同じ規則が 2 か所になる） |

## R-9. hooks のテストの移し方

| 項目 | 内容 |
|---|---|
| 決定 | pytest 1,569 件を vitest の `hooks` project に移す。shell を `child_process.spawnSync` で起動し、stdin・env・終了コード・stdout を確かめる |
| 決定 | `test-hooks` レーンは、移行中は pytest と vitest の両方を流す。フェーズ 12 で vitest だけにする |
| 決定 | 移し残しは、件数ではなく移行元の pytest のケースとの対応で比べる。`scripts/ci/compare_junit.py` で、pytest の JUnit と vitest の JUnit（`cli-node/test-results/junit-hooks.xml`）をファイルごとに比べる。フェーズ 8 が足したケースは、1,569 件との比較から除く |
| 決定 | 起動スクリプトの一覧は、済みの `baseline-scripts.test.ts` の方式で基準と比べる |
| 決定 | フェーズ 8 は最初から vitest でケースを書く。`mcp-dispatcher.sh` を変えるときは、既存の pytest（`hooks/tests/test_pre_mcp.py` など）も同じ PR で直す |
| 理由 | hooks は shell なので v8 のカバレッジは取れない。新しいケースが増えると件数だけでは移し残しを隠すので、対応で比べる |
| 時期 | フェーズ 1 の後ならいつでも進められる。フェーズ 11 で hooks を変えるので、移したテストに同じ変更を入れる |

## R-10. カバレッジ

| 項目 | 内容 |
|---|---|
| 決定 | 閾値は済みの `vitest.config.ts` の `max(baseline.cli.lineCoverage, 90)`（今は 91.0）。基準値は書き換えない |
| 理由 | spec FR-008 |

## R-11. Agent Plugins 1.0 の形と MCP の登録

| 項目 | 内容 |
|---|---|
| 決定 | pecot-visual と同じ形にする。root に `plugin.json`（`$schema` は 1.0.0、name `pecot-w`）と `mcp.json`（`pecot-workflow` を `./bin/pecot`、`args: ["mcp"]`、stdio。今の `.mcp.json` の context7 と `pecot-workflow-playwright` も持つ）を置く |
| 決定 | Copilot CLI 向けの hooks は `com.github.copilot/hooks/hooks.json` に移す。matcher に `pecot-workflow-.*` を足す。agents は pecot-visual と同じく `com.github.copilot/agents/` に置く。旧形式 `.github/plugin/plugin.json` と `hooks/hooks-copilot.json` は消す |
| 決定 | Claude Code 向けの `.claude-plugin/plugin.json`・`.mcp.json`・`hooks/hooks.json` は残す。両形式の name・version・MCP サーバと args の一致を、pecot-visual の `cli/tests/bootstrap/manifest.sh` と同じ確認で固定する。どちらも `env` は付けない |
| 決定 | `project.json` の `release.version.manifestRootsToUpdate` の `.github/plugin` を `{projectRoot}` に替える。`.nx/nx-release/` の version-actions とそのテストの旧形式の参照も直す |
| 決定 | 1.0 の形は切り替えの PR で出す |
| 理由 | Copilot CLI は root の 1.0 の `plugin.json` を `.claude-plugin/plugin.json` より先に読み、`mcp.json` から `PLUGIN_DATA` を渡す。1.0 の形を見ると旧形式と `hooks/` を読まないので、hooks・MCP・スキルの切り替えと同時でなければならない |
| #41 との分担 | pecot-workflow の manifest と準拠範囲はこの spec で片づける。3 プラグイン共通の名乗り、manifest の検証の統合、2 重持ちの同期規約の文書化は #41 に残す。#41 の本文は書き換えず、結果をコメントする |

## R-12. 長い処理

| 項目 | 内容 |
|---|---|
| 決定 | `release merge` などは MCP の呼び出しの中で完了まで待ち、結果だけを返す |
| 理由 | pecot-tools の executor も完了まで待つ |

## R-13. 切り替え

| 項目 | 内容 |
|---|---|
| 決定 | 1 つの PR と version plan で、スキル本文、Bash の deny、`external-post-check.sh` の pecot の判定の削除、`bin/pecot` のミラー化、MCP の登録、1.0 の形をそろえて出す |
| 決定 | スキルの書き換えは切り替えの PR に入れる。旧 plan では独立したフェーズだったが、単独でリリースされると MCP サーバの無い版に MCP を呼ぶスキルが届く |
| 決定 | Python の削除は切り替えの後の PR で行う |
| 決定 | SC-009 は、フェーズ 11 の PR の中で 1 回計る。同じ端末で続けて、切り替えの前の `bin/pecot`（Python）と後の `bin/pecot`（Node のミラー）を 5 回ずつ計り、初回の準備は数えない |
| 決定 | 接続先は偽の GitHub サーバ（`PECOT_GITHUB_API_URL` をループバックに向ける）にする。2 つの中央値を PR の本文と `.pecot/work/<Issue番号>/` に残す |
| 理由（計測） | `project info` は GitHub の API を呼ぶので、実サーバだと通信の時間で中央値が入れ替わる。Python の値は、フェーズ 12 の後は取り直せない |
| 理由 | spec FR-014。trunk-based で pecot-workflow のリリースの時期は決まっていないので、組み合わせの食い違う版が出る余地を PR の単位で無くす |

## R-14. 単体配布 `@pecot/workflow-mcp`

| 項目 | 内容 |
|---|---|
| 決定 | pecot-tools と同じ方式にする。`plugins/pecot-tools/scripts/release/` の `publish-mcp-dist.sh`・`finalize-dist.mjs`・`mcp-dist-README.md`・`tests/` を `plugins/pecot-workflow/scripts/release/` に写す |
| 流れ | `nx-release-publish` が配布ツリーを `npm pack` で tgz にし、GitHub Release に添えて `publish-npm.yml` を起動する。`publish-npm.yml` が trusted publishing で npm に出す |
| 決定 | `publish-npm.yml` のタグの形 `^pecot-(visual\|tools)-v...` に `workflow` を足す。パッケージ名は `@pecot/workflow-mcp` |
| 決定 | bin は `bin/pecot-workflow-mcp.mjs`。登録は `npx -y @pecot/workflow-mcp` |
| データ置き場 | 単体配布は `bin/pecot` を通らない。CLI 自身が `CLAUDE_PLUGIN_DATA` → `PLUGIN_DATA` → 既定の場所の順で解決する（済みの `infra/paths.ts`） |
| hooks | 含まれない。`issue_create`・`issue_quick`・`pr_create` の確認は動かず、MCP クライアント自身の確認だけになる。配布の README に書く |
| 初回の publish | npm の trusted publisher は、パッケージごとに npm 側で設定する。`@pecot/workflow-mcp` の初回の設定は利用者が行う。フェーズ 13 の Issue に手順を書く |
| 時期 | Python の削除と `cli/` への移動の後。スクリプトのパスを 2 回直さずに済む |

## R-15. 移行中の Python の依存

| 項目 | 内容 |
|---|---|
| 決定 | `.github/dependabot.yml` の uv（`/plugins/pecot-workflow/cli`）のエントリに `open-pull-requests-limit: 0` を付け、版の更新の PR を止める |
| 決定 | 脆弱性の alert が出た依存は、手で上げる。同じ PR で golden を記録し直し、Node を追従させる |
| 決定 | フェーズ 12 で uv のエントリを消す |
| 理由 | spec FR-018。版の更新の PR を止めても、Dependabot の alert とセキュリティ更新は止まらない |
| 退けた案 | エントリを今消す（Python を消すまで、uv の lock を持つ install 単位がある、という dependabot.yml の規約から外れる） |

## R-16. 定義書との比較（`export-interface.ts --check`）

| 項目 | 内容 |
|---|---|
| 決定 | `cli-node/scripts/export-interface.ts` に `--check` を実装する。`COMMANDS` から `exportEntries` で作った項目を、`interface/generated.json` の同じ ID の項目と比べる。Node に登録したコマンドだけを見る |
| 決定 | 切り替えの前に比べる欄は、`surfaces.mcp` 以外の全部（`input`・`cli`・`name`・`description`・`hidden`・`deprecated`・`surfaces.cli`）。Python と Node の書き出しの差は `surfaces.mcp` だけなので、説明などの差もフェーズ 11 を待たずに見える |
| 決定 | 比べ方は `libs/interface-spec/src/domain/diff.ts` の `diffGenerated` を使う。`diffGenerated` は項目と欄を絞る引数を持たないので、呼ぶ側で絞る。定義書の項目を Node の ID だけにしたものと、Node の項目から `surfaces.mcp` を除いたものを渡す |
| 決定 | 差の表示は、`diffGenerated` の行（`<ID>: <欄>: <前> -> <後>`）を `createOutput().error` に渡す。`formatStale` は `--write` を促す行を出すので、切り替えの前には使わない。切り替えの後は使う |
| 決定 | `main` に `generated.json` のパスを差し替える引数を足す（pecot-tools の `options.target` と同じ）。テストは一時ファイルの定義書で確かめる。テストに書く見本の ID は、`lint-defs` が拾う形の文字列をそのまま書かず、文字列の連結で作る |
| 決定 | 登録が 0 件のときは、`--check` も `--write` も warning を 1 行出して 0 で終わる（今の実装のまま）。登録が 1 件以上で切り替えの前の `--write` は、使い方のエラー（終了コード 2） |
| 決定 | `libs/interface-spec` の読み方は、pecot-tools の `cli/scripts/export-interface.ts` と同じ相対パス。`GeneratedFile` の型は配列が変更可能なので、渡す前に写す |
| 決定 | 流す場所は `test-cli` レーン。`tests/interface-export.test.ts` から `main(['--check'])` を呼ぶ。`project.json` の `test-cli` と `lint-cli` の両方の inputs に、`interface/generated.json` と `libs/interface-spec` の `src/domain/diff.ts`・`schema.ts`・`utility.ts`・`package.json` を足す。`.githooks/tests/test_nx_affected_mapping.py` の `diff.ts` の届く先の期待値も直す |
| 決定 | `--check` のために新しいレーンは作らない |
| 決定 | `generated.json` に無い ID を Node が登録していたら失敗にする。Node に無い ID は、切り替えまで失敗にしない |
| 理由 | Node の項目は `surfaces.mcp` を持つので、ファイル全体では Python の書き出しと一致しない。見本は `interface-export.test.ts` の「typer の書き出しと同じ」 |
| 退けた案 | 比べる欄を `input` と `cli` に絞る（他の欄の差がフェーズ 11 まで見えない）。`interface-spec:lint-defs` に入れる（pecot-workflow の build に依存し、lint が重くなる） |

## R-17. 振る舞いの項目のつなぎ

| 項目 | 内容 |
|---|---|
| 計った値 | `authored.yaml` の振る舞いの項目は 769 個。project 82、issue 138、pr 107、session 43、release 88、worktree 129、グループ無しの 4 個 75（`create-branch` 27、`delete-branch` 18、`add-to-project` 17、`update-issue-status` 13）、同期の 2 個 90、共通の `PW-COMMON` 17 |
| 確かめたこと | `lint-defs` の links は、`targets.json` の `tests` のファイルを文字として読み、ID の形の文字列を拾う。1 つの ID が pytest と vitest の両方にあっても通る。pecot-workflow の `tests` には `cli-node/tests/**/*.ts` が既に入っている |
| 決定 | コマンドを移すフェーズで、そのコマンドの項目ごとに vitest のケースを書き、`verifies(context, 'PW-…')` で ID を書く。pytest の側はフェーズ 12 まで残す |
| 決定（置き場） | ケースは `cli-node/tests/interface/<グループ>.test.ts` に置く（`vitest.config.ts` の include に既にある）。いちばん外の `describe` はコマンド名（`.claude/rules/test-conventions.md`）。共通の項目は `tests/interface/common.test.ts`。`tests/commands/` は include に無いので使わない |
| 決定（書き方） | pytest の差し替えは、次の表のとおりに読み替える。起動は `cli-node/src/cli.ts` の `runCli(argv, context)` をプロセス内で呼ぶ（カバレッジに数える）。表を回すケースは `it.for` を使い、行に ID をリテラルで持たせる（`it.each` では `annotate` が使えない）。`tests/interface/` では `it.skip`・`it.todo` を使わない |
| 決定（確認） | 項目のつなぎの確認は、`verifies(` の引数として ID があることを見る（コメントの中の ID は数えない）。ID のあるファイルが vitest の include に当たることも確かめる |
| 決定（対応表） | コマンドを移すフェーズの PR は、「項目の ID・元の pytest のケース・vitest のケース」の対応表を `.pecot/work/<Issue番号>/` に残す |
| 決定（前後比較） | 前後比較のシナリオにはつながない（spec の Clarifications）。`tests/parity/` の下に ID を書かない。憲章 II の「実際のコマンドを現実の入力で実行する」確認は、前後比較のシナリオが受け持つ |
| 決定（共通の項目） | 共通の `PW-COMMON` 17 個は、フェーズ 1 でつなぐ。中身はグローバルオプション・API の URL の検証・捕まえなかった例外で、済みの `cli.ts` の枠の振る舞いである。コマンドの要る項目は、見本のコマンド定義で確かめる |
| 理由 | `lint-defs` は pytest の側の ID で通ってしまうので、移したコマンドの項目が Node につながったかを別に確かめる必要がある。pytest には `patch(` が約 2,000 箇所あり、内部の関数の差し替えをそのまま写すと憲章 II のモックの決めに反する |
| 退けた案 | フェーズ 12 でまとめてつなぐ（spec の Clarifications で退けた） |

pytest の差し替えの読み替えは次の表のとおり。

| pytest の差し替え | vitest での置き換え |
|---|---|
| `GitHubClient` | 偽の GitHub サーバ（`tests/fake-github/`）の応答 |
| `load_active_config` などの設定の読み | 一時ディレクトリに置いた設定ファイル |
| `git_current_branch` などの git の関数 | 一時 git リポ |
| 呼び出しの確認（`assert_called_with`） | 偽サーバが受けた要求の比較、または終わった後のファイルの比較 |

## R-18. 定義書の書き出しの元の差し替え

| 項目 | 内容 |
|---|---|
| 決定 | フェーズ 1 で `libs/interface-spec/targets.json` の pecot-workflow の `sources` に `cli-node/src` を足す（Python と併記）。同じ変更で `libs/interface-spec/project.json` の `lint-defs` の inputs にも足す |
| 決定 | フェーズ 1 で、`lint-defs` の環境変数の読みの確認の失敗（試算で 41 件）を 0 件にする。やることは 3 つで、`authored.yaml` の `environment` に製品コードが読む名前を足す、名前が文字列でない読みに `interface-env:` の注記を付ける、テストのファイルを `sources` の glob から外す（glob を分けて書く） |
| 決定 | フェーズ 11（切り替え）で `--write` を実装し、`generated.json` を Node から書く。同じ PR で `scripts/interface/export.py` と `cli/tests/unit/test_interface_export.py` を消し、`sources` から Python を外す |
| 決定 | フェーズ 12 で、`cli-node/` → `cli/` のパスの直しと、`tests` から Python を外す作業をする |
| 決定 | コマンドを移すフェーズの共通の完了条件に「`interface-spec:lint-defs` が通る」を足す |
| 表 | `targets.json`・`lint-defs` の inputs・`docs/conf.py` の `iface_junit` の、フェーズごとの読む先は contracts/interface.md を正とする |
| 確かめ方 | フェーズ 11 の PR の `generated.json` の差分が、各項目の `surfaces.mcp` だけであること（SC-010） |
| 理由 | 切り替えまで利用者に届くのは Python の CLI で、定義書は届いている実装を写す（spec の Clarifications）。`sources` を後から替えると失敗が一度に出るので、フェーズ 1 で併記して片づける |

## R-19. スキルなどの書き換えの対象

| 項目 | 内容 |
|---|---|
| 計った式 | `git grep -ohE '\bpecot"? +(issue\|pr\|project\|session\|worktree\|release\|security\|dependabot\|add-to-project\|update-issue-status\|create-branch\|delete-branch)\b' -- 'plugins/pecot-workflow/skills/**' 'plugins/pecot-workflow/agents/**' 'plugins/pecot-workflow/hooks/templates/**' \| wc -l`。行ではなく、出現の数を数える |
| 計った値 | 2026-11-11 に上の式で数え直した。28 ファイル 202 箇所。`skills/*/SKILL.md` が 15 ファイル 91 箇所、`skills/*/references/` が 11 ファイル 109 箇所、`agents/` が 1 ファイル 1 箇所、`hooks/templates/` が 1 ファイル 1 箇所。`$PECOT` の変数は 0 箇所 |
| 決定 | エージェントに Bash で実行させる記述を、MCP ツールの呼び出しに書き換える。利用者が端末で打つコマンドの説明は CLI のまま残してよい。`w-help` の `references/commands.md` は定義書の `surfaces.cli` だけを読むので、切り替えで変わらず、手で直さない |
| 決定 | 書き換える対象には、`skills/*/SKILL.md` の frontmatter の `allowed-tools` にある `Bash(*/bin/pecot ...)`（MCP ツールの名前に替える）と、`agents/w-e2e-planner.md` の `"${CLAUDE_PLUGIN_ROOT}/bin/pecot" issue create --prepare` も入る |
| 決定 | 書き換えるのは、コードブロックの中の呼び出しと、コードブロックの外で手順として実行を指示する文。フェーズ 11 のテスト（`tests/skills/tool-names.test.ts`）は、残す箇所のファイルと行の一覧を持ち、`pecot <サブコマンド>` の残りが一覧と同じであることを確かめる |
| 決定 | quickstart の走査も同じ式を使う |
| 理由 | CLI は利用者の端末と hooks のために残る（spec の Assumptions）。エージェントの Bash の `pecot` は deny される（FR-012） |

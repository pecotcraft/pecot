# Research: pecot-workflow の TypeScript 化と MCP 化（再設計）

調査日は 2026-11-05、対象は `pecotcraft/pecot` の main `2347067`。旧 spec 015 の research（調査日 2026-10-29）を基に、移行後のリポで確かめ直した。名前は aist → pecot に読み替えてある。

## R-0. 済んだものと今の状態

| 対象 | 状態 | 置き場 |
|---|---|---|
| 基準値 | CLI の行カバレッジ 91.0%（2026-10-29、旧リポの `ba0dedf2`）。hooks のテスト 1,569 件と起動スクリプトの一覧 | `cli-node/tests/parity/baseline.json` |
| 前後比較 | シナリオと golden が 213 件。`record:parity` と `record:parity:check`、`parity.test.ts` | `cli-node/tests/parity/` |
| golden の鮮度 | 2026-11-05 に今の Python で `record:parity:check` を流した。差は 12 件、誤りは 0 件。12 件は全部 `--help` と使い方エラーの表示で、typer 0.27.3 の書式の変化（`TEXT` → `<str>`、`ISSUE_REF` → `{issue_ref}`、列の幅）による | 作業記録は `.pecot/work/42/parity-check.log` |
| domain と infra | config、state、frontmatter、sections、reference-parser、format、changelog、release、repository-policy、dependabot、GitHub client（REST・GraphQL）、git、worktree、nx-scope、paths | `cli-node/src/domain/`、`cli-node/src/infra/` |
| CLI の枠 | `cli.ts` がグローバルオプションを typer と同じ順で処理する。`registry.ts` の `defineCommand()` と `COMMANDS`（空）、`command-binding.ts`、rich の枠と表の整形 | `cli-node/src/cli.ts`、`cli-node/src/commands/` |
| レーン | `build-cli`・`test-cli`・lint が `cli-node/` を対象に動く。`test-py` は Python を流す | `plugins/pecot-workflow/project.json` |
| hooks のテストの枠 | vitest の `hooks` project と `baseline-scripts.test.ts` | `cli-node/tests/hooks/` |

`cli/.venv` は、ふだん作業ツリーに無い。`record:parity` を流す前に `cli/` で `uv sync` を実行する。

## R-1. 移植の残り

| グループ | サブコマンド | Python のソース |
|---|---|---|
| グループ無し | add-to-project、update-issue-status、create-branch、delete-branch | `cli/commands/main.py` と `cli/core/` |
| project | list、search、init、create、info、activate、set-repo、set-aggregation-repo、unset-aggregation-repo、show-aggregation-repo | `project.py` 1,602 行 |
| issue | create、quick、read、comment、reopen | `issue.py` 2,007 行 |
| session | status、restore | `session.py` 233 行 |
| pr | create、read、merge、preflight | `pr.py` 2,226 行 |
| release | preflight、create、merge | `release.py` 634 行 |
| worktree | init、add、link、remove | `worktree.py` 446 行 |

共通の `repo.py`・`_repo_policy.py`・`options.py`・`repo_display.py` は、各グループの移植で要る分だけ写す。domain・infra に同じものがあれば、それを使う。

## R-2. 言語と構成

| 項目 | 内容 |
|---|---|
| 決定 | 済みの `cli-node/` の構成をそのまま使う。pecot-tools と同じ TypeScript・ESM・commander・zod・vitest・ESLint・knip で、pnpm workspace はプラグイン単位 |
| 決定 | MCP は pecot-tools と同じ `@modelcontextprotocol/server` を足す。版は pecot-tools にそろえる |
| 決定 | Python を消すフェーズで `cli-node/` を `cli/` に移す。`build-cli` などの inputs と `--filter` も同じ PR で直す |
| 理由 | 移行中は Python の `cli/` が配布物として動く。`bin/pecot` は `cli/` 全体のハッシュで venv を作るので、同じディレクトリに TS を置くと venv が作り直される |
| 退けた案 | 最終形も `cli-node/` のまま（他のプラグインと名前がずれる） |

## R-3. 実行用ミラーとデータ置き場

| 項目 | 内容 |
|---|---|
| 決定 | `bin/pecot` を pecot-tools の `bin/pecot-tools` と同じ型に書き換える。`bin/_lib.sh` に pecot-tools の `plugin_runtime_*` と Node の下限の確認（`*_node_runtime_*`）を写す。ミラーは `${DATA}/runtime/<deps-hash>-<src-hash>/` |
| 決定 | `PECOT_BOOTSTRAP_SKIP=1` は、本体ツリーの `cli/dist/cli.js` を直接起動する |
| 決定 | 切り替えの版は、初回起動で `${DATA}/venv/` を消す。`.inuse` の共有ロックを持つ世代は残し、次回の起動で消す |
| 理由 | marketplace は `plugins/<name>/` しか配らないので、`_lib.sh` はプラグインごとに持つ。データ置き場の解決の順は、pecot-workflow の `_lib.sh` に既にある |
| 退けた案 | root の `libs/` に置いてリンクで取り込む。pecot-tools 側も書き換えることになり、範囲を越える |

## R-4. コマンド定義の一覧

| 項目 | 内容 |
|---|---|
| 決定 | 済みの `registry.ts` の `defineCommand()` で 32 個を定義する。commander の登録（`command-binding.ts`）と MCP のツール登録は、`COMMANDS` から作る |
| 理由 | FR-004 の 1 対 1 を、一覧の数の一致で確かめられる |
| 退けた案 | MCP のツールを手で書く（pecot-tools の方式）。32 個の CLI と同期を保てない |

## R-5. MCP のツール名と hooks の matcher

| 項目 | 内容 |
|---|---|
| 決定 | サーバ名は `pecot-workflow`。ツール名は `<group>_<subcommand>`、グループの無いものはコマンド名の `-` を `_` にする |
| Claude Code | `mcp__plugin_pecot-w_pecot-workflow__<tool>`。導入済みの pecot-t のツール（`mcp__plugin_pecot-t_pecot-tools__aws_s3_ls`）と同じ形であることを確かめた |
| Copilot CLI | `pecot-workflow-<tool>` と推定する。根拠は `hooks-copilot.json` の matcher にある `github-mcp-server-create_pull_request` の形。フェーズ 8 で実物を確かめる |
| 決定 | hooks は、この 2 つの形から `<tool>` を取り出してから判定する |
| 退けた案 | `pecot_` の接頭辞（クライアントがサーバ名を前に付けるので重複する） |

## R-6. 前後比較と golden の記録し直し

| 項目 | 内容 |
|---|---|
| 決定 | 済みの仕組みを使う。Node の CLI の直接起動と MCP 経由の両方で、213 件を golden と比べる |
| 決定 | golden を記録し直すのは、Python の CLI か依存を変える PR だけ（spec FR-007）。その PR で Node も直す。対象は `record:parity:check` で差の出たシナリオに限る |
| 決定 | フェーズ 1 で、typer の書式でずれた 12 件を記録し直す。Node の CLI の使い方エラーとヘルプの整形（`usage-error.ts`・`help.ts`）は、記録し直した golden に合わせる |
| 理由 | golden を Node に合わせて書き換えると、前後比較が意味を失う |

## R-7. 対話入力

| 項目 | 内容 |
|---|---|
| 決定 | `worktree link` の上書き確認は、CLI では対話のまま残す。MCP ツールでは入力 `overwrite`（既定 false）で受ける。false なら上書きせず、対象を一覧で返す |
| 理由 | MCP ツールの呼び出し中は利用者に問えない。既定を「上書きしない」にすれば、確認なしで消えるものがない |

## R-8. hooks のガードの移し方

| 項目 | 内容 |
|---|---|
| 決定 | `external-post-check.sh` の pecot の判定を、MCP の `tool_input` を jq で読む `lib/mcp-handlers/pecot-post-ask.sh` に移す。判定は、ask の対象、`prepare` の素通し、スラッシュコマンドのフラグによる免除、config キーでの無効化の 4 つ |
| 決定 | `mcp-dispatcher.sh` の順は deny > ask > allow を保つ。`pr-create-block.sh` → `pecot-post-ask.sh` → `context7-allow.sh` |
| 決定 | Bash の `pecot` の起動形を見つける判定は、`lib/core/pecot-cli-deny.sh` に置く。フェーズ 7 では判定とテストだけを入れ、`pre-tool-use-bash.sh` から呼ぶのはフェーズ 10 |
| 決定 | `external-post-check.sh` の pecot の判定を外すのもフェーズ 10。それまではスキルが Bash で `pecot` を呼ぶので、今の確認を残す |
| 決定 | 判定の文言は今の文言を写し、テストで一致させる |
| 理由 | フェーズ 7 の時点では MCP サーバが登録されていないので、MCP 側の ask は発火しない。Bash の deny を早く繋ぐと、今のスキルが動かなくなる |
| 退けた案 | Bash 側の判定を残して MCP 側に足す（同じ規則が 2 か所になる） |

## R-9. hooks のテストの移し方

| 項目 | 内容 |
|---|---|
| 決定 | pytest 1,569 件を vitest の `hooks` project に移す。shell を `child_process.spawnSync` で起動し、stdin・env・終了コード・stdout を確かめる |
| 決定 | `test-hooks` レーンは、移行中は pytest と vitest の両方を流す。フェーズ 11 で vitest だけにする |
| 決定 | 件数と起動スクリプトは、済みの `baseline-scripts.test.ts` の方式で基準と比べる |
| 理由 | hooks は shell なので v8 のカバレッジは取れない。件数とスクリプトの一覧で減っていないことを確かめる |
| 時期 | フェーズ 1 の後ならいつでも進められる。フェーズ 7 と 10 で hooks を変えるので、移したテストに同じ変更を入れる |

## R-10. カバレッジ

| 項目 | 内容 |
|---|---|
| 決定 | 閾値は済みの `vitest.config.ts` の `max(baseline.cli.lineCoverage, 90)`（今は 91.0）。基準値は書き換えない |
| 理由 | spec FR-008 |

## R-11. Agent Plugins 1.0 の形と MCP の登録

| 項目 | 内容 |
|---|---|
| 決定 | pecot-visual と同じ形にする。root に `plugin.json`（`$schema` は 1.0.0、name `pecot-w`）と `mcp.json`（`pecot-workflow` を `./bin/pecot`、`args: ["mcp"]`、stdio。今の `.mcp.json` の context7 も持つ）を置く |
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
| 初回の publish | npm の trusted publisher は、パッケージごとに npm 側で設定する。`@pecot/workflow-mcp` の初回の設定は利用者が行う。フェーズ 12 の Issue に手順を書く |
| 時期 | Python の削除と `cli/` への移動の後。スクリプトのパスを 2 回直さずに済む |

## R-15. 移行中の Python の依存

| 項目 | 内容 |
|---|---|
| 決定 | `.github/dependabot.yml` の uv（`/plugins/pecot-workflow/cli`）のエントリに `open-pull-requests-limit: 0` を付け、版の更新の PR を止める |
| 決定 | 脆弱性の alert が出た依存は、手で上げる。同じ PR で golden を記録し直し、Node を追従させる |
| 決定 | フェーズ 11 で uv のエントリを消す |
| 理由 | spec FR-018。版の更新の PR を止めても、Dependabot の alert とセキュリティ更新は止まらない |
| 退けた案 | エントリを今消す（Python を消すまで、uv の lock を持つ install 単位がある、という dependabot.yml の規約から外れる） |

# Quickstart: pecot-workflow の TypeScript 化と MCP 化の確かめ方

## 前提

- `pecotcraft/pecot` の worktree。Node `^24.22.1`、pnpm、git、gh
- Python を消すまでは、golden の点検と記録に uv と Python 3.10 以上も要る。流す前に `plugins/pecot-workflow/cli/` で `uv sync` を実行する
- CUJ 1 を確かめる端末には Python と uv を入れない。devcontainer の外の素の Node 環境か、`PATH` から外したシェルを使う

## lint とテスト

```bash
npx nx run pecot-workflow:lint
npx nx run pecot-workflow:test-cli
npx nx run pecot-workflow:test-hooks
npx nx run pecot-workflow:test-skills
```

期待: 全部通る。`test-cli` の行カバレッジが `baseline.json` の 91.0 以上。

## 前後比較

```bash
# 今の Python と golden の差（Python を変える PR で使う）
pnpm -C plugins/pecot-workflow --filter @pecot/pecot-workflow-cli run record:parity:check
# 差の出たシナリオだけ記録し直す
pnpm -C plugins/pecot-workflow --filter @pecot/pecot-workflow-cli run record:parity <id>...
```

期待: `record:parity:check` の差が 0。`test-cli` の `parity.test.ts` で、Node の直接起動と MCP 経由の両方が全件（228 件以上）一致する（SC-004）。形式は [contracts/parity.md](./contracts/parity.md)。

## 定義書との一致

```bash
# Node に登録したコマンドの input と cli を、定義書と比べる（test-cli の中でも流れる）
pnpm -C plugins/pecot-workflow --filter @pecot/pecot-workflow-cli exec tsx scripts/export-interface.ts --check
# 定義書の項目とテストのつなぎ、実装との食い違い
npx nx run interface-spec:lint-defs
```

期待: `--check` の差が 0 件（SC-010）。`lint-defs` に `has no test` の行が無い（SC-011）。
切り替えの PR では、`interface/generated.json` の差分が各項目の `surfaces.mcp` だけ。形式は [contracts/interface.md](./contracts/interface.md)。

## CUJ

| # | 手順 | 期待 |
|---|---|---|
| 1 | Python と uv の無い端末で、Claude Code にプラグインを入れて `/pecot-w:w-help` を実行する | データ置き場の `runtime/` にミラーができ、スキルが MCP ツールで動く（SC-001） |
| 2 | GitHub Copilot CLI で `/pecot-w:w-breakdown` を実行する | `project_info` と `issue_read` が呼ばれ、データ置き場が見つからずに止まることがない（SC-002） |
| 3 | スラッシュコマンドの外で、エージェントに `issue_create` を呼ばせる | ask が返る。理由の文言は移行前と同じ（[contracts/hooks-guard.md](./contracts/hooks-guard.md)） |
| 4 | エージェントに Bash で `pecot issue read owner/repo/1` を実行させる | deny され、`issue_read` を使うよう返る |
| 5 | 利用者が `! pecot project info` を実行する | 結果が出る（deny されない） |
| 6 | 移行前の版で作ったデータ置き場のまま、切り替えの版に更新して起動する | `venv/` が消え、ボードの設定とセッション状態はそのまま読める |
| 7 | `worktree_link` を `overwrite` なしで呼ぶ。上書き先に実ファイルがある | 上書きされず、対象が一覧で返る |
| 8 | プラグインを入れていない MCP クライアントに `npx -y @pecot/workflow-mcp` を 1 エントリ登録する | 34 個のツールが見え、`project_info` が結果を返す（SC-008） |
| 9 | 時間のかかるツール（`release_preflight`）を MCP で呼ぶ | タイムアウトせず、CLI と同じ結果が返る |

CUJ 1〜7 と 9 はフェーズ 11 の後、CUJ 8 はフェーズ 13 の後に確かめる。

## 走査

```bash
# スキル・agents・templates の、Bash で pecot を呼ばせる記述（SC-003。残してよい箇所は tests/skills/tool-names.test.ts の一覧）
git grep -nE '\bpecot (issue|pr|project|session|worktree|release|[a-z]+-[a-z-]+)' -- 'plugins/pecot-workflow/skills/**' 'plugins/pecot-workflow/agents/**' 'plugins/pecot-workflow/hooks/templates/**'
# Python の残り（SC-006。フェーズ 12 の後）
git ls-files 'plugins/pecot-workflow/**/*.py' 'plugins/pecot-workflow/**/pyproject.toml' 'plugins/pecot-workflow/**/uv.lock'
# 旧形式の manifest（フェーズ 11 の後）
git ls-files 'plugins/pecot-workflow/.github/plugin/*' 'plugins/pecot-workflow/hooks/hooks-copilot.json'
```

期待: 1 つ目は、利用者向けの説明として一覧に載せた箇所だけ。ほかは 0 件。

## 性能

```bash
for i in 1 2 3 4 5; do /usr/bin/time -f %e pecot project info >/dev/null; done
```

切り替えの前に Python の版で、後に Node の版で 5 回ずつ計る。Node の中央値が Python の中央値以下（SC-009）。

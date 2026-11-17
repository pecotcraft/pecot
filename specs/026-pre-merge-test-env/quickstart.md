# Quickstart: 試験環境を確かめる

この機能ができたことを、最初から最後まで確かめる手順。細かな決まりは [contracts/](contracts/) と [data-model.md](data-model.md) にある。

## 前提

| 用意するもの | 中身 |
|---|---|
| 作業ツリー | 確かめたいブランチの checkout。以下 `<作業ツリー>` と書く |
| 検証用の clone | `.pecot/work/<Issue番号>/pecot-sandbox/` に `pecotcraft/pecot-sandbox` を clone する |
| 認証 | 手元は、今の `gh` の認証と `.pecot/config/.env` |

## 1. スクリプトのテスト

```bash
.githooks/tests/run.sh test_sandbox_diff.py
.githooks/tests/run.sh test_sandbox_sweep.py
```

期待: どちらも通る。場合の一覧は [contracts/sandbox-scripts.md](contracts/sandbox-scripts.md) にある。

## 2. 設定を比べる（US1、SC-005）

```bash
.githooks/scripts/sandbox-diff.sh
```

| 手順 | 期待 |
|---|---|
| そのまま動かす | 「ずれは 0 件」、終了コード 0 |
| 検証用の ruleset から必須チェックを 1 つ外して動かす | 1 件。項目の名前と、両方の値が出る。終了コード 1 |
| 外したチェックを戻して動かす | 0 件に戻る |

## 3. 直した pecot-workflow を動かす（US2、SC-003、SC-006）

作業ツリーで、w-help の本文に「試験 456」の 1 行を足す。

```bash
cd .pecot/work/<Issue番号>/pecot-sandbox
claude --plugin-dir <作業ツリー>/plugins/pecot-workflow plugin list --json
claude --plugin-dir <作業ツリー>/plugins/pecot-workflow
```

| 見るもの | 期待 |
|---|---|
| `plugin list --json` の `pecot-w@inline` の行 | `installPath` が作業ツリーを指す |
| セッションで w-help を起動する | 本文に「試験 456」がある |
| MCP ツール `board_show` を呼ぶ | `project` の `name` が `github.com_pecotcraft_pecot-sandbox_sandbox`、`number` が `3`（ボード `pecot sandbox`）。書き込む前に、毎回これを見る（FR-031） |
| ふだんの起動のしかたで w-help を起動する | 「試験 456」が無い |

GitHub Copilot CLI でも、同じことを確かめる。

```bash
COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir <作業ツリー>/plugins/pecot-workflow
```

| 見るもの | 期待 |
|---|---|
| `/env` | プラグインの読み込み元が作業ツリーを指す |
| w-help を起動する | 本文に「試験 456」がある |

読まれないものと、直しを反映させる操作は、CONTRIBUTING の「直した pecot-workflow を動かす」にある。

## 4. GitHub に書き込む処理を、検証用で最後まで動かす（US1、SC-002）

3 のセッションで、次を順に動かす。作るものの名前は `cuj/<Issue番号>-<乱数>` の形にする。

| 手順 | 期待 |
|---|---|
| Issue を作る | 検証用のリポに Issue ができ、ボード `pecot sandbox` にカードが載る |
| ブランチを作って 1 行直し、PR を作る | 検証用のリポに PR ができる |
| CI を待ってマージする | PR が検証用の merge queue を通り、squash でマージされる。カードが動く |
| CI が落ちる PR を queue に入れる | queue から外され、外されたときの手順が動く |
| 2 つのセッションで、同じ手順を同時に流す | どちらも最後まで進み、互いの Issue・PR・カードを動かさない |
| CONTRIBUTING の節にある、書き込む処理の一覧を順に流す | どれも検証用で最後まで進む。流せないものは、訳が一覧に書いてある |
| このリポの Issue・PR・ボードを見る | 何も増えておらず、動いてもいない |

## 5. 片付ける（US1、SC-007）

```bash
.githooks/scripts/sandbox-sweep.sh --issue <Issue番号> --dry-run
.githooks/scripts/sandbox-sweep.sh --issue <Issue番号>
.githooks/scripts/sandbox-sweep.sh --issue <Issue番号>
```

| 手順 | 期待 |
|---|---|
| `--dry-run` | 片付けるものが並ぶ。何も消えない |
| 1 回目 | 開いた PR・ブランチ・Issue が片付き、カードがアーカイブされる |
| 2 回目 | 「片付けるものは 0 件」 |
| 4 と 5 を、合わせて 3 回くり返す | 3 回目の片付けの後、検証用に確かめで作ったものが残っていない |

## 6. 配る自動化を、検証用で起こす（US3、SC-004）

作業ツリーで、`cli/templates/workflow/pecot-board-sync.yml` のログに「試験 456」の 1 行を足す。

| 手順 | 期待 |
|---|---|
| 直したテンプレートを、検証用の PR で `.github/workflows/` に入れる | 検証用の merge queue を通って入る |
| 検証用で workflow を起こす | 実行のログに「試験 456」がある。ボード `pecot sandbox` に結果が出る |
| このリポの workflow の実行の一覧とボードを見る | 変わっていない |
| 1 時間おいて、検証用の実行の一覧を見る | 定期の起動による実行は増えていない |
| 検証用の workflow を、このリポの main のテンプレートに戻す PR を入れる | `sandbox-diff.sh` が「ずれは 0 件」に戻る |

## 7. 計画の「流す先」（US4、SC-001、SC-011）

| 手順 | 期待 |
|---|---|
| PR を作る処理に手を入れるブランチで、w-active の計画を作る | 外へ書き込む CUJ に「流す先 — `pecotcraft/pecot-sandbox` とボード `pecot sandbox`」がある |
| 手元のファイルだけを書く CUJ を含む計画を作る | その CUJ は「流す先 — 手元」 |
| 流す先の行を消した計画を w-reviewer に渡す | 欠けとして、CUJ の番号が挙がる |
| 流す先をこのリポにした計画を w-reviewer に渡す | このリポで流す計画として挙がる |
| CUJ を w-e2e-planner に流させる | 検証用に PR ができ、結果に URL が載る。このリポには PR ができない |
| プロジェクトの指示に検証用が無いリポで、同じ手順を踏む | 計画が作られ、CUJ が流れて、止まらない |

## 8. フェーズの前後の決まり（US6、SC-010）

場合と期待は [contracts/prerequisite-rule.md](contracts/prerequisite-rule.md) の「確かめ」にある。

## 9. 人のいないセッション（US5、SC-008、SC-009）

動かし方は、research の R11-6 の結果でユーザーが選ぶ。選んだ動かし方で、次を確かめる。

| 手順 | 期待 |
|---|---|
| セッションを始め、人が何も打たない | 4 と同じ確かめが、検証用で最後まで流れる |
| 同じ権限で、このリポに Issue を作ろうとする | 拒まれる |
| 権限を外して、確かめを流そうとする | 認証の失敗を知らせて止まる。このリポへ書き込める権限に切り替えない |
| できないと分かった点 | CONTRIBUTING の節に、できる範囲とできない範囲が残っている |

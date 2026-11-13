# Quickstart: 動作の確かめ方

**Date**: 2026-11-12

実装の後に、このリポと検証用のリポで通す手順。
コマンドの形は [contracts/cli-commands.md](contracts/cli-commands.md)、値の定義は [data-model.md](data-model.md) にある。

## 準備

| 用意するもの | 内容 |
|---|---|
| 検証用のリポ | `pecotcraft/pecot-sandbox`。squash のマージと、開発ブランチの ruleset を、このリポと同じにする。別のリポの前提用に `pecotcraft/pecot-sandbox-b` も使う |
| 検証用のボード | 組織 `pecotcraft` の Project #3（https://github.com/orgs/pecotcraft/projects/3） |
| 作業ディレクトリ | `.pecot/work/<Issue番号>/pecot-sandbox/` に clone し、worktree を 2 つ作る |

clone で、次の 3 点を確かめる。

| 確かめるもの | 期待 |
|---|---|
| `echo "${CLAUDE_PROJECT_DIR:-unset}"` | `unset` |
| `git rev-parse --show-toplevel` | clone のパス |
| 本体の worktree の `git status --short .pecot/config` | 出力が空。`.pecot/config/projects/.active` が変わっていない |

R14 の確かめの跡を片付ける。

- 作った Issue・PR（`pecot-sandbox` の #1〜#12、`pecot-sandbox-b` の #1）を閉じ、ボードからアーカイブする
- 残した blocked by（#5 ← #3）を外す

Project #3 の Status には `Needs Attention`、pecot-workflow-sandbox には `Blocked` が、R14 の確かめで既に入っている。
`pecot project init` の前に、`updateProjectV2Field` でこの 2 つを外す。
既存の選択肢を id・name・color・description 付きで送り、2 つだけを抜く。
外しても、ほかのカードの値が残っていることを見る。

ボードの画面で、進行の欄の列が `Pending` / `Backlog` / `Blocked` / `Ready` / `Active` / `In Review` / `Archived` の順に並ぶことを見る。`Blocked` の列が隠れていてはならない。

```bash
pecot project init          # Blocked と Needs Attention を足す
pecot project set-repo pecotcraft/pecot-sandbox --develop-branch main
pecot project info          # 判定が出ることを見る
```

開発ブランチの無い設定では、前提を持つ Issue の判定が `unknown (develop_branch is not set for …)` になる。`project set-repo` で先に入れる。

| 見るもの | 期待 |
|---|---|
| `pecot project init` の出力 | 外した後の 1 回目は、`added: option Blocked` と `added: option Needs Attention` が出る。2 回目は `unchanged:` になる |
| ボードの画面 | `Blocked` の列が `Ready` の左にある。既にあったカードの列と札が変わっていない |
| 既定の自動化 | PR を 1 本マージし、札が `Done` になる |

## 1. 一括投稿が前提を付ける（US1）

前提の表のある tasks.md を用意する。5 つのフェーズで、形は次のとおり。

| Phase | 前提 | 種類 |
|---|---|---|
| 2 | 1 | 積める |
| 3 | 2 | 積める |
| 4 | 2 | 積める |
| 5 | 3 | 積める |
| 5 | 4 | マージを待つ |

```bash
pecot issue create --plan phase1.md phase2.md phase3.md phase4.md phase5.md
pecot issue create phase1.md phase2.md phase3.md phase4.md phase5.md
```

| 見るもの | 期待 |
|---|---|
| `--plan` の表 | Phase 1 は `alone`、2・3・4 は `stack on`、5 は `wait for merge of phase4` |
| `--plan` の積める並び | `phase1 -> phase2 -> phase3` と `phase1 -> phase2 -> phase4` の 2 本 |
| Issue の画面 | Phase 2〜5 に blocked by が付く。指す先が表の行と合う |
| Phase 5 の本文 | 末尾に `## Waits for merge` があり、Phase 4 の Issue と理由が 1 行ある |
| Phase 2〜4 の本文 | 前提についての記述が無い |
| タイトル | 番号が通しで並ぶ。枝の文字が無い |
| ボード | Phase 1 が `Ready`、Phase 2〜5 が `Blocked` |

## 2. 一覧に判定が出る（US2）

```bash
pecot project info
pecot issue read <owner/repo/Phase 5 の番号>
```

| 見るもの | 期待 |
|---|---|
| `Ready` の表 | Phase 1 が `startable` |
| `Blocked` の表 | Phase 2 が `blocked by #<1>`。Phase 5 に、マージを待つ理由が出る |
| `issue read` | `Blocked by:` に 2 件と種類、`Readiness:` に `blocked` |

## 3. 積んで着手する（US3・US4）

worktree A で Phase 1 に着手し、PR を出す。

```bash
pecot create-branch <owner/repo/Phase 1> feat/phase1
# 実装してコミットする
pecot pr create --prepare && pecot pr create <ファイル>
pecot project info
```

| 見るもの | 期待 |
|---|---|
| `pr create` の出力 | `moved: #<2> Blocked -> Ready` が出る |
| ボード | Phase 2 が `Ready` に移る。Phase 3〜5 は `Blocked` のまま |
| `Ready` の表 | Phase 2 が `stackable on #<1>` |

worktree B で Phase 2 に着手し、PR を出す。

```bash
pecot create-branch <owner/repo/Phase 2> feat/phase2
pecot session status -D .
# 実装してコミットする
pecot pr create --prepare && pecot pr create <ファイル>
```

| 見るもの | 期待 |
|---|---|
| `create-branch` の出力 | `from feat/phase1/<1> (stacked on #<1>)` |
| `session status` | `## Stack` の節に、base と Phase 1 の PR が出る |
| PR の画面 | base が Phase 1 のブランチ。差分に Phase 2 の変更だけが出る。2 つの PR がスタックとして並ぶ |
| PR の CI | 開発ブランチ向けの PR と同じレーンが動く |

## 4. ブロック中の着手は止まる（US3）

```bash
pecot create-branch <owner/repo/Phase 5> feat/phase5
```

| 見るもの | 期待 |
|---|---|
| 終了コード | 2 |
| 出力 | `is blocked by` と、マージを待つ理由、直し方の 2 行 |
| リモート | ブランチができていない |

## 5. 下の段を直して、上の段を載せ直す（US6）

worktree A で Phase 1 にコミットを足して push する。worktree B で確かめる。

```bash
pecot pr restack --check
pecot pr restack
```

| 見るもの | 期待 |
|---|---|
| `--check` | `needs restack` |
| `restack` の後の PR | 差分が Phase 2 の変更だけに戻る |
| worktree A | 未コミットの変更とブランチの位置が変わっていない |

worktree A と B が同じ行を変えた状態でも試す。

| 見るもの | 期待 |
|---|---|
| `restack` | 終了コード 3。衝突したファイルと、`--continue`・`--abort` の案内が出る |
| `--abort` の後 | ブランチが載せ直しの前の位置に戻る |

## 6. 下からマージする（US5）

`pecot-sandbox` の main の ruleset（id 27130266）には、merge queue の規則がある。
この節の本筋は merge queue を通さないので、先にその規則を外す。

```bash
pecot pr merge <owner/repo/Phase 2 の PR>     # 止まる
pecot pr merge <owner/repo/Phase 1 の PR>
pecot pr cleanup <owner/repo/Phase 1 の PR> --delete-branch
```

| 見るもの | 期待 |
|---|---|
| Phase 2 の PR のマージ | 終了コード 2。先にマージする PR が出る |
| Phase 1 の PR のマージ | `merged:` が出る。Phase 1 の Issue が閉じる |
| `cleanup` の出力 | `Readiness changed:` に、Phase 2 より後ろの Issue の変化が出る。載せ直しの案内が出る |
| Phase 2 の PR | 開いたまま、base が開発ブランチになっている |
| Phase 2 のブランチ | リモートに残っている |

worktree B で載せ直す。手元に足したコミットが無い場合と、push していないコミットを 1 つ足した場合で、2 回通す。

```bash
pecot pr restack
```

| 場面 | 期待 |
|---|---|
| (a) 手元に足したコミットが無い | `updated: <branch> synced with origin/<branch>`。push しない（PR の CI が動き直さない） |
| (b) push していないコミットを 1 つ足した | `updated: <branch> restacked on <開発ブランチ>`。`--force-with-lease` で push する |

| 見るもの | 期待 |
|---|---|
| PR の差分 | Phase 2 の変更だけ |
| `session status` | `## Stack` の節が出ない |

merge queue の規則は、ここで戻す。`pecot-sandbox` の main の ruleset（id 27130266）に規則を足し直す。
merge queue のあるブランチでも 1 回通す。`pecot pr merge` が `added: ... to merge queue` を出し、キューを通ってマージされることを見る。
その後も `pecot pr restack` を続け、キューを通った後の載せ直しを見る。GitHub は、キュー経由でも上の段を載せ直す。

## 7. 前提と種類を直す（US7・US9）

```bash
pecot issue block <Phase 3> --by <Phase 2> --wait merge --reason "確認に main の版が要る"
pecot issue read <Phase 3>
pecot issue block <Phase 3> --by <Phase 2>
pecot issue unblock <Phase 3> --by <Phase 2>
pecot issue block <Phase 1> --by <Phase 3>      # 輪
```

| 見るもの | 期待 |
|---|---|
| 1 行目の後 | 本文に `## Waits for merge` と理由が付く。判定が `blocked` になる |
| 3 行目の後 | 本文の節が消える。判定が計算し直される |
| 4 行目の後 | GitHub の画面から blocked by が消える。Phase 3 が `Ready` に移る |
| 5 行目 | 終了コード 2。輪になる Issue の並びが出る |
| `issue block <Phase 2> --by <Phase 2>` | 終了コード 2。GitHub の文ではなく、pecot の文が出る |
| 同じコマンドの 2 回目 | `unchanged:` が出る |

## 8. 誤操作を直す（US2、Actions のフェーズで確かめる）

列を直すのは GitHub Actions のワークフローで、`pecot project info` は直さない。ここは tasks.md の Phase 13 が入ってから通す。

ボードの画面で、`Blocked` のカードを `Ready` と `Active` へ、`Ready` のカードを `Blocked` へ、手で動かす。別の `Blocked` のカードを `Pending` へ動かす。

ワークフローを動かす（`schedule` の実行を待つか、手で起動する）。

| 見るもの | 期待 |
|---|---|
| ワークフローのログ | 動かしたカードごとに `moved:` の行が出る。元の列・新しい列・理由が読める |
| ボード | 3 枚が判定に合った列に戻る |
| `pecot project info` | 列は動かない。判定だけが出る |
| `Pending` へ動かしたカード | 動かない。それを前提にしている Issue の理由に、前提が `Pending` にある旨が出る |

着手済みの Issue（worktree B の Phase 2）に、別の作業ディレクトリから前提を足す。

```bash
pecot issue block <Phase 2> --by <Phase 4>
```

| 見るもの | 期待 |
|---|---|
| Phase 2 の列と札 | 変わらない |
| `issue block` の stderr | `warning:` に、着手済みの Issue がブロック中である旨が出る |
| worktree B の `pecot session status` | `## Stack` の節に、判定の食い違いが出る |

## 9. マージされずに閉じた前提（US2。判定は一覧のフェーズ、札は Actions のフェーズで確かめる）

Phase 4 の Issue を、PR をマージせずに画面で閉じる。札を `Needs Attention` にするのは、ワークフローだ。

```bash
pecot project info
pecot issue unblock <Phase 5> --by <Phase 4>
```

| 見るもの | 期待 |
|---|---|
| Phase 5 の判定 | `blocked by #<Phase 4> (closed without merge: #<Phase 4>)`。`issue read` の `**Readiness:**` にも同じ文が出る |
| Phase 5 の札 | ワークフローが動いた後に `Needs Attention` |
| `unblock` の後 | 札が `Todo` に戻り、列が判定に合わせて動く |

## 10. 値の無いボードと、前提の無いリポ

| 手順 | 期待 |
|---|---|
| ボードから `Blocked` の値を消して `pecot project info` を打つ | 一覧と判定は出る。列は動かない。終了コードは 0 |
| 前提の付いていない Issue だけのリポで、着手から片付けまでを通す | 出力と列の動きが、この機能の前と変わらない |
| `gh stack` 拡張を外した環境で、3 の手順を通す | 拡張を求めずに、スタックとして登録される |
| エージェントに `gh stack submit` を打たせる | hook が止め、pecot のコマンドを案内する |

## 11. スキルの通し

このリポで、前提の表を持つ Epic を 1 つ使い、スキルだけで通す。

1. `/pecot-w:w-breakdown` で tasks.md を作り、4 列の表があることを見る
2. `/pecot-w:w-issueize` で Issue を作る。利用者へ示す表が、進め方の列を持つことを見る
3. `/pecot-w:w-active` で、`Ready` の Issue から 2 段を続けて着手する。エージェントが base を選ばないことを見る
4. `/pecot-w:w-pr`・`/pecot-w:w-revise`・`/pecot-w:w-merge` を、下の段から通す
5. マージの後、次に着手できる Issue がエージェントの報告に出ることを見る

## 自動のテスト

変更箇所に絞って動かす。全量は CI に任せる。

```bash
cd plugins/pecot-workflow/cli
pnpm vitest run src/domain/tests/readiness.test.ts
pnpm vitest run src/domain/tests/board-move.test.ts
pnpm vitest run tests/interface/issue.test.ts -t "issue block"
```

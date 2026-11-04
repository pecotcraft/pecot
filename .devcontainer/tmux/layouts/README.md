# tmux レイアウト定義

`pecot-open.sh` / `pecot-open-mobile.sh` の `--layout <name>` で参照されるレイアウト定義ディレクトリ。

## ファイルフォーマット

1 ファイル 1 レイアウトとし、拡張子は `.conf`、中身は bash として `source` される。形は次のとおり。

```bash
TITLE="--list-layouts に出す説明"
REPOS=(wt1:pecot wt2:pecot)
```

- `REPOS` 配列の長さ = ペイン数（1〜4）。
- 5 ペイン以上は未サポート。
- 各エントリは `<repo>` または `<variant>:<repo>` 形式を取れる。
  - `<repo>` のみ: `-v` で指定した variant（省略時は `base`）が使われる。
  - `<variant>:<repo>`: エントリ単位で variant を切り替える（別 worktree の同リポを並列に開けるなど）。
- 同じ `(variant, repo)` の組を複数回入れた場合の扱いは次のとおり。`pecot-open.sh` では同一 worktree を別ペインで、`pecot-open-mobile.sh` ではセッション名に `-2`, `-3`... 連番が付く。

例:

```bash
# wt1-wt4 の pecot を 4 ペインで同時に開く（並列作業セット）
REPOS=(wt1:pecot wt2:pecot wt3:pecot wt4:pecot)
```

## ペイン幾何（`pecot-open.sh`）

| ペイン数 | 幾何 |
|---|---|
| 1 | 単一ペイン |
| 2 | 左右 2 分割 |
| 3 | 左 1 + 右を上下 2 分割 |
| 4 | 2x2 |

## セッション名（`pecot-open.sh`）

常に `pecot-<variant>-<layout>` をデフォルトセッション名として使う。

| variant | layout    | session                |
|---------|-----------|------------------------|
| base    | default   | `pecot-base-default`   |
| base    | parallel4 | `pecot-base-parallel4` |
| wt1     | default   | `pecot-wt1-default`    |
| wt1     | parallel4 | `pecot-wt1-parallel4`  |

positional `session-name` を明示指定した場合はそれが最優先され、variant/layout は
セッション名に混入しない。layout が異なれば別セッションとなるため、同 variant でも
layout 違いを並行起動できる。

## セッション名（`pecot-open-mobile.sh`）

エントリごとに独立セッションを作る。セッション名は常に
`pecot-<variant>-<layout>:<entry_variant>-<repo>[-<N>]`。

- `<entry_variant>` は REPOS エントリの `<variant>:<repo>` の variant 部分。省略時は
  `-v` で指定した値（デフォルト `base`）。
- `<N>` は同一 layout 内で同じ `(entry_variant, repo)` の組が複数回登場したときの
  `-2`, `-3`... 連番で、**layout スコープ内でのみユニーク**。
- layout が異なれば別プレフィックスになるため、layout 並行起動が可能
  （`pecot-base-default:*` と `pecot-base-parallel4:*` が併存する）。

例:

| variant | layout    | セッション例                                                            |
|---------|-----------|-------------------------------------------------------------------------|
| base    | default   | `pecot-base-default:base-pecot`                                         |
| base    | parallel4 | `pecot-base-parallel4:wt1-pecot`, ..., `pecot-base-parallel4:wt4-pecot` |

## 入力バリデーション

`--variant` / `--layout` に使える文字は `^[A-Za-z0-9_-]+$` に限定。`.`, `:`,
空白などを含めると usage を出して exit 1 する。

## 自作レイアウト追加

このディレクトリに `my.conf` を置くだけで `./pecot-open.sh --layout my` から参照可能。

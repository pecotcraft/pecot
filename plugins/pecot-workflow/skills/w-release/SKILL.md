---
name: w-release
description: |
  リリースを実行するスキル。CHANGELOG を更新し、ブランチモードに応じて
  develop → release の PR を作成・merge（2ブランチ）するか、main 上で直接リリース（単一ブランチ / trunk-based）する。
  Use when the user wants to release current development work.
  Do NOT use for regular feature PR merges (use w-merge) or feature PR creation (use w-pr).
when_to_use: "リリースしたい、CHANGELOG を更新して公開したい、バージョンを上げたい"
---

# リリース

CHANGELOG を更新してリリースする。
ブランチモードが 2ブランチなら、develop ブランチから release ブランチへ PR を出して merge する。
単一ブランチ / trunk-based なら、`main` 上で直接リリースする。

## 手順

1. **対象リポの release_type を確認する**

   `board_show` を引数なしで呼ぶ。

   結果の `stdout` の対象リポ行の直下にある `release_type: <...>` を読む:

   - `release_type: single` → **[references/release-single.md](references/release-single.md)** に従う
   - `release_type: multi`  → **[references/release-multi.md](references/release-multi.md)** に従う
   - `release_type: nx`     → **[references/release-nx.md](references/release-nx.md)** に従う

   併せて **ブランチモード** も同じ `stdout` から読む:

   - 対象リポ行の `develop:` と `release:` が異なる → **2ブランチモード**（開発ブランチ → release ブランチへ PR で反映）。
     例は `develop: develop-aist` と `release: main`。
   - 対象リポ行の `develop:` と `release:` が同じ（pecot は両方 `main`）→
     **単一ブランチモード**（`main` 上で直接リリース、中間 PR なし）

   この分岐は、`develop:` と `release:` の両方が出る前提で成り立つ。
   `release_type: nx` のリポは `release_branch` が必ず設定され、`release:` 行が出る。
   `release:` が出ないリポは nx 方式の対象外なので、`release_type` のリファレンス手順にそのまま従う。

   判定したブランチモードを、選んだリファレンス側の手順に渡す。
   `release_type: nx` の単一ブランチモードには、`release.yml` があるリポ向けのランナーの手順がある。

2. **判定結果のリファレンスに従って手順を実行する**

   リファレンス内でブランチモードによる分岐がある場合は、Step 1 で読んだブランチモードの節に従う。
   分岐があるのは、`release_type: nx` の release-nx.md である。

## release_type 未設定のリポへの対応

`release_type` は `project_link` を `repo: "<owner>/<repo>"`・`release_type: "<type>"` で呼んで明示設定する。
未設定の場合は `packages` の有無から自動推測される（有り → `multi`、無し → `single`）。
Nx Release 方式 (`nx`) は必ず明示設定が必要。

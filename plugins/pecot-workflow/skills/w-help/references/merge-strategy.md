# マージ方法の使い分け

ブランチモードによって対象が変わる。リポのブランチモードは `board_show` の
結果の `stdout` の対象リポ行で判定する（`develop:` と `release:` が異なれば2ブランチ、同じ（両方 `main`）なら単一ブランチ）。

## 2ブランチモード（develop ≠ release）

| マージ対象 | method | コマンド・ツール | 理由 |
|-----------|--------|---------|------|
| feature → develop ブランチ | squash | `gh pr merge --squash`（片付けは `session_finish`） | コミット履歴を整理 |
| develop ブランチ → release ブランチ | merge | `release_merge` | merge-base 追跡を維持 |

squash merge を使うと git の merge-base が正しく更新されず、差分が正しく表示されない。
develop → release は regular merge を使い、merge-base を維持する。

## 単一ブランチモード（develop == release / trunk-based）

| マージ対象 | method | コマンド | 理由 |
|-----------|--------|---------|------|
| feature → main | squash | `gh pr merge --squash`（片付けは `session_finish`） | コミット履歴を整理 |

単一ブランチモードには `develop → main` の中間 PR が存在しない。
リリースは `main` 上で直接行う。
`release_type: nx` なら、`$NX release` を `main` 上で実行する。
`$NX` は pnpm のリポなら `pnpm exec nx`、それ以外は `npx nx`。
詳細は w-release の [release-nx.md 単一ブランチモード節](../../w-release/references/release-nx.md#単一ブランチモードdevelop--release)。
そのため `release merge` を使う develop → main のマージは発生しない。

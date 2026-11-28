# マージ方法の使い分け

ブランチモードによって対象が変わる。リポのブランチモードは、pecot-workflow の MCP ツール `project_get` を `key` を省いて呼んだ結果で判定する。
`repositories` のうち対象リポの要素で、`develop_branch` と `release_branch` を比べる。
異なれば2ブランチ、同じ（両方 `main`）なら単一ブランチになる。
表の `session_finish` は pecot-workflow の MCP ツール、`merge_pull_request` は GitHub の公式の MCP のツールの名前。feature PR のマージは GitHub の画面で行う。

## 2ブランチモード（develop ≠ release）

| マージ対象 | method | コマンド・ツール | 理由 |
|-----------|--------|---------|------|
| feature → develop ブランチ | squash | GitHub の画面でのマージ（片付けは w-pr の待ち受けが `session_finish` で行う） | コミット履歴を整理 |
| develop ブランチ → release ブランチ | merge | `pr_check`（`merge`）に通してから `merge_pull_request`（w-release） | merge-base 追跡を維持 |

squash merge を使うと git の merge-base が正しく更新されず、差分が正しく表示されない。
develop → release は regular merge を使い、merge-base を維持する。

## 単一ブランチモード（develop == release / trunk-based）

| マージ対象 | method | コマンド | 理由 |
|-----------|--------|---------|------|
| feature → main | squash | GitHub の画面でのマージ（片付けは w-pr の待ち受けが `session_finish` で行う） | コミット履歴を整理 |

単一ブランチモードには `develop → main` の中間 PR が存在しない。
リリースは `main` 上で直接行う。
`release_type: nx` なら、`$NX release` を `main` 上で実行する。
`$NX` は pnpm のリポなら `pnpm exec nx`、それ以外は `npx nx`。
詳細は w-release の [release-nx.md 単一ブランチモード節](../../w-release/references/release-nx.md#単一ブランチモードdevelop--release)。
そのため `release merge` を使う develop → main のマージは発生しない。

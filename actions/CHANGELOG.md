## 1.1.0 (2026-11-27)

### 🚀 Features

- MCP のサーバを npm の `@pecot/workflow-mcp` から npx で起動するようにし、`bin/` と `pecot` の CLI をなくした。 ([#862](https://github.com/pecotcraft/pecot/pull/862), [#794](https://github.com/pecotcraft/pecot/issues/794))
  release check の判定を workflow-core に移し、同じ判定の `release-check` の action を足した。

- Issue とコメントを公式の GitHub MCP で書く形にし、pecot-workflow は書く前に通すチェックのツールだけを持つ。 ([#891](https://github.com/pecotcraft/pecot/pull/891), [#797](https://github.com/pecotcraft/pecot/issues/797))
  Issue を読み書きする 8 つのツールをなくし、テンプレートの frontmatter を公式のツールの引数の名前にした。
  自動処理の雛形は公式の MCP サーバを Docker で起動するので、`workflow_install` で入れ直す。

- 公式の GitHub の MCP に手の無い操作を 1 つずつ行う `github-ops` の action と、雛形 `pecot-github-ops.yml` を足した。 ([#861](https://github.com/pecotcraft/pecot/pull/861), [#793](https://github.com/pecotcraft/pecot/issues/793))
  `workflow_install` と `workflow_doctor` が、この雛形も扱う。


### 🩹 Fixes

- 開発用のテストの **Allure の結果** に、重大度（severity）を付けた。プラグインとライブラリの動作は変わらない。 ([#869](https://github.com/pecotcraft/pecot/pull/869), [#812](https://github.com/pecotcraft/pecot/issues/812))
- 開発用のテストの **Allure の結果** に、テストの層（unit・integration・e2e）を付けた。プラグインとライブラリの動作は変わらない。 ([#870](https://github.com/pecotcraft/pecot/pull/870), [#813](https://github.com/pecotcraft/pecot/issues/813))
- 開発用の依存（**nx 24.0.7・typescript-eslint 8.74.0・vitest 5.1.2** など）を更新した。プラグインとライブラリの動作は変わらない。 ([#856](https://github.com/pecotcraft/pecot/pull/856), [#854](https://github.com/pecotcraft/pecot/issues/854))
- `pecot-review.yml` の雛形のコメントに残っていた CLI のコマンドを、`workflow_install` の案内に直した。 ([#888](https://github.com/pecotcraft/pecot/pull/888), [#866](https://github.com/pecotcraft/pecot/issues/866))
  あわせて、#794 で中身を変えた auto・board-sync の雛形も版を上げた。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 1.0.0 (2026-11-27)

### ⚠️  Breaking Changes

- Actions だけで動く処理を、ワークフローが `uses:` で呼ぶ pecot の action（`actions/`）に移した。 ([#845](https://github.com/pecotcraft/pecot/pull/845), [#792](https://github.com/pecotcraft/pecot/issues/792))
  MCP から `board_sync` など 6 つのツールを消し、雛形は npx の代わりに action を SHA で固定して呼ぶ。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

<!-- この行は初回リリース前に必要。nx release は先頭へ追記する -->

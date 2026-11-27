## 0.3.0 (2026-11-27)

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

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.0 (2026-11-27)

### 🚀 Features

- Actions だけで動く処理を、ワークフローが `uses:` で呼ぶ pecot の action（`actions/`）に移した。 ([#845](https://github.com/pecotcraft/pecot/pull/845), [#792](https://github.com/pecotcraft/pecot/issues/792))
  MCP から `board_sync` など 6 つのツールを消し、雛形は npx の代わりに action を SHA で固定して呼ぶ。


### 🩹 Fixes

- 開発用のテストの **Allure の結果** に、機能の階層（epic・feature・story）を付けた。プラグインとライブラリの動作は変わらない。 ([#848](https://github.com/pecotcraft/pecot/pull/848), [#811](https://github.com/pecotcraft/pecot/issues/811))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.1.0 (2026-11-27)

### 🚀 Features

- pecot-workflow と GitHub Actions の処理が共有するコードを、`libs/workflow-core` に移した。プラグインの動作は変わらない。 ([#819](https://github.com/pecotcraft/pecot/pull/819), [#791](https://github.com/pecotcraft/pecot/issues/791))

### 🩹 Fixes

- 開発用のテストが、テストレポートに **何を確認したかの説明** を残す。プラグインの動作は変わらない。 ([#842](https://github.com/pecotcraft/pecot/pull/842), [#815](https://github.com/pecotcraft/pecot/issues/815))
- 開発用のテストが、判定で使った **CLI・MCP・hook の出力** を Allure の添付として残す。プラグインの動作は変わらない。 ([#831](https://github.com/pecotcraft/pecot/pull/831), [#816](https://github.com/pecotcraft/pecot/issues/816))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

<!-- この行は初回リリース前に必要。nx release は先頭へ追記する -->

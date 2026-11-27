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

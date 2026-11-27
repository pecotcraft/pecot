# 1.0.0 (2026-11-27)

### ⚠️  Breaking Changes

- Actions だけで動く処理を、ワークフローが `uses:` で呼ぶ pecot の action（`actions/`）に移した。 ([#845](https://github.com/pecotcraft/pecot/pull/845), [#792](https://github.com/pecotcraft/pecot/issues/792))
  MCP から `board_sync` など 6 つのツールを消し、雛形は npx の代わりに action を SHA で固定して呼ぶ。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

<!-- この行は初回リリース前に必要。nx release は先頭へ追記する -->

---
actions: major
pecot-workflow: major
workflow-core: minor
---

Actions だけで動く処理を、ワークフローが `uses:` で呼ぶ pecot の action（`actions/`）に移した。
MCP から `board_sync` など 6 つのツールを消し、雛形は npx の代わりに action を SHA で固定して呼ぶ。

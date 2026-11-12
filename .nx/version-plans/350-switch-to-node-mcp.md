---
pecot-workflow: major
---

`pecot` の CLI が Node（`^24.22.1` か `>=26.12.1`）で動き、スキルは MCP ツールを呼ぶ。Python と uv は要らない。
エージェントの Bash の `pecot` は hooks が deny する（設定のキー `pecot-cli-deny`）。
GitHub Copilot CLI は 1.0.106 以降が要る。

---
pecot-visual: patch
pecot-tools: patch
---

MCP ツールの出力の型を、ツールごとの**閉じた型**にした。
pecot-tools は、宣言に無い AWS のキーを外して `warnings` で知らせる。
`runtime_setup` は、失敗のときに `reason` を返さない。

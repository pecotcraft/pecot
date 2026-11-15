---
pecot-workflow: minor
---

`pecot pr merge`（`pr_merge`）で、**単独の PR とスタックの最下段の PR をマージできる**。
`session finish` は、待っていた Issue の判定の変化と、上の段の載せ直しの案内を出す。
hook は `gh stack` を止め、`pr_merge` を確認にかける。

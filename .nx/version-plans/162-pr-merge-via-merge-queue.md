---
pecot-workflow: major
---

`pecot pr merge` を廃止し、マージ後の片付けを `pecot pr cleanup` に分けた。
マージは `gh pr merge` で行い、merge queue のあるリポでも w-merge が queue のマージを待ってから片付ける。

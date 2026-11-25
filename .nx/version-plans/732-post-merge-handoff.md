---
pecot-workflow: minor
---

マージ後の Epic・後続へのコメントは、新しい雛形 `pecot-handoff.yml` が Actions で書き、セッションは書きません。
`pecot-board-sync.yml` は、マージで閉じた PR の Issue を閉じ、head ブランチを消してからボードを直します。

---
pecot-workflow: minor
---

w-breakdown が、分解の作業を Epic の下のタスクとして起票し、そのタスクのブランチで speckit を進めるようになりました。
speckit の git 拡張に `NNN-<名前>` のブランチを作らせず、成果物はタスクを閉じる PR で開発ブランチに入ります。

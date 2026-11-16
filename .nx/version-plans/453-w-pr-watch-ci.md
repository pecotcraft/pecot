---
pecot-workflow: minor
---

w-pr が PR を作った後に `gh pr checks --watch` で CI を待ち、落ちたら直すようになった。
w-merge も同じ待ち方にそろえ、`merge-wait.sh` を削除した。

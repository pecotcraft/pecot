---
pecot-workflow: patch
---

auto-push は、active な Issue のブランチだけを wip/ へ push する。
push の後で wip/ の追跡 ref を消すので、最初の push でも pre-push の hook が動く。
